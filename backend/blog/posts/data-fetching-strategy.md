---
title: "A data-fetching strategy for batch processors"
description: "Prefetch the lookups, group, In(), read from maps — the discipline behind the 3,000-to-27 query cut."
date: "2026-01-27"
updated: "2026-01-27"
kind: "deepdive"
category: "Performance"
tags: ["performance", "orm", "batch"]
month: "2026-01"
repo: "backend"
author: "Sachal Chandio"
---

The salary-generation fix that took a Bull job from ~3,000 queries to ~27 wasn't a clever trick. There was no exotic index, no query rewrite, no MySQL tuning. It was a *strategy*, and once I'd applied it once I started seeing the same five steps everywhere — the commission backfill, the search reindex, the monthly analytics rollup. So this post is the strategy itself, lifted out of that one war story and written down as something I now reach for before I write the first `await` in any batch job.

Here's the whole thing in one breath: enumerate every kind of thing the batch will need, fetch each kind exactly once, index each result set in a `Map`, then run the actual computation against memory with a function that physically cannot touch the database. Five steps. The last one is the one everyone skips and it's the one that keeps the fix from rotting.

## The shape of every batch processor

A batch job is a loop over rows where each iteration needs some satellite data to do its work. Salary generation loops over a month of activated sales and, for each one, needs the sale entity, the commission split for that provider, and every referenced `package_version`. The commission backfill loops over historical sales and needs the same lookups. A search reindex loops over entities and needs their related rows to build the document.

The naive version writes the loop the way you'd say it out loud. "For each sale, get its split, get its packages, compute." That sentence has the bug baked in. "For each sale, get its split" is N round trips to fetch a thing that only varies by provider — there are twenty-five providers and a thousand sales, so you fetch the same `provider_commission_split` row hundreds of times. The loop is asking the database the same question over and over because the loop is where the question got asked.

The strategy inverts the sentence. You don't ask per row. You ask per *kind of thing*, before the loop starts, and the loop becomes pure arithmetic.

## Step 1: enumerate what you'll need

Before writing any query, list the kinds of data the inner computation will read. Not the rows — the *kinds*. For salary generation:

- sale entities (one per sale, lives in a per-provider table)
- commission splits (one per provider — there are ~25)
- package versions (a handful of FKs per sale, heavily shared across sales)
- penalties (per agent, per month)

Four kinds. That's your query budget: roughly four batched queries plus the driver loop that pulls the sale stages, plus the saves at the end. If your enumeration has four kinds and your job is firing four thousand queries, you know exactly how much fat there is before you've profiled anything.

This step sounds trivial and it's the one I used to skip. Writing the list out loud is what tells you which lookups collapse. Splits "vary by provider" — that's a tiny, fixed set, so it's one query for the whole table. Package versions are "shared across sales" — that's a dedupe opportunity. The enumeration is where you spot those, not in the code.

## Step 2: fetch each kind once

Now turn each kind into exactly one query. The mechanics differ by kind, and the differences matter.

**The small fixed set: just load all of it.** The splits table is twenty-five rows. Don't bother collecting IDs — read the whole thing.

```ts
const allSplits = await this.commissionSplitService.listSplits();
const splitsMap = new Map(allSplits.map((s) => [s.providerCode, s]));
```

One query replaces a thousand. When a lookup table is small and you'll touch most of it, fetching the entire table is cheaper *and* simpler than collecting keys and `In()`-ing them. I now check "is this just small?" first, because half the time it is and the rest of the strategy is unnecessary ceremony for that kind.

**The keyed set: collect IDs, dedupe, `In()` once.** Package versions are the textbook case. Walk the rows you already have, push every FK into a `Set`, fire one query:

```ts
const pvIds = new Set<string>();
for (const sale of saleEntities) {
  for (const field of packageFieldsFor(sale.saleType)) {
    if (sale[field]) pvIds.add(sale[field]);
  }
}

const pvs = await this.packageVersionRepository.find({
  where: { id: In([...pvIds]) },
  relations: ['package'],
});
const pvMap = new Map(pvs.map((pv) => [pv.id, pv]));
```

