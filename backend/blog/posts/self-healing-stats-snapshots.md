---
title: "Self-healing analytics: snapshot tables and a revenue cursor"
description: "Recomputing dashboards from scratch every time doesn't scale. Accumulating into snapshots that repair their own drift."
date: "2025-09-17"
updated: "2025-09-17"
kind: "deepdive"
category: "Real-time"
tags: ["graphql", "analytics", "nestjs"]
month: "2025-09"
repo: "backend"
author: "Sachal Chandio"
---

The team dashboard had a query that walked the entire `sales` table on every page load. Sum the revenue, count the closes, group by agent, group by day. Fine when we had a few thousand rows. By the time we crossed 400k it was a 2–3 second wait every time a manager opened the screen, and the screen polled. So the same `SUM(amount)` ran again every fifteen seconds for every person staring at it. MySQL was doing the same arithmetic thousands of times an hour to produce a number that barely moved.

The fix is obvious in hindsight: stop recomputing what you already computed. Keep a running total. The interesting part is what happens when the running total is wrong, because eventually it always is.

## Why not just cache the query

The first thing I tried was the lazy thing. Wrap the aggregate in a Redis cache with a 60-second TTL. It worked for about a day. The problem is a TTL cache doesn't accumulate — when it expires you pay the full table scan again, you've just moved the 3-second hit from "every request" to "every 60 seconds, whoever's unlucky." And telecom sales come in spikes. End of month, the whole floor is closing deals, the cache is constantly cold, and the one request that has to rebuild it blocks behind a slow scan exactly when everyone's watching.

What I actually wanted was a number that goes up when a sale closes and never gets recomputed from scratch under normal operation. That's a snapshot table plus a cursor.

## The shape of the snapshot

I added a `stats_snapshot` table keyed by the dimensions we slice on — team, agent, and the day bucket — with the aggregates stored as columns rather than derived.

```sql
CREATE TABLE stats_snapshot (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  team_id       INT NOT NULL,
  agent_id      INT NULL,
  day_bucket    DATE NOT NULL,
  sales_count   INT NOT NULL DEFAULT 0,
  revenue_cents BIGINT NOT NULL DEFAULT 0,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_snapshot (team_id, agent_id, day_bucket)
);
```

Two decisions there I'd defend. Revenue is in `revenue_cents` as a `BIGINT`, not a `DECIMAL` of dollars — I never want floating point anywhere near money accumulating over hundreds of thousands of rows, and integer addition is exact and fast. And the `UNIQUE KEY` on the dimension tuple is what makes the upsert atomic; I lean on `INSERT ... ON DUPLICATE KEY UPDATE` so two concurrent sales hitting the same bucket can't lose a write.

Then a single-row `revenue_cursor` table that remembers how far we've consumed:

```sql
CREATE TABLE revenue_cursor (
  id            TINYINT PRIMARY KEY DEFAULT 1,
  last_sale_id  BIGINT NOT NULL DEFAULT 0,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP
);
```

The cursor is just the highest `sale.id` we've already folded into the snapshot. Sales get an auto-increment id and are append-only once they're in a final state, so "everything with `id > last_sale_id`" is the set of work I haven't done yet. Cheap to ask, cheap to advance.

## Folding new sales in

A BullMQ worker drains the backlog. It reads the cursor, pulls the next chunk of sales above it, and applies them to the snapshot in one transaction so the snapshot and the cursor move together or not at all. The transaction boundary is the whole point — if the process dies mid-batch, the cursor never advanced past sales we didn't actually fold, so on restart we just redo that chunk. No double-counting, no gap.

