---
title: "Modeling fronter vs closer and splitting the commission"
description: "A sale is two people's work. Renaming closer to fronter, adding both roles, and computing the split."
date: "2025-01-24"
updated: "2025-01-24"
kind: "deepdive"
category: "Backend"
tags: ["domain", "commissions", "typeorm"]
month: "2025-01"
repo: "backend"
author: "Sachal Chandio"
---

The schema said `closer`. The payroll spreadsheet said otherwise.

For months our sale entities had exactly one human attached: a `closer`, the agent whose name went on the order. That worked right up until I sat with the floor manager during a commission dispute. A rep had spent forty minutes warming up a customer, qualifying the address, confirming the line was serviceable, and then handed the live call to a senior rep who closed it in four minutes. Both of them expected to get paid. The database only knew about one of them.

That's the gap. In a telecom sales room the work is genuinely two jobs. The **fronter** generates and qualifies the lead. The **closer** converts it. Sometimes one person does both. Sometimes they're different people. And the commission has to follow the actual labor, not whoever happened to hit submit on the form.

## The naive version I shipped first

I'll admit the first thing I reached for was the worst idea. Add a `secondAgentId` column, nullable, and let the salary report sum it up later. Two foreign keys, no semantics. Done by lunch.

It survived about a day in code review with myself. The problem is that `agentId` and `secondAgentId` don't *mean* anything. Which one fronted? Which one closed? The split percentages are different per role, so the report would have to guess, or I'd have to smuggle the role into a third column and now I have three columns pretending to be two concepts. Naming is the design here. If I can't name the two columns after the two roles, I haven't modeled the domain — I've just made room for it.

So I threw that out and did the boring, correct thing.

## The rename, and why it was a rename and not an add

Here's the subtlety that cost me the most thought. The existing `closer` column already held the right person *most of the time* — the agent who submitted the sale was almost always the closer. So this was not "add two new fields." It was "the field we have is misnamed, and we're missing its partner."

I renamed the concept across every provider sale entity. We have one table per provider (AltaFiber, AT&T, Xfinity, plus the newer dynamic-sale path), all extending a shared `Sale` base. On each one:

```ts
// before
@ManyToOne(() => User, { nullable: false })
@JoinColumn({ name: 'closerId' })
closer: User;

// after
@ManyToOne(() => User, (user) => user.alta_fiber_sale, { nullable: false })
@JoinColumn({ name: 'agentId', foreignKeyConstraintName: 'FK_alta_fiber_sale_agentId' })
agent: User;

@ManyToOne(() => User, (user) => user.alta_fiber_sale, { nullable: true })
@JoinColumn({ name: 'fronterId', foreignKeyConstraintName: 'FK_alta_fiber_sale_fronterId' })
fronter: User;
```

Two deliberate choices in there.

First, `agent` is `nullable: false` and `fronter` is `nullable: true`. Every sale has someone who closed it — that's non-negotiable, you can't have a sale with nobody on the hook. But a fronter is optional, because plenty of sales are genuinely one person walking the whole thing from cold lead to install date. Making `fronterId` nullable is the schema encoding the sentence "a fronter may or may not exist." That nullability does real work later; it's the branch the split logic keys off.

Second — and this is the one that bites if you skip it — I named the foreign key constraints explicitly with `foreignKeyConstraintName`. TypeORM will happily auto-generate constraint names like `FK_8a3f9c2...`, a hash of the column set. The instant you rename a column, that hash changes, and `migration:generate` produces a drop-and-recreate of a constraint whose old name nobody can read. On MySQL, against a table with real data, a sloppy FK rename is how you earn a 2am page. Naming them by hand means the migration diff is legible: I can read `FK_alta_fiber_sale_fronterId` and know exactly what it touches.

I did not hand-write the migration. I let `typeorm migration:generate` produce it off an up-to-date schema, read every line, and only then ran it. (I've been burned by a stale worktree generating phantom index drift before. Generate from clean main or don't trust the diff.)

## Where the split actually lives

The roles live on the sale. The *split percentages* don't — they belong to the provider, because AT&T might pay 60/40 closer-to-fronter while Xfinity pays 50/50, and the floor manager needs to change those numbers without a deploy. So there's a separate tiny table:

```ts
@Entity('provider_commission_split')
@Index('UQ_provider_commission_split_providerCode', ['providerCode'], { unique: true })
export class ProviderCommissionSplit extends BaseEntity {
  @Column({ type: 'varchar', length: 50, unique: true })
  providerCode: string;

  @Column({ type: 'int', default: 50 })
  closerPercent: number;

  @Column({ type: 'int', default: 50 })
  fronterPercent: number;
}
```

