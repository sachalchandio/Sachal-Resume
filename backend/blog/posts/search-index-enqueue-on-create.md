---
title: "Keeping search consistent: enqueue index jobs the moment a sale is saved"
description: "New Astound and ForeverFreedom sales were invisible to search until a manual resync. Event-driven indexing fixed it."
date: "2025-05-16"
updated: "2025-05-16"
kind: "deepdive"
category: "Real-time"
tags: ["bull", "queues", "search", "consistency"]
month: "2025-05"
repo: "backend"
author: "Sachal Chandio"
---

An agent uploaded a batch of Astound sales, then went to the global search bar to pull one up by phone number. Nothing. He retyped the number. Still nothing. He pinged me a screenshot: the sale was clearly in the system — it showed in the Astound sales grid, the order number was right there — but search returned zero results for it. Same story a day later with ForeverFreedom, our solar provider. The sale existed. Search swore it didn't.

The annoying part is that it wasn't all sales. Single-sale creations through the normal form worked fine. Type the customer's name a minute later, there they were. It was specifically the bulk-created ones, and specifically a couple of providers, that fell into a hole.

## Where search actually reads from

We don't search the provider tables directly. There are something like thirty of them — `astound_sale`, `forever_freedom_sale`, `xfinity_sale`, `atnt_sale`, and on and on — each with its own columns and its own naming quirks. Searching across all of them at query time would mean thirty `UNION`s and a different `WHERE` shape per provider. So instead there's one denormalized table, `search_index`, with a flat shape every record collapses into: `customerName`, `phoneNumber`, `email`, `orderNumber`, `state`, `agentId`, `providerId`, `searchableText`. Every sale and every interested customer gets a row. Search hits that one table and that one table only.

Which means a sale is findable if and only if a `search_index` row exists for it. The provider table being correct is necessary but not sufficient. If nothing wrote the index row, the sale is invisible no matter how real it is in `astound_sale`.

So the question wasn't "why is search broken" — search was fine. The question was "why didn't these sales get an index row."

## The wrong guess

My first instinct was the reindex job. There's a `SearchIndexProcessor` that does full provider reindexes — `reindexProvider`, cursor-paginated in batches of 1000, the thing you run to rebuild the index from scratch. My theory: the reindex query was skipping these rows somehow. A bad cursor, a provider code that didn't map, a `getRepositoryForProviderCode` returning `null` for ASTOUND.

I checked. The repository map was fine:

```ts
private getRepositoryForProviderCode(providerCode: string): Repository<any> | null {
  const repositoryMap = {
    XFINITY: this.xfinityRepository,
    ASTOUND: this.astoundRepository,
    FOREVER_FREEDOM: this.foreverFreedomRepository,
    // ...thirty-odd entries
  };
  return repositoryMap[providerCode] || null;
}
```

ASTOUND was there. FOREVER_FREEDOM was there. And when I actually ran the reindex against staging, the missing sales showed up in search immediately afterward. The reindex worked perfectly. That was the clue I'd been misreading: if a manual reindex fixes it, the problem isn't the reindexer. The problem is that something is supposed to index each sale *as it's created*, and for these it wasn't happening. The reindex was a band-aid the team had been unconsciously relying on — every so often someone ran it, search caught up, and the gap closed until the next batch.

I'd been debugging the safety net instead of the thing that was supposed to make the safety net unnecessary.

## The root cause

On the create path, indexing is supposed to be fire-and-forget through a Bull queue. The sale gets saved, then a job named `index-sale` goes onto the `events` queue, and a processor picks it up and writes the `search_index` row off the request thread. Here's the single-create path on Astound, which worked:

```ts
const savedSale = await this.astoundSaleRepository.save(sale);
await this.saleStageService.create(sale.id, this.saleType, agent);

await this.eventsQueue.add(
  'index-sale',
  { saleId: savedSale.id, saleData: savedSale, saleType: this.saleType },
  { priority: 5, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
);
```

Now the bulk path on the same service, as it was:

```ts
async createBulkSalesAstound(inputs: CreateAstoundSaleInput[], agent: User) {
  const sales = inputs.map((input) => this.astoundSaleRepository.create({ ...input, agent }));
  const savedSales = await this.astoundSaleRepository.save(sales);
  return savedSales; // <- that's it. saved and returned.
}
```

There's the hole. The bulk method saved the rows and returned them. No `index-sale` job, for any of them. The single-create method enqueued indexing; the bulk method that someone wrote later, optimized for throughput, just... didn't. Nobody noticed because the reindex job kept papering over it. ForeverFreedom had the exact same shape — `createBulkSalesForeverFreedom` saved a batch and returned, no enqueue.

And there was a second, quieter bug stacked underneath. Even if I'd added the enqueue, ForeverFreedom would still have failed at the *processor* end. The `index-sale` job calls `SearchIndexingService.indexSale`, which resolves the provider, builds the row, and saves it. That part was provider-agnostic and fine. But the reindex processor — the one I'd been blaming — only knew about a provider if its repository was injected into the constructor, and for a while `FOREVER_FREEDOM` simply wasn't in that list. So the create-time path had no enqueue, *and* the rebuild-time path couldn't see the provider either. Forever Freedom could fall through both doors.

