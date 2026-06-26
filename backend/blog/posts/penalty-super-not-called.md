---
title: "‘super wasn't being called’: a TypeScript inheritance trap in the penalty system"
description: "Child constructors that skip super() silently break the base class. How it surfaced and the fix."
date: "2026-04-18"
updated: "2026-04-18"
kind: "deepdive"
category: "Backend"
tags: ["typescript", "nestjs", "inheritance"]
month: "2026-04"
repo: "backend"
author: "Sachal Chandio"
---

QA flagged a Spectrum sale, an admin approved a 50% penalty on it, and the sale grid still showed full commission. No badge, no strikethrough, no deduction. The penalty row was sitting in the database with `approvalStatus = 'APPROVED'` and a real `deductionAmount`. The frontend just never heard about it.

I'd built this whole feature the week before. Four penalty levels — 25, 50, 75, 100 percent — that cut a slice off the agent's commission when QA catches something. The math was tested. The approval flow was tested. And yet `isPenalized` was coming back `false` for a sale I could see was penalized.

## First guess: blame the cache

My first instinct was the Redis layer, because it usually is. `getPenalizedSaleIds` caches per-sale penalty info for two minutes, keyed `sale-penalty:<saleId>`, and on a miss it stores `'0'` to mean "not penalized." If a sale got cached as `'0'` before its penalty was approved, you'd see exactly this: a real penalty in the DB, a stale `'0'` in Redis, and a UI that believes the cache.

That theory has a clean fix — I invalidate on approve — so I checked `approvePenalty`. It calls `invalidateCache(penalty.saleId)`, which does a `DEL` on the key. Fine. I flushed the key by hand anyway to rule it out:

```bash
redis-cli DEL "sale-penalty:9f2c...e1"
```

Reloaded. Still full commission. So it wasn't a stale cache — the DB-backed path was running fresh and *still* returning nothing useful. Wrong tree.

## The number that gave it away

The tell was in the GraphQL response, not the logs. I queried the Spectrum grid directly and looked at the penalty fields on one sale:

```json
{
  "id": "9f2c...e1",
  "agentName": "…",
  "isPenalized": null,
  "penaltyLevel": null,
  "penaltyDeductionPercent": null,
  "penaltyDeductionAmount": null
}
```

Every penalty field was `null`. Not `false` — `null`. That distinction matters. `isPenalized` is a boolean field, and the code that fills it in does `sale.isPenalized = !!info`, which can only ever produce `true` or `false`. There is no path through `decorateSalesWithPenaltyInfo` that leaves it `null`. So either the decorator never ran on this object, or whatever it ran on wasn't the object being serialized.

Those fields don't live on the Spectrum DTO directly. They live on a shared base class, `PenalizedSaleMetadataDto`, that every provider DTO extends — Spectrum, AT&T, Frontier, Optimum, thirty-something of them. The decorator writes to that base shape:

```ts
async decorateSalesWithPenaltyInfo<T extends PenalizableSaleRecord>(sales: T[]): Promise<T[]> {
  const saleIds = sales.map((sale) => sale.id).filter(Boolean);
  const penaltyMap = await this.getPenalizedSaleIds(saleIds);

  for (const sale of sales) {
    const info = penaltyMap.get(sale.id);
    sale.isPenalized = !!info;
    sale.penaltyLevel = info?.penaltyLevel ?? null;
    sale.penaltyDeductionPercent =
      info?.deductionPercent != null ? Math.round(info.deductionPercent * 100) : null;
    sale.penaltyDeductionAmount = info?.deductionAmount ?? null;
    // …more fields
  }
  return sales;
}
```

If that loop had touched the object, `isPenalized` would be `false` at worst. It was `null`. So I went and looked at how a `SpectrumSaleDTO` actually gets constructed.

## Root cause: the constructor that skipped super()

Here's the thing about extending a class in TypeScript when the base declares fields. The base's field declarations don't materialize on `this` by magic. They get applied when the base constructor runs. If your subclass declares its own constructor and never calls `super()`, the base constructor never runs — and with `useDefineForClassFields` on (the default under modern `target`), the base's declared fields get *defined* on the instance as `undefined`, overwriting nothing useful and certainly not running any setup.

The Spectrum DTO had a constructor that did its own `Object.assign` from the entity and — this is the part I'd missed in review — didn't call `super()` at all:

```ts
// before
@ObjectType()
export class SpectrumSaleDTO extends PenalizedSaleMetadataDto {
  // …40 @Field declarations…

  constructor(sale: SpectrumSale) {
    Object.assign(this, {
      ...sale,
      createdAt: sale.createdAt,
      agentName: sale.agent?.name || '',
      fronterName: sale.fronter?.name || '',
      orderDate: sale.orderDate || '',
    });
  }
}
```