The service that reads it caches each provider's split in Redis for fifteen minutes and lazily creates a 50/50 default the first time a provider is seen, so a brand-new provider never throws — it just splits evenly until someone configures it. `getSplit` hands back both the percentages and the convenient `0..1` fractions:

```ts
return {
  closerPercent: row.closerPercent,
  fronterPercent: row.fronterPercent,
  closer: row.closerPercent / 100,
  fronter: row.fronterPercent / 100,
};
```

The update path guards the obvious foot-guns: percentages must each be in `0..100`, can't both be zero, and must sum to exactly 100. I'd rather throw a `BadRequestException` at config time than discover at payroll time that a provider's split adds to 90 and everyone's been quietly underpaid.

## The split logic, and the three cases that matter

This is the part I rewrote three times. The whole thing reduces to one question per sale: **how many of the two roles are real people?** There are exactly three answers.

```ts
function allocate(
  fullCommission: number,
  agentId: string,          // the closer, always present
  fronterId: string | null, // optional
  split: { closer: number; fronter: number },
): Array<{ userId: string; amount: number }> {
  // Case 1: no fronter — closer takes the whole thing.
  if (!fronterId) {
    return [{ userId: agentId, amount: fullCommission }];
  }

  // Case 2: the same person fronted and closed — don't split against yourself.
  if (fronterId === agentId) {
    return [{ userId: agentId, amount: fullCommission }];
  }

  // Case 3: two distinct people — split per the provider policy.
  return [
    { userId: agentId,   amount: round2(fullCommission * split.closer) },
    { userId: fronterId, amount: round2(fullCommission * split.fronter) },
  ];
}
```

Case 2 is the one the naive version got wrong. When the same rep fronts *and* closes — which is the common case for a solo agent — you must not run them through the split. If you do, you pay them `closer% + fronter%` of the commission as two separate line items. That sums back to 100% only if your percentages are exactly complementary and your rounding is perfect, and it produces two confusing rows on their pay stub for one sale. Collapsing `fronterId === agentId` to a single full payment is correct *and* it's the right thing to show a human reading their own report. One sale, one line, full amount.

The `nullable: true` on `fronterId` is what makes Case 1 fall out for free. No fronter recorded, no split — the closer earned all of it because they did all of it.

A note on rounding, because money. I split, then round each share to cents, which means `fronter% + closer%` of a commission can be off by a penny from the original after rounding. I don't try to be clever about pennies. The closer is the residual: their share is computed as `full - fronterShare` rather than `full * closerPercent` whenever a fronter exists, so the two halves always reconstruct the exact original to the cent. Floating-point commission math that doesn't reconcile is a support ticket waiting to happen.

## Surfacing it without breaking the frontend

Last piece. The sale DTO used to expose just the closer's name. Now both roles travel out, with IDs so the Angular side can deep-link to either person's profile:

```ts
@Field(() => String) agentName: string;

@Field(() => String, { nullable: true,
  description: 'User id of the agent (for opening the agent profile).' })
agentId?: string | null;

@Field(() => String) fronterName: string;

@Field(() => String, { nullable: true,
  description: 'User id of the fronter (for opening the fronter profile).' })
fronterId?: string | null;
```

The names default to empty strings in the DTO constructor (`sale.fronter?.name || ''`) so an unfronted sale renders a blank cell instead of `null`-ing out the table row. The IDs stay nullable because a missing fronter is a real, valid state, not an error. I shipped `agentId` and `fronterId` as two separate small commits on purpose — exposing an ID on a DTO is exactly the kind of change you want to be able to revert in isolation.

## What I'd watch for

The split table is keyed by `providerCode` with a unique index, and the default is 50/50. That default is a convenience that can hide a mistake: a new provider silently pays even shares until someone notices and configures the real policy. If your business *never* runs 50/50, that default is lying to you, and you'd be better off making the split required and forcing a decision at provider-setup time. We kept the default because for us 50/50 is the genuine fallback, not a placeholder.

The other thing: this models *two* roles because that's our business. The moment someone adds a "verifier" or a team-lead override, the two-column shape stops scaling and you want a join table of `(saleId, userId, role, percent)` rows instead. I knew that when I built it and chose the two columns anyway, because a join table for a fixed two-role world is ceremony you pay for every query. The day a third role shows up, that's a real migration — and that's fine. Model the domain you have, not the one you're imagining.
