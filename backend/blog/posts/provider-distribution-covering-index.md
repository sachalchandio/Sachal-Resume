---
title: "A covering index plus a cache for the provider-distribution query"
description: "Group-by over every sale on each dashboard load is wasteful twice over. Index it, then cache it."
date: "2025-10-05"
updated: "2025-10-05"
kind: "deepdive"
category: "Performance"
tags: ["mysql", "indexes", "caching", "redis"]
month: "2025-10"
repo: "backend"
author: "Sachal Chandio"
---

The dashboard has a donut chart that breaks sales down by provider — AT&T this much, Spectrum that much, Frontier the rest. Innocent enough. Every time a sales manager loaded the page, the backend ran a `GROUP BY providerCode` over the entire `sales` table for that user, counted each bucket, and shipped the result to the chart. On a fresh account that's instant. On an account with 180k rows it was a 600ms full scan, and managers refresh the dashboard the way other people breathe.

I caught it because the slow query log had the same statement in it forty times in five minutes. Same shape, same user, same answer. That's the part that stung: not that the query was slow, but that we were paying for the *exact same result* over and over.

## What the query actually did

The resolver is plain enough. We pull every sale for the user, group by provider, count.

```ts
async providerDistribution(userId: string): Promise<ProviderBucket[]> {
  return this.salesRepo
    .createQueryBuilder('s')
    .select('s.providerCode', 'providerCode')
    .addSelect('COUNT(*)', 'count')
    .where('s.ownerId = :userId', { userId })
    .andWhere('s.saleStatus = :status', { status: SaleStatus.APPROVED })
    .groupBy('s.providerCode')
    .getRawMany();
}
```

Reasonable code. The problem isn't the SQL, it's what MySQL has to touch to answer it. `EXPLAIN` told the whole story:

```sql
EXPLAIN SELECT providerCode, COUNT(*)
FROM sales
WHERE ownerId = 42 AND saleStatus = 'APPROVED'
GROUP BY providerCode;
```

```
type: ref      key: idx_sales_owner     rows: 178214
Extra: Using where; Using temporary; Using filesort
```

`Using temporary; Using filesort` is the tell. There was an index on `ownerId`, so MySQL could find the user's rows, but then it had to walk all 178k of them out to the clustered row to read `providerCode` and `saleStatus`, build a temp table to do the grouping, and sort it. The index got us to the door. It didn't get us inside.

## Two different problems wearing one coat

Here's the thing I had to say out loud to myself before I fixed it properly, because my first instinct was to reach for just one tool.

There are two separate costs here, and they fail on different axes.

The first cost is **per-query work**: even the first time anyone asks for this, MySQL is doing far more I/O than the answer requires. There are maybe five distinct providers. The answer is five rows. We're reading 178k to produce 5. That's a structural waste baked into how the data is laid out on disk, and no amount of caching fixes it — the *first* request after every cache miss still eats the full scan.

The second cost is **redundant work**: the answer barely changes minute to minute, but we recompute it on every single page load. That's not a query-shape problem. You could have the fastest index in the world and you'd still be running it fifty times to get fifty identical donut charts.

A covering index attacks the first. A cache attacks the second. Reach for only one and you've fixed half the problem and convinced yourself you're done. I nearly did exactly that — slapped a cache in front of it, watched the dashboard get snappy, and almost shipped. Then I thought about the cold path: cache eviction, a deploy that flushes Redis, a new manager logging in for the first time at 9am when everyone logs in. Every one of those is a full scan, and they cluster at the worst times.

So: both.

## The covering index

A covering index is one that contains every column the query needs, so MySQL can answer from the index B-tree alone and never touch the actual row. The trick is to put the columns in the right order: equality-filter columns first, then the group-by column.

```sql
CREATE INDEX idx_sales_provider_dist
  ON sales (ownerId, saleStatus, providerCode);
```

Wait — `ownerId` first. The query filters `ownerId = 42 AND saleStatus = 'APPROVED'`, both equality predicates, so they go at the front of the index in any order. Then `providerCode`, the group-by column, comes next so MySQL can scan the user's approved sales in `providerCode` order and count each run without building a temp table or sorting anything.

I generated the migration through TypeORM rather than hand-writing it, added the index to the entity, and let the CLI produce the SQL:

```ts
@Index('idx_sales_provider_dist', ['ownerId', 'saleStatus', 'providerCode'])
@Entity('sales')
export class Sale {
  // ...
}
```