In plain JavaScript this is a hard `ReferenceError` — you can't touch `this` in a derived constructor before `super()`. TypeScript should have caught it too; `error TS2377: Constructors for derived classes must contain a 'super' call` is a real diagnostic. But the DTO files were sitting under a relaxed corner of the tsconfig, and the way this code ran, `this` was reachable enough that the `Object.assign` "worked" — it copied the entity fields on — while the base's metadata fields were never initialized to anything.

So the decorator was doing its job. It assigned `isPenalized = false` to the right object. Then the resolver returned a freshly constructed `SpectrumSaleDTO` for serialization, and *that* object — a different instance, never run through the decorator, with a base half that was never wired up — is what GraphQL serialized. Null all the way down.

That's the trap. A missing `super()` doesn't always blow up loudly. Depending on your compile target and field settings it can fail quietly, leaving you with an object that is "mostly" the class you asked for, missing exactly the half it inherited.

## The fix

One line, in principle:

```ts
// after
constructor(sale: SpectrumSale) {
  super();
  Object.assign(this, {
    ...sale,
    createdAt: sale.createdAt,
    agentName: sale.agent?.name || '',
    fronterName: sale.fronter?.name || '',
    orderDate: sale.orderDate || '',
  });
}
```

`super()` first, then the assign. Note the order — `super()` has to come before any use of `this`, and since `Object.assign(this, …)` touches `this`, doing it the other way around is its own bug. With the base constructor running, the inherited penalty fields exist on the instance as real (undefined-but-declared) properties, the decorator's writes land on the object that gets serialized, and `isPenalized` comes back `false` for clean sales and `true` for penalized ones.

It wasn't actually one line, because it wasn't actually one DTO. The same pattern was copy-pasted across every provider's DTO — each one a hand-written constructor doing the same `Object.assign`. Most of them *did* call `super()`, which is why penalties worked for other providers and made the Spectrum-only failure look like a data problem instead of a code problem. I went through all of them. A couple more were missing the call.

To stop it coming back, I added a tiny test that constructs each DTO from a stub entity and asserts the base contract is present:

```ts
it('initializes the penalty base contract', () => {
  const dto = new SpectrumSaleDTO(stubSpectrumSale());
  // the base declares this; it must exist as a property after construction
  expect('isPenalized' in dto).toBe(true);
});
```

`in` rather than a value check, deliberately — at construction time these are `undefined`; what I care about is whether the base constructor ran at all. A missing `super()` makes the property absent, and `'isPenalized' in dto` goes `false`.

## What the penalty actually computes, for the curious

Once the plumbing was fixed, the feature did what it was supposed to. The levels map to a fraction of commission, not gross:

```ts
export const PENALTY_LEVEL_PERCENT: Record<PenaltyLevel, number> = {
  [PenaltyLevel.LEVEL_25]: 0.25,
  [PenaltyLevel.LEVEL_50]: 0.5,
  [PenaltyLevel.LEVEL_75]: 0.75,
  [PenaltyLevel.LEVEL_100]: 1.0,
};

private calculateDeductionAmount(commissionValue: unknown, level: PenaltyLevel): number | null {
  const commission = this.normalizeNumericValue(commissionValue);
  if (commission === null) return null;
  return Number((commission * (PENALTY_LEVEL_PERCENT[level] ?? 1)).toFixed(2));
}
```

Cutting from commission rather than the gross sale value is a deliberate call. The gross is whatever the customer signed up for; commission is what we'd pay the agent. A 50% penalty should halve the agent's pay on that sale, not invent a number off a figure they never see. And only *approved* penalties decorate the grid — `getPenalizedSaleIds` filters on `approvalStatus = 'APPROVED'`, so a pending penalty a QA rep just filed doesn't silently dock anyone until an admin signs off.

## When this bites you

It bites when a base class carries state and the subclass writes its own constructor. The risk scales with how quietly your toolchain treats a missing `super()`. Under strict settings and a JS runtime, you get a loud `ReferenceError` and you fix it in thirty seconds. Under a looser tsconfig with the field semantics that let `this` survive, you get an object that's three-quarters initialized and a bug that looks like bad data two layers downstream — in a serializer, in a cache, anywhere but the constructor.

Two things I'd do differently from the start. Don't hand-roll the same constructor across thirty-plus DTOs; if every provider DTO needs the same base-mapping, that's a sign the mapping belongs in the base, or in a factory, where `super()` happens exactly once and can't be forgotten. And when a field comes back `null` that your code can only ever set to `true` or `false`, don't go hunting in the cache. That `null` is telling you the code never ran on the object you're looking at. Trust the type.
