---
title: "Onboarding a carrier across ten subsystems with a provider registry"
description: "A new provider has to flow through commission, salary, search, QA, penalties, export and the dialer. Centralizing the wiring."
date: "2026-06-08"
updated: "2026-06-08"
kind: "deepdive"
category: "Architecture"
tags: ["registry", "nestjs", "modularity"]
month: "2026-06"
repo: "backend"
author: "Sachal Chandio"
---

The ticket said "add AltaFiber." Two words. I knew it was a lie before I opened the editor.

AltaFiber is a fiber carrier we'd just started selling, internet-only, plus a phone add-on and an order-submission method. On the surface it's another `*_sale` table next to the thirty already in MySQL. Underneath, a sale doesn't just sit in a table. It has to earn a commission, roll into a monthly salary report, show up in global search, get audited by QA, accumulate penalties when the agent botches it, export to a spreadsheet, get its PII scrubbed before that spreadsheet leaves the building, and reconcile against the dialer's call logs. Ten subsystems, give or take. Each one historically learned about a new provider by someone remembering to edit it.

So the real ticket was: wire a carrier into ten places without forgetting one, and ideally make the eleventh carrier cheaper than this one.

## What "a provider" actually means here

There's a `provider` table. It's almost embarrassingly small:

```ts
{ code: 'ALTA_FIBER', name: 'AltaFiber', isActive: true }
```

That row is the closest thing we have to a single source of truth, and for years it wasn't the source of much. The `code` is the spine everything else hangs off — `ALTA_FIBER` in some places, `ALTAFIBER` in others, and yes, that inconsistency is a tax I'll come back to. The seed file `PROVIDER_SEED_DATA` is idempotent: it diffs against existing rows by `code` and only inserts what's missing, so dropping AltaFiber into the array and running the seed is safe to re-run.

```ts
const existingCodes = new Set(existingProviders.map((p) => p.code));
const missing = PROVIDER_SEED_DATA.filter((p) => !existingCodes.has(p.code));
```

Adding the row was the easy 5%. The other 95% was teaching nine subsystems that the row exists and what it means for each of them.

## The naive version I'd inherited

Before I touched anything, the pattern across the codebase was: hardcode the provider name where you need it. Search indexing had a switch that turned a sale type into a provider code. Salary generation had a giant injected list of repositories. The export had a literal array of table names. Each of these grew by one line, by hand, every time a carrier launched — and "by hand" means "until someone forgets," which had already produced a bug where a provider's sales indexed fine but never showed revenue because the salary side didn't know the field names.

I didn't have the budget to delete all of that and rebuild it as a pristine plugin system. What I had was a recurring, expensive mistake. So the move was narrower: make each subsystem read a registry instead of inventing its own provider list, and make the registry entry the one thing you add per carrier.

## The salary registry: where the real coupling lives

The center of gravity is `saleRepositoryMap` in `SalaryGenerationProcessor`. It maps a provider code to its TypeORM repository and — this is the part that matters — the list of columns on that table that hold commissionable package references:

```ts
public readonly saleRepositoryMap = {
  // ...
  ALTA_FIBER: {
    repository: this.altaFiberSaleRepository,
    packageFields: [
      'internetPackageId',          // Internet service
      'phonePackageId',             // Phone add-on
      'submissionMethodPackageId',  // how the order was submitted
      'saleStatusPackageId',        // sale status
    ],
  },
  // ...
};
```

`packageFields` is the whole trick. Every commissionable thing on a sale is a foreign key to `package_version`, and a `package_version` carries an `rguCount` and a `commission`. So the entire commission calculation, for any provider, reduces to: read the FK columns this registry entry names, fetch those `package_version` rows, sum `rguCount` for PSU and `commission` for dollars. Spectrum has a `mobilePackageId`; AltaFiber doesn't. Mobile gets a `numberOfLines` multiplier; fiber doesn't. None of that is special-cased in the calculator — it's all data in the entry.

The payoff is that search indexing doesn't compute commission itself. It *reuses* the salary processor's map. When a sale gets indexed, the indexing service reaches into the same `saleRepositoryMap`, pulls the commissionable field IDs, and computes PSU and commission off them:

```ts
const refs = this.collectCommissionablePackageVersionRefs(sale, providerCode);
const versions = await this.packageVersionRepository.find({
  where: { id: In(refs.map((r) => r.id)) },
});
```

One definition of "what counts as money on an AltaFiber sale," consumed by both the monthly salary run and the live search index. That's the thing I actually wanted: add the entry once, two subsystems light up.

## The carrier fought back, mostly at the edges

Third parties never hand you clean data, and AltaFiber's quirks landed in places the registry didn't cover.

**The portal mapping.** AltaFiber orders go in through named sales portals, and that mapping doesn't live in `package_version` — it's a separate `provider_portal` table keyed by `providerCode` + `portalName`. So creating a sale has a resolution step that the commission path never sees:

```ts
const providerPortal = await this.providerPortalRepository.findOne({
  where: { providerCode: 'ALTAFIBER', portalName: normalizedSalesPortal, isActive: true },
});
if (!providerPortal) {
  throw new BadRequestException(
    `No active AltaFiber provider portal mapping exists for portal '${normalizedSalesPortal}'`,
  );
}
```

Note the string: `'ALTAFIBER'`, no underscore. The package lookups in the same file use `'ALTA_FIBER'`, *with* the underscore. Same carrier, two spellings, because two different tables got seeded by two different people on two different days. I left a comment and moved on, but this is exactly the kind of drift a real registry is supposed to forbid — and mine doesn't, yet. It's honest to admit the registry centralized the *behavior* and not the *naming*.

**Flaky create-time writes.** A sale create can't block on indexing, commission recompute, and the event emit. Those go on a Bull queue (`events`) with exponential backoff, because the search index row might not exist yet when PSU computation runs:

```ts
await this.eventsQueue.add('compute-psu',
  { saleId: savedSale.id, saleType: this.saleType },
  { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
);
```

The comment in the code is blunt about why: "will retry if SearchIndex isn't ready yet." That's a race between two queue jobs, and the answer is just to let it bounce and retry rather than orchestrate ordering. Cheap, and it's held up.

**Cached provider lookups going stale.** Search indexing keeps an in-memory `Map<code, Provider>` so it isn't hitting MySQL on every sale. The day AltaFiber went live, that map had been loaded at boot — before the row existed — so the first few sales logged `Provider not found for code: ALTAFIBER` and skipped indexing entirely. The fix was a lazy reload: on a cache miss, reload the map once and re-check before giving up.

```ts
if (this.providerMap.size === 0) {
  await this.loadProviders();
}
const fresh = await this.providerRepository.findOne({ where: { code: providerCode } });
```

It's a small thing, but it's the canonical new-provider bug: a long-lived process caches the world at startup and a carrier you add at 2pm doesn't exist in that snapshot.

## The dialer was its own animal

Dialer360 is the outbound system, and reconciling its call logs against our sales is where "registry" stops helping, because the dialer doesn't speak in provider codes — it speaks in disposition strings that agents pick on a call. We store those in `dialer360_disposition_mapping`, and the interesting design choice is that the mapping *discovers itself*: every sync, unseen disposition codes get inserted as `UNCLASSIFIED` with a `seenCount`, and an admin later classifies each one as `SALE`, `NON_SALE`, or leaves it.

```ts
@Column({ type: 'enum', enum: Dialer360DispositionClassification,
  default: Dialer360DispositionClassification.UNCLASSIFIED })
classification: Dialer360DispositionClassification;
```

So onboarding AltaFiber on the dialer side wasn't a registry edit at all — it was making sure the new portal's dispositions flowed into this catalog and got classified before anyone trusted the reconciliation numbers. Different shape of problem, and a good reminder that not everything wants to be a row in the same registry.

## The one that still requires a human

The PII anonymization script — the one that scrubs customer names, emails, SSNs, and order numbers before a dump leaves the database — has a literal array:

```ts
const PROVIDER_SALE_TABLES = [
  'xfinity_sale', 'atnt_sale', /* ... */ 'alta_fiber_sale', /* ... */
];
```

This is the subsystem I did *not* manage to fold into the registry, and it's the most dangerous one to forget, because forgetting means a new carrier's customer PII silently ships unredacted. For now it's a hand-maintained list with a test that asserts every `*_sale` table in the schema appears in it, so at least a missing carrier fails CI instead of leaking. The right answer is to derive the table list from entity metadata, and it's on the list. I'd rather have a loud failing test today than a quiet refactor I haven't finished.

## How I knew it worked

I don't trust "it compiles" for cross-cutting wiring. The verification was concrete: create one AltaFiber sale through the resolver, then check it landed in all the right places. The `search_index` row exists with the right `providerId` and a non-zero `psuCount`. The monthly salary run for that agent includes a commission line tagged `ALTA_FIBER` with a category of `FIBER`. The QA audit form picks it up via the same decorate step every other provider uses (`auditFormService.decorateSalesWithAuditInfo`). The penalty decorator runs. And the anonymization test stays green because `alta_fiber_sale` is in the array.

Then I deleted the test sale and watched the `removeSaleIndex` path decrement the global stats back down — sales count, PSU delta, and the commission revenue, all reversed. If the down path is wrong you get phantom revenue that never goes away, and that's the kind of bug nobody notices until month-end.

The lesson I'd hand to the next person: a "registry" is only as centralized as the *least* disciplined subsystem that consumes it. I genuinely cut the per-carrier work — commission, salary, search, and stats now key off one `saleRepositoryMap` entry. But the dialer classifies dispositions on its own clock, the portal table has its own spelling, and the anonymizer still needs a human and a guard test. The win wasn't "one place to add a provider." It was shrinking the number of places from ten to three, and making the three that remain fail loudly instead of silently. That's the version that actually ships.