The `Set` is not decoration. A batch of 100 sales might reference 400 package FKs but only 60 distinct values, because everybody's selling the same handful of internet plans. Dedupe before the query and the `IN` list stays short and the query plan stays sane.

**The partitioned set: group by table, one query per group.** This is the wrinkle that made salary generation more than a textbook N+1, and it's worth dwelling on because partitioned data shows up constantly in real schemas. There is no single `sale` table. Each provider has its own — `xfinity_sale`, `spectrum_sale`, `frontier_sale`, twenty-five of them. So you cannot `In()` a flat list of sale IDs; an ID only means something paired with its table. You bucket first:

```ts
const idsByTable: Record<string, string[]> = {};
for (const stage of salesBatch) {
  const key = this.mapSaleStageTypeToRepositoryKey(stage.saleType);
  if (!this.saleRepositoryMap[key]) continue;
  (idsByTable[key] ??= []).push(stage.saleId);
}

const saleMap = new Map<string, any>();
for (const [key, ids] of Object.entries(idsByTable)) {
  const rows = await this.saleRepositoryMap[key].repository.find({
    where: { id: In(ids) },
    relations: ['agent', 'fronter'],
  });
  for (const row of rows) saleMap.set(`${key}:${row.id}`, row);
}
```

A month touching eight providers is eight queries instead of a thousand. The number of queries here scales with the number of *partitions*, not the number of rows — and partitions are a small, bounded set. That's the property you're hunting for in step 2: make every query count something small.

Note the composite key, `` `${key}:${row.id}` ``. The IDs are UUIDs and globally unique in practice, but I refuse to assume that across twenty-five independently-seeded tables. Namespacing the map key by table costs nothing and removes a class of bug where two providers happen to collide an ID and one silently overwrites the other in the map.

## Step 3: index everything in a Map

Each fetch ends the same way: build a `Map` from the natural key to the row. By the time the loop starts you should be holding a small pile of maps — `splitsMap`, `saleMap`, `pvMap`, `penaltyMap` — and zero loose repositories.

Two things I've learned to be deliberate about. First, pick the key that the inner loop will actually have in hand. The package map is keyed by `pv.id` because the sale row carries `pv.id`. The split map is keyed by `providerCode` because that's what you've got at compute time. If you key a map by something the loop has to compute or look up elsewhere, you've just moved the problem. Second, decide what a *miss* means before you write the lookup. `pvMap.get(badId)` returns `undefined`, and the inner function has to treat that as "no commission for this field," not crash. A batch job that throws on the first dangling FK in a month of data is a batch job that never finishes a real month.

## Step 4: run the computation against memory — synchronously

Here's the part everyone skips, and skipping it is why N+1s come back.

After I prefetched all four maps, the job was *still slow*. Because the function doing the per-sale math was still `async` and still had `await this.packageVersionRepository.findOne(...)` inside its loop. The maps were sitting right there, full, and the code walked past them to ask the database again. The prefetch was real work that bought nothing, because the consumer never changed.

So I made the inner function synchronous. New name, no `async`, no repository in its arguments at all — it takes the prefetched maps and reads from them:

```ts
// note: NOT async. that is the whole point.
private calculateSaleCommissionsSync(
  saleEntity: any,
  packageFields: string[],
  saleType: string,
  salaryReportId: string,
  saleDate: Date,
  packageVersionsMap: Map<string, PackageVersion>,
  // ...split/penalty args, all plain data
): SalaryCommission[] {
  const out: SalaryCommission[] = [];
  for (const field of packageFields) {
    const pvId = saleEntity[field];
    if (!pvId) continue;
    const pv = packageVersionsMap.get(pvId); // memory, not MySQL
    if (pv && pv.commission > 0) {
      out.push(/* build the SalaryCommission row */);
    }
  }
  return out;
}
```