`EXPLAIN` after:

```
type: ref      key: idx_sales_provider_dist     rows: 4
Extra: Using where; Using index
```

`Using index` — that's the covering part, no row lookups. `Using temporary` and `Using filesort` are gone, because the index already hands rows back grouped. And look at the row estimate: 4, not 178k. The 600ms query came back in single-digit milliseconds.

Note the column order matters more than people expect. I first wrote it as `(ownerId, providerCode, saleStatus)` out of habit — group-by column second — and it still covered the query (all three columns are present, so no row lookup), but `saleStatus` being last meant the equality filter on it couldn't be applied as a clean index seek; it became a filter on each scanned entry instead. Putting both equality columns before the group-by is what makes the seek tight. Equality predicates first, then the column you group or sort on. That ordering rule is the whole game with composite indexes.

## The cache

The index makes one run cheap. The cache makes the other forty-nine free.

The result is per-user and it tolerates being a little stale — nobody is making decisions on whether the donut says 41% or 42% Frontier this second. An hour of staleness is fine. So I cache it in Redis, keyed by user, with a one-hour TTL.

```ts
async providerDistribution(userId: string): Promise<ProviderBucket[]> {
  const cacheKey = `provider-dist:${userId}`;
  const cached = await this.cache.get<ProviderBucket[]>(cacheKey);
  if (cached) return cached;

  const rows = await this.salesRepo
    .createQueryBuilder('s')
    .select('s.providerCode', 'providerCode')
    .addSelect('COUNT(*)', 'count')
    .where('s.ownerId = :userId', { userId })
    .andWhere('s.saleStatus = :status', { status: SaleStatus.APPROVED })
    .groupBy('s.providerCode')
    .getRawMany<ProviderBucket>();

  await this.cache.set(cacheKey, rows, 60 * 60 * 1000); // 1h TTL
  return rows;
}
```

The key is scoped to the user on purpose. My first sketch had a single global key and a discriminator I'd forgotten to add, which would have served one manager's distribution to everyone — the kind of bug that's quiet in dev with one test account and very loud in production. Scope the key to exactly the inputs that change the answer: here, the `userId`. If I later let the chart filter by date range, the range goes in the key too, or I'll be serving last month's numbers under this month's filter.

Why an hour? Because the cost of being wrong is low and the cost of recomputing is now also low. If the underlying query had stayed at 600ms I might have gone longer, or added active invalidation on every new sale. With the index making the miss cheap, an hour is a fine middle: rare recomputes, and the recompute itself doesn't hurt.

## What I deliberately did not do

I didn't add cache invalidation on writes. Tempting — bust `provider-dist:${userId}` whenever a sale for that user gets approved — but it buys precision I don't need and adds a coupling between the write path and the dashboard cache that someone will eventually forget about. An hour of drift on a donut chart is not worth a new failure mode. If a product manager ever insists the numbers be live, that's the day I add it, scoped and tested, not before.

I also didn't try to make the index cover *more* queries by stuffing extra columns in. A covering index is only covering for the query it was shaped for; widen it speculatively and you've just made a fat index that's slower to write and doesn't actually cover anything new. One index, one query shape.

## The tradeoffs I took on

The index isn't free. Every insert and update to `sales` now maintains one more B-tree, and `sales` is a write-heavy table — agents log sales all day. In practice the write cost of a three-column index is noise next to the read savings here, but it's real, and if this were a table doing thousands of writes a second I'd weigh it harder. I checked the write latency before and after and it didn't move enough to measure, so: fine.

The cache costs me staleness and a tiny bit of Redis memory. The staleness I chose on purpose. The memory is five rows per active user per hour, which rounds to nothing.

The honest summary of the before/after: the first request for any user dropped from ~600ms to a few milliseconds because of the index, and every subsequent request within the hour dropped to a Redis round-trip — call it under a millisecond — because of the cache. Neither change alone would have done that. The cache without the index leaves you exposed every time Redis is cold, and those cold moments cluster exactly when load is highest. The index without the cache leaves you running a fast query fifty times when zero would do.

Here's where it bites if you only remember one half: you'll cache it, the dashboard will feel fast, you'll close the ticket, and three weeks later a deploy flushes Redis at 9:02am and your database briefly falls over from fifty simultaneous cold full-scans. The cache hid the slow query instead of fixing it. Index first so the miss is survivable, then cache so the miss is rare. In that order.
