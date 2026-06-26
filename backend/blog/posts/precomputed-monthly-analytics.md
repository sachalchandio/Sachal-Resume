---
title: "Precomputing monthly sale-status analytics with a refresh lock"
description: "Scanning sale_stage on every dashboard load didn't scale. A snapshot table, a grouped query, and a Bull/Redis refresh."
date: "2025-09-19"
updated: "2025-09-19"
kind: "deepdive"
category: "Performance"
tags: ["mysql", "aggregation", "bull", "redis"]
month: "2025-09"
repo: "backend"
author: "Sachal Chandio"
---

The status dashboard opens with a grid: months down the side, sale providers across the top, and in every cell a stack of counts — sold, cancelled, chargeback, disputed, on-hold, pending-install, activated, complete, unassigned. Nine numbers per cell. Two dozen providers. Every month the company has been operating. Someone loads that page a few dozen times a day and never thinks about what it costs.

What it cost was a full scan of `sale_stage` per page load. `sale_stage` is the table every provider writes a row to when a sale changes state — it's the busiest table we have, well into the millions of rows, and it only grows. The dashboard was asking it to bucket all of those rows by year, month, sale type, and stage, on demand, while the user stared at a spinner. The query plan was a `GROUP BY` over the whole table with no chance of stopping early. On a small dev database it returned in 80ms and looked completely fine. Against the production RDS instance it was several seconds, and it got slower every week by exactly the amount the business grew.

## The thing I tried not to build

My first instinct was to not add a table. Adding a table means a migration, a refresh story, a staleness window, and a new way for two numbers on the same screen to disagree. The honest first move is to see how far the existing table gets you with an index, because an index is reversible and a snapshot table is a small commitment you carry forever.

So I indexed for it. The dashboard query filters and groups by `saleType`, `createdAt`, and `stage`, so I added a composite covering exactly that:

```ts
@Index('IDX_sale_stage_saleType_createdAt_stage_analytics', ['saleType', 'createdAt', 'stage'])
```

That helped the *filtered* views — pick one provider and one month and MySQL can range-scan a slice. But the default dashboard view is all providers, all months, all time. There's no slice. You're aggregating the entire history of the table on every load, and no index makes "read every row and bucket it" fast. The index lowered the floor; it didn't change the shape of the problem. The shape of the problem was that I was recomputing a number that almost never changes — last March's chargeback count for Spectrum is not going to move — on every single request.

That's the tell that you want a materialized result. The data is append-heavy and read-many. Historical buckets are effectively frozen; only the current month is churning. Recomputing all of history to answer a question about a fixed past is the waste.

## The snapshot table

So I gave in and built the table. One row per `(year, month, saleType)`, with the nine stage counts denormalized into columns plus two precomputed totals, and a unique index on the natural key so the refresh can upsert:

```ts
@Entity('sale_status_monthly_analytics')
@Index(['year', 'month', 'saleType'], { unique: true })
@Index(['year', 'month'])
@Index(['saleType'])
export class SaleStatusMonthlyAnalytics {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ type: 'int' }) year: number;
  @Column({ type: 'int' }) month: number;
  @Column({ type: 'enum', enum: SaleType }) saleType: SaleType;

  @Column({ type: 'int', default: 0 }) soldCount: number;
  @Column({ type: 'int', default: 0 }) cancelledCount: number;
  @Column({ type: 'int', default: 0 }) chargebackCount: number;
  // ...disputed, onHold, pendingInstall, activated, complete, unassigned

  @Column({ type: 'int', default: 0 }) totalSales: number;
  @Column({ type: 'int', default: 0 }) totalActiveSales: number; // excludes cancelled + chargeback

  @Column({ type: 'datetime' }) computedAt: Date;
}
```

The dashboard query now reads from this table instead of `sale_stage`. The grid is maybe a few thousand rows at the very most — one per month per provider since the beginning — and they come back ordered by year and month descending with no aggregation at read time at all. Sub-100ms against production, and flat. It doesn't get slower as `sale_stage` grows, because it isn't looking at `sale_stage` anymore.

I considered a MySQL view or letting the ORM keep a running tally on every write. The view doesn't help — a view over an aggregate is still the aggregate, it just hides it. And incrementing counters on write sounds elegant until you remember sales get edited, re-staged, and corrected; keeping a running count consistent under updates and the occasional manual fix is its own class of bug, the kind where the cached number drifts a little every week and nobody notices until it's badly wrong. A full recompute on a schedule is dumber and I trust it more. When in doubt, recompute the whole thing from the source of truth; it's the version that can't silently rot.

## One query does the whole thing

The recompute is a single grouped query. Instead of nine round trips (one count per stage) or a loop, I fan all nine counts out in one pass with a `SUM(CASE WHEN ...)` per stage — the standard trick for pivoting rows into columns in MySQL:

```ts
const aggregatedRows = await this.saleStageRepository
  .createQueryBuilder('ss')
  .select('YEAR(ss.createdAt)', 'year')
  .addSelect('MONTH(ss.createdAt)', 'month')
  .addSelect('ss.saleType', 'saleType')
  .addSelect(`SUM(CASE WHEN ss.stage = :soldStage THEN 1 ELSE 0 END)`, 'soldCount')
  .addSelect(`SUM(CASE WHEN ss.stage = :cancelledStage THEN 1 ELSE 0 END)`, 'cancelledCount')
  .addSelect(`SUM(CASE WHEN ss.stage = :chargebackStage THEN 1 ELSE 0 END)`, 'chargebackCount')
  // ...disputed, onHold, pendingInstall, activated, complete, unassigned
  .where('ss.saleType NOT IN (:...excludedSaleTypes)', {
    excludedSaleTypes: this.EXCLUDED_SALE_TYPES, // TIDIO_LEADS, CALL_LOG — not real sales
  })
  .setParameters({ soldStage: SaleFlag.SOLD, cancelledStage: SaleFlag.CANCELLED, /* ... */ })
  .groupBy('YEAR(ss.createdAt)')
  .addGroupBy('MONTH(ss.createdAt)')
  .addGroupBy('ss.saleType')
  .getRawMany();
```

