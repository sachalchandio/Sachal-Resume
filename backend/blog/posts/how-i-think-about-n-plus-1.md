---
title: "How I actually find N+1 queries before they ship"
description: "Symptoms, query logging, eager vs lazy, and batching with In() — the mental checklist I run on every list endpoint."
date: "2025-06-11"
updated: "2025-06-11"
kind: "deepdive"
category: "Performance"
tags: ["n-plus-1", "orm", "performance", "methodology"]
month: "2025-06"
repo: "both"
author: "Sachal Chandio"
---

The N+1 query doesn't show up in any of the places people look for slow code. It's not a slow query — every single one of those queries is fast. The profiler shows nothing red. The endpoint just takes 900ms to return forty rows and nobody can say why, because there's no one villain. There are eighty-one of them, each taking 4ms, and they're all polite about it.

That's the whole trap. We're trained to hunt for the one expensive thing. N+1 is the opposite shape: a swarm of cheap, identical queries that only become a problem when you stand back and count them.

## The symptom is a count, not a duration

On Telelinkz, the tell-tale endpoint was the sales list. A manager opens their dashboard, we load the last 50 sales, and for each sale the resolver wants the agent who made it, the fronter who set it up, and the campaign it belongs to. Innocent enough on paper.

I had TypeORM logging on in dev, and the console for that one request looked like this, trimmed:

```sql
SELECT * FROM sale WHERE managerId = ? ORDER BY createdAt DESC LIMIT 50
SELECT * FROM user WHERE id = ?   -- agent for sale 1
SELECT * FROM user WHERE id = ?   -- fronter for sale 1
SELECT * FROM campaign WHERE id = ?
SELECT * FROM user WHERE id = ?   -- agent for sale 2
SELECT * FROM user WHERE id = ?   -- fronter for sale 2
SELECT * FROM campaign WHERE id = ?
...
```

One query for the list, then three per row. Fifty rows. 151 queries to render a table. None of them slow. All of them pointless.

The thing I want to hammer: I did not find this with a profiler flame graph. I found it by turning on query logging and *looking at the volume*. That's the entire diagnostic.

```ts
// data-source.ts — leave this on in dev, always
export const AppDataSource = new DataSource({
  type: 'mysql',
  // ...
  logging: ['query'],
  maxQueryExecutionTime: 200, // log anything slower than 200ms separately
});
```

`maxQueryExecutionTime` catches the genuinely slow query. Plain `query` logging catches the swarm. You need both, because they catch different diseases and people forget the second one exists. When I see the same `SELECT ... WHERE id = ?` printed twelve times with different bind values, I don't even read further. That pattern *is* the bug.

A cheaper version of the same check, if you don't want to read the log by eye, is to count. I keep a tiny dev-only subscriber that increments a counter per request and screams if a single GraphQL operation fires more than, say, 30 queries. A list endpoint that does 30+ queries is almost always doing per-row work.

## Eager loading is the fix until it's the disease

The first instinct is `eager: true` or sprinkling `relations` everywhere. Sometimes that's right. Often it's how you trade one performance bug for a worse one.

The honest rule I land on: eager-load a relation when you *always* need it and it's *one row deep*. The sale always needs its campaign. Fine, join it:

```ts
const sales = await this.saleRepo.find({
  where: { managerId },
  relations: { campaign: true }, // single JOIN, always needed — good eager case
  take: 50,
});
```

Where eager turns into a trap is the collection relation. The moment you write `relations: { items: true }` on a paginated query, TypeORM can't do a clean `LIMIT 50` anymore — once it joins a one-to-many, "50 rows" stops meaning "50 sales." I learned this the irritating way: I asked for 50 sales, joined their line items, and got a page that contained eleven sales because the join multiplied rows and the limit chopped them mid-customer. TypeORM papers over it with a subquery in some cases, but the result is a fat JOIN that drags the whole `sale` row across the wire once per item.

So: eager for the to-one relation you always render. Never blanket-eager a to-many on a list. And `eager: true` declared on the entity itself is something I now treat as a code smell, because it fires on *every* query of that entity including the ones that don't want it — you can't opt out at the call site. I'd rather be explicit with `relations` per query and keep the entity dumb.

## The pattern that actually fixed it: In() and a Map

The clean fix for the per-row lookup isn't a join at all. It's: collect every id you need, fetch them in one query with `In()`, build a lookup map, and hand each row its piece. Two queries total, regardless of page size. This is the whole game and it's maybe fifteen lines.

The before — this is genuinely what the field resolver did at first:

```ts
@ResolveField(() => User)
async agent(@Parent() sale: Sale): Promise<User> {
  // fires once PER sale — this is the N
  return this.userRepo.findOneByOrFail({ id: sale.agentId });
}
```

The after uses a per-request DataLoader, which is just the In()-and-Map pattern with batching and dedupe handed to you:

