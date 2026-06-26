---
title: "Caching layers that actually help: memory, Redis, and covering indexes"
description: "Three different tools for three different problems, and how to tell which one you actually have."
date: "2025-10-22"
updated: "2025-10-22"
kind: "deepdive"
category: "Performance"
tags: ["caching", "redis", "mysql", "indexes"]
month: "2025-10"
repo: "backend"
author: "Sachal Chandio"
---

The first cache I added to Telelinkz made the app faster and wrong at the same time. A sales manager renamed a campaign, refreshed, and saw the old name for the next ten minutes. The query was cheaper. The data was a lie. That bug taught me the thing this whole post is about: most caching problems aren't one problem. They're three, and they want three different tools.

Here's the thesis up front. Before you cache anything, figure out which of these you have:

- The same value is read constantly inside one process and almost never changes. That's a **memory** problem.
- An expensive result is read by many processes, or it's scoped per-user and you want it to expire on its own. That's a **Redis** problem.
- A query is slow because the database is doing real work — scanning, sorting, hitting the heap for columns. Caching the result is treating a fever with a blanket. That's an **index** problem.

Get the category wrong and you don't just fail to help. You add a stale-data bug, or a cache stampede, or a layer of indirection over a query that was always going to be slow on the third page. Let me go through each with what I actually shipped.

## Memory: for the lookups you read a thousand times a request

Telelinkz has a set of tables that barely move. Lead dispositions. Sale statuses. The list of carriers we sell. These get joined and resolved on basically every request that touches a sale, and they change maybe once a month when someone in ops adds a row.

The naive version: a `findOne` to MySQL every time a resolver needed the disposition label. On a list of 200 sales with a few nested fields each, that's a depressing number of identical round trips. GraphQL makes this worse because every field resolver runs independently and none of them know the others just asked the same question.

I didn't reach for Redis here. A network hop to Redis to fetch a value that fits in a `Map` and never changes is its own kind of silly. I used an in-process cache with a short TTL:

```ts
@Injectable()
export class DispositionCache {
  private store = new Map<number, { value: Disposition; expires: number }>();
  private readonly ttlMs = 60_000;

  constructor(private readonly repo: Repository<Disposition>) {}

  async get(id: number): Promise<Disposition> {
    const hit = this.store.get(id);
    if (hit && hit.expires > Date.now()) return hit.value;

    const value = await this.repo.findOneByOrFail({ id });
    this.store.set(id, { value, expires: Date.now() + this.ttlMs });
    return value;
  }
}
```

Sixty seconds of staleness on a disposition label is fine. Nobody renames a disposition and expects every node in the cluster to reflect it in the same second. And that TTL is the entire safety mechanism — I don't try to invalidate on write, because the write path for these tables is an admin screen that runs a few times a year, and a self-expiring entry is one fewer thing to get wrong.

Two real caveats, because this is where memory caching bites.

First, it's per-process. We run multiple Node instances behind the load balancer. Each has its own `Map`, so right after a write you can get two different answers depending on which box you hit. For disposition labels, who cares. For anything a user can see change and react to, this asymmetry is exactly how you ship a heisenbug.

Second, an unbounded `Map` is a memory leak with a polite name. The disposition table has a few dozen rows, so I let it grow. The moment the key space is unbounded — anything keyed by sale id, lead id, user id — you need an LRU with a hard cap, or you've just moved your outage from "slow" to "OOM at 3am."

In-memory is the right tool when the data is small, hot, shared across requests in the same process, and you can tolerate a few seconds of drift. The instant any of those stops being true, go up a layer.

## Redis: for results that cross processes and want a deadline

The dashboard is where Redis earned its place. It aggregates sales for the logged-in user over a date range — counts by status, totals, a couple of rolling figures. The query fans out across joins and is genuinely expensive, and the same user reloads the dashboard constantly while they work.

This fails every test for in-memory caching. The result is per-user, so the cache is large and sparse, not small and hot. It's expensive enough that recomputing on every process is wasteful. And I want it shared, so the second Node box reuses what the first one already paid for.

The shape that worked:

```ts
async getDashboard(userId: number, range: DateRange): Promise<DashboardStats> {
  const key = `dash:v2:${userId}:${range.from}:${range.to}`;

  const cached = await this.redis.get(key);
  if (cached) return JSON.parse(cached);

  const stats = await this.computeDashboard(userId, range); // the expensive part
  await this.redis.set(key, JSON.stringify(stats), 'EX', 120);
  return stats;
}
```

Three decisions in there matter more than the code.

The TTL is deliberate, not a default I copied. Two minutes is the answer to "how stale can this dashboard be before someone is annoyed but not misled." A new sale showing up two minutes late on a stats panel is nothing. Two minutes is also long enough that a reload-happy user during a busy hour hits the cache almost every time. I picked the number against a sentence about acceptable staleness, and that's the only honest way to pick a TTL.

