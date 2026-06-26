---
title: "Killing an N+1 in salary generation: 3,000 queries down to 27"
description: "How Telelinkz salary generation went from thousands of per-sale queries to a couple dozen by prefetching lookups and batching by provider."
date: "2026-01-09"
updated: "2026-01-09"
kind: "deepdive"
category: "Performance"
tags: ["nestjs", "typeorm", "mysql", "performance"]
month: "2026-01"
repo: "backend"
author: "Sachal Chandio"
---

The first complaint was vague, the way they always are. "Salary generation is slow." A manager clicks a button at the end of the month, the job goes into a Bull queue, and a few minutes later a salary report shows up. A few minutes. For one agent.

For one agent the job loops over every activated sale that month and works out how much commission that agent earned. A busy month is a thousand-odd sales across two dozen providers. When I queued a generation run and tailed the logs, the thing crawled — batch 1 of 11, batch 2 of 11 — and each batch sat there for ten, fifteen seconds. The MySQL slow query log wasn't lighting up with one monster query. It was lighting up with thousands of tiny ones, all shaped the same:

```sql
SELECT * FROM xfinity_sale WHERE id = ? LIMIT 1;
SELECT * FROM package_version WHERE id = ? LIMIT 1;
SELECT * FROM provider_commission_split WHERE providerCode = ? LIMIT 1;
```

That's the tell. Not one slow query — a swarm of fast ones. The classic N+1, except it was more like N×3.

## What the loop was actually doing

The processor handles all 25 sale types in the system, each with its own table (`xfinity_sale`, `spectrum_sale`, `frontier_sale`, and so on). Each sale row carries a handful of package-version foreign keys — `internetPackageId`, `tvPackageId`, `saleStatusPackageId` — and the commission for a sale is the sum of the `commission` column on each referenced `package_version`.

The original `processSalesBatch` did the obvious thing. For every sale stage in the batch:

```ts
// the naive version I shipped first
for (const saleStage of salesBatch) {
  const repoKey = this.mapSaleStageTypeToRepositoryKey(saleStage.saleType);
  const config = this.saleRepositoryMap[repoKey];

  // round trip #1: fetch the actual sale entity
  const sale = await config.repository.findOne({
    where: { id: saleStage.saleId },
    relations: ['agent', 'fronter'],
  });

  // round trip #2: the closer/fronter split for this provider
  const split = await this.commissionSplitService.getSplit(repoKey);

  // round trip #3..#N: one lookup per package version on the sale
  for (const field of config.packageFields) {
    const pvId = sale[field];
    if (!pvId) continue;
    const pv = await this.packageVersionRepository.findOne({
      where: { id: pvId },
      relations: ['package'],
    });
    // ...accumulate commission
  }
}
```

Read that and count. A thousand sales is a thousand `findOne` calls for the sale entity. Another thousand for the split — and the split only varies by provider, so for an XFINITY-heavy month I was fetching the *same* `provider_commission_split` row hundreds of times. Then four or five package-version lookups per sale, each its own query. The arithmetic lands somewhere north of 3,000 round trips for a single agent's monthly report.

None of those queries is slow on its own. A primary-key lookup on MySQL is sub-millisecond. But the cost isn't the query, it's the round trip — TypeORM building the SQL, the driver shipping it to RDS, the network hop, the result coming back, the entity getting hydrated, repeat. At a couple of milliseconds of overhead each, 3,000 of them is your several minutes. The database was bored. The connection was the bottleneck.

And the `await` inside the loop made it worse: every query was sequential. Nothing overlapped. The whole job was one long single-file line of trivial questions.

## The fix: ask everything up front

The shape of the fix is always the same once you see it. Stop asking per-row. Gather the IDs, ask once per *kind* of thing, stuff the answers in a `Map`, then do the actual computation against memory with no `await` in sight.

Three things needed prefetching: the splits, the sale entities, and the package versions.

**Splits first, because they're tiny.** There are 25-ish providers, so the whole `provider_commission_split` table fits in one query. Load it once, index by provider code:

```ts
const allSplits = await this.commissionSplitService.listSplits();
const splitsMap = new Map(allSplits.map((s) => [s.providerCode, s]));
```

That single line deletes a thousand queries. The split for XFINITY is now a `Map.get`, not a database trip.

**Sale entities, grouped by provider.** Here's the wrinkle that makes this more interesting than a textbook N+1: there's no single `sale` table. Each provider has its own. So I can't just `In()` a flat list of IDs — I have to bucket the sale IDs by which table they live in, then fire one `find` per bucket:

```ts
// bucket sale IDs by their provider table
const salesByProvider: Record<string, string[]> = {};
for (const saleStage of salesBatch) {
  if (!saleStage.saleId || !saleStage.saleType) continue;
  const repoKey = this.mapSaleStageTypeToRepositoryKey(saleStage.saleType);
  if (!this.saleRepositoryMap[repoKey]) continue;
  (salesByProvider[repoKey] ??= []).push(saleStage.saleId);
}

// one query per provider table, not one per sale
const saleEntitiesMap = new Map<string, any>();
for (const [repoKey, saleIds] of Object.entries(salesByProvider)) {
  const config = this.saleRepositoryMap[repoKey];
  const entities = await config.repository.find({
    where: { id: In(saleIds) },
    relations: ['agent', 'fronter'],
  });
  for (const entity of entities) {
    saleEntitiesMap.set(`${repoKey}:${entity.id}`, entity);
  }
}
```