```ts
// user.loader.ts
import DataLoader from 'dataloader';

export function createUserLoader(userRepo: Repository<User>) {
  return new DataLoader<string, User>(async (ids) => {
    const users = await userRepo.find({ where: { id: In([...ids]) } });
    const byId = new Map(users.map((u) => [u.id, u]));
    // CRITICAL: return in the exact order the ids came in, or DataLoader mismaps
    return ids.map((id) => byId.get(id) ?? null);
  });
}
```

```ts
@ResolveField(() => User)
async agent(@Parent() sale: Sale, @Context('loaders') loaders): Promise<User> {
  return loaders.user.load(sale.agentId);
}
```

Now fifty `agent` resolutions plus fifty `fronter` resolutions — all hitting the same `userLoader` — collapse into one `WHERE id IN (...)` query, deduped, because an agent who appears on three sales is fetched once. The 151 queries became 4: one for the sales, one for users, one for campaigns, one for whatever else. I watched the log go quiet and that's how I knew.

Two things bite people here. The map lookup must return `null` for a missing id, not throw — DataLoader resolves each key independently and one bad id shouldn't blow up the batch. And the loader is **per request**, constructed in the GraphQL context factory, never a singleton; a process-wide loader caches across users and you will leak one manager's data into another's response. I create it fresh per request:

```ts
// graphql context factory
context: ({ req }) => ({
  loaders: {
    user: createUserLoader(userRepo),
    campaign: createCampaignLoader(campaignRepo),
  },
}),
```

Outside GraphQL — in a Bull job that crunches a batch, say — I don't reach for DataLoader. I write the `In()` and the `Map` by hand because there's no resolver fan-out to dedupe and the explicit version is clearer:

```ts
const agentIds = [...new Set(sales.map((s) => s.agentId))];
const agents = await this.userRepo.find({ where: { id: In(agentIds) } });
const agentById = new Map(agents.map((a) => [a.id, a]));
for (const sale of sales) {
  sale.agentName = agentById.get(sale.agentId)?.fullName ?? 'Unknown';
}
```

Same idea, no library. `new Set` so I don't fetch the same agent twice. The `In()` clause caps at MySQL's `max_allowed_packet`, so for a 10k-id batch I chunk the ids in groups of ~1000 — but that's a different problem, and one you only hit on jobs, not list endpoints.

## The trick I'm most glad I learned: make the hot function synchronous

Fixing an N+1 once is easy. Keeping it fixed across a year of other people editing the resolver is the actual hard part. Six months later someone adds a field, reaches for the repo out of habit, and the swarm is back. The git blame will say it was a one-line change.

The defense I stumbled into: once a function has all its data in memory, make it **synchronous**. If a mapping function has no `async` and returns no `Promise`, you *cannot* `await` a query inside it without the compiler complaining. The type system becomes the regression test.

```ts
// the data is already loaded; this function takes plain objects and a prebuilt map
// note: NOT async. that's load-bearing.
function toSaleDto(sale: Sale, agentById: Map<string, User>): SaleDto {
  const agent = agentById.get(sale.agentId);
  return {
    id: sale.id,
    amount: sale.amount,
    agentId: sale.agentId,
    agentName: agent?.fullName ?? 'Unknown',
    // someone tries to add `await this.repo.find()` here?
    // it won't compile in a non-async function. good.
  };
}
```

I do the fetching at the top of the handler, all the `In()` queries up front, then map with dumb synchronous functions. A teammate who wants to add data to the DTO is now forced to thread it through the fetch step, where it's visible, instead of sneaking a query into the loop. It's not a lint rule and it's not a comment people ignore. It's the build failing. That's the only kind of guardrail that survives contact with a team.

## When all of this is wrong

Batching has a cost and I've over-applied it. If a page shows one sale, the loader-and-map machinery is pure ceremony around a single `findOne` — write the `findOne`. N+1 is a *list* disease; on a detail endpoint it doesn't exist and the batching is just noise for the next reader.

Eager joins beat batching when the relation is one-to-one, always needed, and small — one fatter query is fewer round trips than two, and round-trip latency to the database is often the real cost, not the row scan. I reach for `In()`-batching specifically when the relation is shared across rows (lots of sales, few agents) so dedupe pays off, or when a JOIN would multiply rows. Few agents, many sales: batch. One sale, one agent: join or just fetch it.

And sometimes the right move is to denormalize. The sales list shows `agentName` on every row. That name changes maybe twice a year. For a while I considered just storing `agentName` on the `sale` row at write time and skipping the lookup entirely — the classic stale-data-for-speed trade. I didn't, because we let agents rename, and a renamed agent showing the old name on historical sales is a support ticket I didn't want. But it was a real option, and on a field that truly never changes I'd take it.

Rules of thumb I'd actually tattoo on a new hire:

- Turn on `logging: ['query']` and read the volume, not just the duration. The bug is a count.
- A `WHERE id = ?` you see more than twice in one request is an N+1 until proven otherwise.
- To-one, always-needed: eager join. Shared across rows or a to-many: `In()` plus a `Map`.
- The loader is per request. A singleton loader is a data leak with extra steps.
- Once the data's in memory, make the mapping function synchronous so the next person physically can't put a query back in the loop.

The last one is the only one that's saved me twice.