Making it `sync` is not a style choice and it's not a micro-optimization. It's a guardrail enforced by the compiler. An `async` function is an open invitation — to future me, mostly — to drop one more `await this.somethingRepository.findOne(...)` into the loop six months from now when a new requirement lands, and silently reintroduce the swarm. The git blame will read as a one-line feature change. Nobody will connect it to the job going slow again.

A synchronous function that only receives `Map`s and plain objects *cannot* do that. There's no `this.repository` to reach for, and you can't `await` in a non-async function without the build going red. The optimization is now encoded in the type signature. The next person who wants to add a piece of data to the computation is forced to thread it through the prefetch step at the top of the handler — where it's visible, where it gets batched — instead of sneaking a query into the hot loop. That's the only kind of guardrail that survives a team. A comment gets ignored. A failing build does not.

The whole handler ends up reading top-to-bottom as: fetch, fetch, fetch, then a tight loop of synchronous calls.

```ts
const splitsMap = /* step 2 */;
const saleMap = /* step 2 */;
const pvMap = /* step 2 */;
const penaltyMap = /* step 2 */;

const rows: SalaryCommission[] = [];
for (const stage of salesBatch) {
  const sale = saleMap.get(`${keyFor(stage)}:${stage.saleId}`);
  if (!sale) continue;
  rows.push(
    ...this.calculateSaleCommissionsSync(sale, /* ...maps */),
  );
}
await this.salaryCommissionRepository.save(rows); // one write, batched
```

The fetches are at the top where you can count them. The loop has no `await`. The save is one batched insert, not a write per row.

## Where the strategy is wrong

It isn't free, and I've over-applied it enough to know the edges.

**A single-row job doesn't need any of this.** If your "batch" is one sale — a detail endpoint, a single recompute — the maps and `Set`s are pure ceremony around a `findOne`. Write the `findOne`. This strategy is a *volume* strategy; below some threshold the machinery costs more in reader confusion than it saves in round trips.

**`In()` has a ceiling.** A few hundred IDs in an `IN` clause is fine. Tens of thousands will blow past MySQL's `max_allowed_packet` or hand the planner a query it makes a mess of. That's exactly why the salary job still chunks the month into batches of 100 *before* it prefetches — the strategy fixes N+1 within a chunk, but unbounded fetching is its own footgun. So the real shape is: chunk to a sane size, then apply the five steps per chunk. If a single chunk's `IN` list could exceed ~1,000 IDs, chunk the IDs too.

**Prefetching everything can cost more memory than it saves time.** Loading a whole table into a `Map` is great for twenty-five splits. It's a bad idea for a table with two million rows when the batch only touches a thousand of them — there you collect keys and `In()`, you don't slurp the table. The "just load all of it" shortcut from step 2 is only valid when the table is genuinely small or you'll touch most of it.

**It assumes the lookups are stable for the duration of the job.** Reading everything up front into memory means you're working against a snapshot. For a salary report that's correct — you *want* a consistent view of the month. For a long-running job where the underlying rows change as you process, prefetched maps can go stale and you may want to refetch per chunk instead. Know which world you're in.

## Rules of thumb

- Write the list of *kinds* of data before you write a query. The kinds that collapse to one query (small tables, shared lookups) reveal themselves in the list, not the profiler.
- `await` inside a `for` loop is the smell. Every one is a question to ask whether it hoists out and batches.
- Dedupe with a `Set` before you `In()`. It's nearly free and it routinely halves the list.
- Partitioned data batches per partition, not per row — group by table, one query per group, and namespace the map key so two tables can't collide.
- Decide what a map *miss* means before you write the `.get()`. A dangling FK should skip, not throw.
- Make the inner function synchronous. It's the only step that keeps the fix from rotting, because it's the only one the compiler enforces.

The first four steps are how you make a batch job fast today. The fifth is how you keep it fast after you've forgotten you ever touched it.