A month touching eight providers is now eight queries for sale entities instead of a thousand. The `In(saleIds)` becomes a single `WHERE id IN (?, ?, ?, …)` per table, and MySQL chews through a few hundred primary keys without breaking a sweat.

**Package versions, all in one shot.** Walk every fetched sale, collect every package-version ID into a `Set` (dedupe is free, and it matters — popular packages repeat constantly across sales), then one `find`:

```ts
const allPackageVersionIds = new Set<string>();
for (const entity of saleEntitiesMap.values()) {
  const config = this.saleRepositoryMap[saleIdToTypeMap.get(entity.id)];
  for (const field of config.packageFields) {
    const pvId = entity[field];
    if (pvId) allPackageVersionIds.add(pvId);
  }
}

const packageVersionsMap = new Map<string, PackageVersion>();
const pvs = await this.packageVersionRepository.find({
  where: { id: In(Array.from(allPackageVersionIds)) },
  relations: ['package'],
});
for (const pv of pvs) packageVersionsMap.set(pv.id, pv);
```

That `Set` is doing real work. A batch of 100 sales might reference 400 package IDs but only 60 distinct ones, because everybody's selling the same handful of internet plans. Dedup before you query and the `IN` list stays small.

## The part that's easy to forget

I prefetched all three maps and the job was still slow. Because `calculateSaleCommissions` was still `async` and still `await`ing inside the loop, even though everything it needed was now sitting in memory. The method signature was lying about what it did.

So I made it synchronous. New name, no `await`, no repository on it at all — it takes the prefetched `packageVersionsMap` as an argument and reads from it:

```ts
// before
private async calculateSaleCommissions(sale, fields, ...): Promise<SalaryCommission[]> {
  for (const field of fields) {
    const pv = await this.packageVersionRepository.findOne({ where: { id: sale[field] } });
    // ...
  }
}

// after — pure function over pre-fetched data, no DB
private calculateSaleCommissionsSync(
  saleEntity: any,
  packageFields: string[],
  saleType: string,
  salaryReportId: string,
  saleDate: Date,
  packageVersionsMap: Map<string, PackageVersion>,
  // ...split/penalty args
): SalaryCommission[] {
  const commissions: SalaryCommission[] = [];
  for (const field of packageFields) {
    const pvId = saleEntity[field];
    if (!pvId) continue;
    const pv = packageVersionsMap.get(pvId); // memory, not MySQL
    if (pv?.commission > 0) {
      commissions.push(/* build the SalaryCommission row */);
    }
  }
  return commissions;
}
```

Making it `sync` wasn't cosmetic. It's a guardrail. An `async` function quietly invites someone — future me, mostly — to drop another `await this.somethingRepository...` into the loop six months later and silently reintroduce the N+1. A synchronous method that only has a `Map` to work with *can't* hit the database. The type signature enforces the optimization. The compiler is now on my side.

## What it cost and what it bought

The per-agent batch went from roughly 3,000 queries to about 27: one for the splits, one `getActivatedSales` to pull the sale stages, a handful for the per-provider sale entities, one for all the package versions, plus the penalty lookups and the final saves. Wall-clock time for a generation run dropped from minutes to a couple of seconds. Roughly 100x, and it's the kind of number that sounds made up until you remember the baseline was 3,000 sequential network round trips and the new floor is a couple dozen batched ones.

I didn't touch a single index. I didn't tune MySQL. The database was never the problem — it was answering thousands of trivial questions perfectly quickly. The fix was to stop asking them one at a time.

## When this bites

N+1 doesn't show up in a unit test, and it barely shows up in dev. With ten seed sales the naive loop is 30 queries and runs in 40 milliseconds — looks fine, ships fine. It only bites at production volume, on a real network, against RDS instead of a database on localhost. The slope is invisible until the data is.

A few things I'd watch for, having been burned:

- **`await` inside a `for` loop is the smell.** Every time you see one, ask whether the thing you're awaiting could be hoisted out and batched. Usually it can.
- **`IN()` lists have a ceiling.** A batch of a few hundred IDs is fine; tens of thousands will blow past MySQL's `max_allowed_packet` or just produce a horrible query plan. That's exactly why the job still chunks sales into batches of 100 before prefetching — batching solves N+1, but unbounded batching is its own footgun.
- **Dedup before you query.** A `Set` of IDs is almost free and routinely halves the size of your `IN` list.
- **Lock the optimization into the type.** A function that only receives a `Map` cannot regress into a query. That single decision — make it `sync` — is what keeps this fixed a year from now, long after everyone's forgotten why.

The general rule I keep relearning: if something is slow and the database isn't complaining, count your round trips before you reach for an index.