```ts
async function foldBatch(): Promise<number> {
  return this.dataSource.transaction(async (manager) => {
    const cursor = await manager.findOneByOrFail(RevenueCursor, { id: 1 });

    const sales = await manager.find(Sale, {
      where: { id: MoreThan(cursor.lastSaleId), status: SaleStatus.CLOSED },
      order: { id: 'ASC' },
      take: 500,
    });
    if (sales.length === 0) return 0;

    for (const sale of sales) {
      await manager.query(
        `INSERT INTO stats_snapshot
           (team_id, agent_id, day_bucket, sales_count, revenue_cents)
         VALUES (?, ?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE
           sales_count   = sales_count + 1,
           revenue_cents = revenue_cents + VALUES(revenue_cents)`,
        [sale.teamId, sale.agentId, dayBucket(sale.closedAt), sale.amountCents],
      );
    }

    cursor.lastSaleId = sales[sales.length - 1].id;
    await manager.save(cursor);
    return sales.length;
  });
}
```

The worker loops `foldBatch()` until it returns 0, then sleeps. A new sale enqueues a job that nudges it awake. Steady state, the work per sale is one indexed upsert and a cursor bump. The dashboard query is now `SELECT ... FROM stats_snapshot WHERE team_id = ? AND day_bucket BETWEEN ? AND ?` — a few dozen rows off an index instead of a 400k-row scan. That 2–3 second load dropped under 50ms.

## The part nobody tells you: it will drift

Here's where I got humbled. A snapshot is a denormalized copy, and denormalized copies lie eventually. A sale got its `amount` corrected after it was folded. A refund flipped a sale's status and my fold logic at the time only handled inserts, not reversals. A deploy with a bug double-counted a batch before I caught it. Each of these left the snapshot a few cents or a few rows off from the truth in `sales`, and the truth is whatever a `SUM` over the source table says.

You can't prevent drift entirely. What you can do is detect it and repair it without a human noticing. So I built the snapshot to check itself.

The self-healing pass recomputes the real aggregate for a small, rotating window — say yesterday and today per active team — straight from `sales`, compares it to what the snapshot holds, and if they disagree it overwrites the snapshot row with the recomputed value and logs the delta.

```ts
async function healWindow(teamId: number, day: string): Promise<void> {
  const [truth] = await this.dataSource.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_cents), 0) AS rev
       FROM sales
      WHERE team_id = ? AND DATE(closed_at) = ? AND status = 'CLOSED'`,
    [teamId, day],
  );

  const snap = await this.repo.findOneBy({ teamId, agentId: null, dayBucket: day });
  const drifted =
    !snap ||
    snap.salesCount !== Number(truth.cnt) ||
    snap.revenueCents !== Number(truth.rev);

  if (!drifted) return;

  this.logger.warn(
    `snapshot drift team=${teamId} day=${day} ` +
      `count ${snap?.salesCount ?? 0}->${truth.cnt} ` +
      `rev ${snap?.revenueCents ?? 0}->${truth.rev}`,
  );

  await this.repo.upsert(
    { teamId, agentId: null, dayBucket: day,
      salesCount: Number(truth.cnt), revenueCents: Number(truth.rev) },
    ['teamId', 'agentId', 'dayBucket'],
  );
}
```

Recomputing one day for one team is cheap because `(team_id, closed_at)` is indexed — it's the same scan the original dashboard did, just scoped to a sliver instead of the whole table. Running it on a rotating window every few minutes means today's numbers are never more than a few minutes from self-correcting, and the cost stays flat regardless of total table size. Old days get healed on a slower rotation because they almost never change; when a backdated correction does land, the next sweep catches it.

The drift log turned out to be the most valuable thing I built. Every `snapshot drift` warning is a bug report about my fold logic. The refund-reversal hole, the double-count deploy — I found both because the heal pass screamed about a delta and I went and read why. Drift you repair silently is fine; drift you repair silently and don't log is a time bomb.

## Debug and backfill scripts

Two operational scripts earned their keep. A `stats:debug` command that takes a team and a date range and prints snapshot value, recomputed truth, and the diff side by side — the first thing I run when a manager says "this number looks wrong." Nine times out of ten the snapshot is right and they're comparing two different date ranges, but the script settles it in seconds instead of me writing ad-hoc SQL under pressure.

And a `stats:backfill` that resets the cursor to 0 and folds the entire table from scratch. I needed it the day I added `agent_id` as a dimension — the existing snapshot rows had no agent breakdown, so I truncated `stats_snapshot`, reset the cursor, and let the fold worker rebuild everything. On 400k rows it took a couple of minutes. The nice property is the backfill is just the normal fold path with the cursor rewound, not a separate code path that can rot — same upsert, same transaction, so if folding is correct then backfilling is correct for free.

## Serving it over GraphQL

The dashboard reads snapshots through a normal query.

```ts
@Query(() => [TeamStats])
async teamStats(@Args('teamId') teamId: number,
                @Args('range') range: DateRangeInput) {
  return this.statsService.read(teamId, range);
}
```

The live part is a subscription. When the fold worker writes a snapshot it publishes the changed bucket onto a Redis pub/sub channel, and the GraphQL subscription filters to the team the client cares about. So the dashboard subscribes once and gets pushed the new totals instead of polling a `SUM` every fifteen seconds.

```ts
@Subscription(() => TeamStats, {
  filter: (payload, vars) => payload.statsUpdated.teamId === vars.teamId,
})
statsUpdated(@Args('teamId') teamId: number) {
  return this.pubSub.asyncIterator('statsUpdated');
}
```

Redis as the pub/sub backend matters here because we run more than one backend instance behind the load balancer. The fold worker might be on a different node than the one holding the client's websocket; the in-memory `PubSub` that ships with the examples would only notify clients on the same process. Routing through Redis means whichever node folded the sale, every node's subscribers hear about it.

One sharp edge worth flagging: the subscription pushes the snapshot, and the snapshot can be momentarily wrong before a heal corrects it. For a live revenue ticker that's acceptable — being off by one sale for ninety seconds is invisible to a human watching a number tick up. If you were driving billing or payroll off these numbers you would not read the snapshot; you'd read the source. The snapshot is for eyes, not for accounting.

## What I'd do differently

I'd make the fold logic event-driven from day one instead of cursor-polling new ids. The cursor model only understands "new sales appended" — it's blind to updates and deletes of rows it already passed, which is exactly why drift happened and why I leaned so hard on the heal pass. If I emitted a domain event on every sale state change and folded *deltas* (including negative ones for reversals), the snapshot would stay correct without the heal pass carrying the whole load. The heal pass would become a cheap backstop instead of the primary correctness mechanism.

I'd also store an `agent_id = NULL` rollup row deliberately rather than letting it emerge, because the `NULL` in a unique key is a MySQL footgun — `NULL` isn't equal to `NULL`, so `ON DUPLICATE KEY` doesn't dedupe `NULL` agent rows the way you'd expect, and I lost an afternoon to phantom duplicate rollup rows before I switched the rollup to a sentinel `agent_id = 0`.

The lesson that generalizes past this feature: any derived store will drift, so design the repair path before you ship the store, and log every repair. A snapshot that can't tell you it was wrong is just a faster way to be confidently incorrect.