The key is scoped to the user *and* the range, and the range is in the key — not because I love long keys, but because forgetting a dimension is how you serve one user another user's numbers, or last week's range under this week's key. Every input that changes the output goes in the key. No exceptions.

That `v2:` prefix is the cheapest invalidation strategy in existence. When I changed what `computeDashboard` returns, I didn't write a migration to purge old keys. I bumped the prefix to `v3:` and the old entries aged out on their own TTL. Versioned keys mean a deploy can change the shape of cached data without a flush and without serving the new code a payload it doesn't understand.

The trap I sidestepped, mostly by luck the first time and on purpose after, is the stampede. TTL expires, fifty requests for the same key arrive in the same second, all miss, all run the expensive query at once, and you've built a tool that periodically DDoSes your own database on a 120-second clock. For the worst offenders I gate the recompute behind a short Redis lock (`SET key value NX EX 10`) so only one process rebuilds while the rest briefly serve slightly-stale or wait. You don't need it everywhere. You need it the moment a single key is both hot and expensive.

One more thing Redis quietly gave me: it's also our pub/sub and our Bull queue backbone, so it was already in the cluster, already monitored, already in the connection pool. Adding a cache to infrastructure you already operate is a very different decision from standing up a new dependency to cache one endpoint. If Redis hadn't already been there, the bar for the dashboard cache would've been much higher, and I might have gone straight to fixing the query instead.

## Covering indexes: when the honest fix is making the query cheap

This is the one people skip, because caching feels like progress and indexing feels like admitting the query was bad. Sometimes the query was bad.

We had a sales-history list — paginated, filtered by agent and a date range, sorted by `created_at` descending. It got slow as the table grew, in that nonlinear way where it's fine in dev and fine for a month in prod and then page two takes a second and a half. My first instinct was Redis. Cache the page. But list pages are a bad cache target: every filter combination and every page number is a distinct key, the hit rate is awful, and the data changes whenever a sale is created, which on this table is constantly. I'd have been caching mostly-misses and serving stale lists.

So I did what I should have done first and ran `EXPLAIN`:

```sql
EXPLAIN SELECT id, agent_id, status_id, amount, created_at
FROM sales
WHERE agent_id = 42 AND created_at BETWEEN ? AND ?
ORDER BY created_at DESC
LIMIT 20 OFFSET 40;
```

`type: ALL`, a fat `rows` estimate, and `Using filesort` in Extra. It was scanning a chunk of the table and sorting it in memory to throw almost all of it away. No cache fixes that; it just hides it behind a timer until the cache misses at the worst moment.

The fix was a composite index ordered to match the access pattern — equality column first, then the column used for both range and sort:

```sql
CREATE INDEX idx_sales_agent_created
ON sales (agent_id, created_at, status_id, amount);
```

Column order is the whole game. `agent_id` first because it's an equality match. `created_at` second because MySQL can then walk that side of the index in order and satisfy `ORDER BY created_at DESC` with no filesort — the range and the sort live on the same column. Then I tacked `status_id` and `amount` onto the end so the index *covers* the query: every column the SELECT reads is in the index, so InnoDB answers it straight from the B-tree and never touches the clustered row. After the change, `EXPLAIN` showed `Using where; Using index` — that second phrase, `Using index`, is the covering part, and it's the difference between a list that's fast on page one and a list that's fast on page forty.

No TTL. No invalidation. No stampede. No staleness, ever, because there's no cache — the database just does less work. When the real problem is the query, an index is strictly better than a cache, and the only reason it's the road less travelled is that it asks you to read `EXPLAIN` output instead of wrapping a `get`/`set` around the slowness.

A caution so I'm not lying by omission: every index has a write cost, the covering trick tempts you to stuff half the table into the index until the index is as wide as the row and you've lost the point, and `OFFSET 40` is cheap while `OFFSET 40000` is not — deep pagination wants a keyset (`WHERE created_at < ?`) cursor, not a bigger index. Indexes are not free. They're just usually the right kind of not-free.

## The rules I actually use now

- Name the problem before you name the tool. "This is slow" isn't a problem statement. "The same per-user aggregate is recomputed on every reload" is, and it points straight at Redis. "The query does a filesort over 80k rows" points at an index. Skip this step and you'll cache something that should've been indexed.
- Run `EXPLAIN` before you reach for a cache on anything backed by a single query. Half the time the cache was you avoiding a five-minute index.
- A cache without an invalidation story is a stale-data bug with a delay. TTL counts as a story; bumping a `v2:` key prefix counts; "I'll remember to clear it" does not.
- Pick the TTL against a sentence about acceptable staleness, then write that sentence in a comment. If you can't finish the sentence, you don't understand the data well enough to cache it.
- In-memory for small/hot/shared-in-process and a few seconds of drift. Redis for cross-process, per-user, expensive, and a deliberate deadline. An index when the database is doing avoidable work — which is more often than caching's good press suggests.

The dashboard still hits Redis. The dispositions still live in a `Map`. And that sales list has no cache at all, which is the part I'm proudest of, because the fastest cache is the one you didn't need.