That one statement reads `sale_stage` end to end exactly once and emits the entire grid. Yes, it's the same full scan the dashboard used to do live — but now it runs on a background worker, on a schedule, where nobody is watching a spinner, instead of on the request path where every second is a person waiting. The expensive work didn't disappear. It moved off the hot path. That's the whole game: you almost never make the slow thing fast, you make it happen somewhere nobody is waiting.

I derive `totalActiveSales` as `totalSales - cancelledCount - chargebackCount` in JS while mapping the rows, then upsert each chunk on the natural key so a refresh updates existing months in place rather than duplicating them:

```ts
await this.analyticsRepository
  .createQueryBuilder()
  .insert()
  .into(SaleStatusMonthlyAnalytics)
  .values(chunk)
  .orUpdate(
    ['soldCount', 'cancelledCount', /* ...the rest... */, 'totalActiveSales', 'computedAt'],
    ['year', 'month', 'saleType'], // conflict target = the unique index
  )
  .execute();
```

## Don't let two refreshes run at once

The refresh recomputes everything, so two of them racing is pure waste at best and a write conflict at worst. A button on the dashboard triggers it; so does a schedule; a double-click shouldn't double the work. I gate the whole thing behind a Redis lock with `SET key value NX EX` — set-if-not-exists with an expiry — so acquisition is atomic and the lock can't outlive a crashed worker:

```ts
async triggerRefresh(requestedBy?: string, forceRefresh = false) {
  if (await this.isRefreshRunning()) {
    return { success: false, message: 'Refresh is already in progress.' };
  }

  const lockAcquired = await this.cacheService.setNxEx(
    this.REDIS_LOCK_KEY,                  // 'lock:sale-status-analytics-refresh'
    JSON.stringify({ requestedBy, startedAt: new Date().toISOString() }),
    this.REDIS_LOCK_TTL,                  // 300s — longer than any refresh should take
  );
  if (!lockAcquired) {
    return { success: false, message: 'Refresh is already in progress.' };
  }

  const job = await this.refreshQueue.add('refresh-analytics',
    { forceRefresh, requestedBy },
    { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true },
  );
  // ...
}
```

The actual compute runs in a Bull processor with `concurrency: 1`, and it double-checks the lock still exists before doing any work — if the lock vanished mid-flight, something is wrong and it bails rather than risk a duplicate run. The lock gets released in the processor's `@OnQueueCompleted` and `@OnQueueFailed` hooks, and the 300-second TTL is the backstop for the case those hooks never fire because the worker died. Belt, suspenders, and a timer.

## Making `isRefreshing` tell the truth

Here's the bug I'd have shipped if I'd been lazy, and it's the part of this I'm actually proud of catching. The dashboard shows a little "refreshing…" indicator while a recompute is in flight, driven by an `isRefreshing` flag on the response. The obvious implementation is to check whether the lock exists. Done, right?

No. There's a gap between "job has been added to the queue" and "worker has picked it up and acquired the lock." In that window — queued but not yet running — the lock might not be set, yet a refresh absolutely is coming. Check only the lock and the indicator flickers off, the user thinks it's done, they reload, and they're looking at stale numbers with a confident green checkmark. The flag lied during the most likely moment for someone to be watching: right after they clicked the button.

So `isRefreshing` checks both sides — the lock *and* whether the Bull queue has a `refresh-analytics` job sitting in `active`, `waiting`, or `delayed`:

```ts
private async isRefreshRunning(): Promise<boolean> {
  const [lockExists, jobs] = await Promise.all([
    this.cacheService.exists(this.REDIS_LOCK_KEY),
    this.refreshQueue.getJobs(['active', 'waiting', 'delayed']),
  ]);

  const hasRefreshJobInQueue = jobs.some((job) => job.name === 'refresh-analytics');
  return lockExists > 0 || hasRefreshJobInQueue;
}
```

`true` if either is true. The lock covers "a worker is mid-computation"; the queue check covers "a refresh is queued but hasn't started." Together they cover the whole lifecycle, including the awkward handoff in the middle. The flag is honest now, and honest is the only thing a status indicator is for.

## What I traded away

The number on the screen can be stale, by design. If you load the dashboard between refreshes, the current month is as fresh as the last recompute, not as fresh as the last sale. For a historical analytics grid that's exactly the right trade — nobody makes a decision off whether this month's "complete" count is current to the minute — but it would be the wrong trade for anything operational, like a live floor board where a stale number is a wrong number. Match the staleness window to how the data gets used; precomputation is great until someone needs to-the-second truth, and then it's a trap.

The other cost is that I now own a refresh story forever. There's a table that can drift from its source if the job stops running, so the job not running is now an incident, not a non-event. I kept a `forceRefresh` path that clears the table and rebuilds from scratch for exactly the day the upserts and reality disagree and I need to reset to the source of truth. And `computedAt` rides along on every row so the dashboard can show "last refreshed" and nobody has to guess how old the numbers are. If you precompute, surface the timestamp. A fast number with no provenance is just a confident way to be wrong, and the cheapest way to keep trust is to tell people exactly how stale the thing they're looking at might be.