## The fix

Two changes, matching the two holes.

First, the bulk create has to enqueue one `index-sale` job per saved row, with the same retry semantics as the single path. I do it after the save resolves, so every job carries a real database id:

```ts
async createBulkSalesAstound(inputs: CreateAstoundSaleInput[], agent: User) {
  const sales = inputs.map((input) => this.astoundSaleRepository.create({ ...input, agent }));

  try {
    const savedSales = await this.astoundSaleRepository.save(sales);

    await Promise.all(
      savedSales.map((savedSale) =>
        this.eventsQueue.add(
          'index-sale',
          { saleId: savedSale.id, saleData: savedSale, saleType: this.saleType },
          {
            priority: 5,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          },
        ),
      ),
    );

    return savedSales;
  } catch (error) {
    console.error('Failed to save sales', inputs, error);
    throw error;
  }
}
```

The options aren't decoration. `attempts: 3` with exponential backoff matters because `indexSale` builds a fairly heavy row — it resolves the provider, computes PSU and commission by looking up `package_version` rows, and does an agent-name lookup if the relation isn't already loaded. Any of those can briefly fail under load, and a transient failure shouldn't mean a permanently unsearchable sale. First retry at 2s, then 4s, then it gives up and the failure is at least logged loudly. `priority: 5` keeps it mid-pack: indexing should be prompt but it shouldn't jump ahead of the `emit-sale-created` events (priority 7) that drive live notifications.

One thing I deliberately did *not* do: wrap the enqueue in the same transaction as the save, or block the response on it. Indexing failure must never roll back a sale. The processor reflects the same stance — if `indexSale` throws, it logs and swallows rather than letting a bad index attempt take down sale creation:

```ts
async indexSale(sale: any, saleTypeOrProviderCode: string): Promise<void> {
  try {
    const providerCode = /* map saleType -> provider code */;
    const provider = await this.getProviderByCode(providerCode);
    if (!provider) {
      this.logger.warn(`Provider not found for code: ${providerCode}`);
      return;
    }
    const searchIndex = await this.createSearchIndexFromSale(sale, provider);
    await this.searchIndexRepository.save(searchIndex);
  } catch (error) {
    this.logger.error(`Failed to auto-index ${saleTypeOrProviderCode} sale: ${sale.id}`, error);
    // Don't throw — search indexing must not break sale creation.
  }
}
```

There's a subtle tension there with the Bull retries. The job has `attempts: 3`, but if `indexSale` swallows its own errors and returns normally, Bull thinks the job succeeded and never retries. That's intentional for the cases `indexSale` handles internally (a missing provider isn't going to get less missing on retry). The retries exist for the failures that happen *before* the swallow — queue hiccups, the processor not being ready, the row save itself throwing on a deadlock. It's a coarse split, and if I were doing it again I'd be more deliberate about which failures are retryable and which are dead-on-arrival. For now: enqueue with retries, let the genuinely transient stuff retry, let the structurally-doomed stuff log and die.

Second, the provider registration. `SearchService` and the reindex processor can only index providers whose repositories are injected. I added the missing one:

```ts
@InjectRepository(ForeverFreedomSale)
private foreverFreedomRepository: Repository<ForeverFreedomSale>,
```

and the matching `FOREVER_FREEDOM` entry in `getRepositoryForProviderCode`, plus the `FOREVER_FREEDOM_SALE -> FOREVER_FREEDOM` line in the saleType-to-provider-code map so the enqueued `saleType` resolves to a real provider at index time. Without that last mapping the job would run, fail to resolve the provider, log `Provider not found`, and return — a silent no-op that looks exactly like success in the queue dashboard.

I confirmed the fix the boring way: created a bulk batch on staging, watched the logs print `Background indexing sale ...` and `Successfully indexed sale ...` once per row, then searched for one by phone number. It came back. No manual reindex.

## When this bites

The shape of this bug is more general than one missing `queue.add`. Any time you maintain a derived store — a search index, a cache, a denormalized read model, a materialized aggregate — every write path to the source has to also feed the derived store, and the moment you have *two* write paths (single and bulk, API and importer, normal and admin-override) they will drift. One of them gets the side effect and the other forgets. The single create was the canonical path everyone tested; the bulk path was the optimization someone bolted on, and it quietly dropped the indexing because the index write wasn't part of "saving a sale" in anyone's mental model. It lived one layer up.

What hid it for so long was the reconciler. A periodic full reindex is genuinely good to have — processes restart, jobs fail their three attempts, rows get edited directly in the database during a fire drill. You want a sweep that rebuilds the truth. But a reconciler that runs often enough also masks the bug it's reconciling. The index was *eventually* consistent in the worst sense of the phrase: consistent right after someone remembered to run the sync, and quietly wrong in between. If your safety net is firing constantly and nobody notices, that's not a healthy safety net — that's a leak you've learned to live with.

The tell, in hindsight: "search is missing some records, run the resync" had become folk knowledge on the team. The day a manual fix turns into a habit is the day to go find the write path that should have made it automatic.
