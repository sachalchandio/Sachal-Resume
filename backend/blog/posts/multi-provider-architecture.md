---
title: "Architecting for 27 providers without 27 codebases"
description: "A shared spine, per-provider quirks at the seams, a registry, and the move to schema-driven onboarding."
date: "2025-06-19"
updated: "2025-06-19"
kind: "deepdive"
category: "Architecture"
tags: ["architecture", "modularity", "nestjs"]
month: "2025-06"
repo: "both"
author: "Sachal Chandio"
---

Telelinkz sells service for 27 carriers. AT&T, Spectrum, Frontier, Optimum, a long tail of regional ISPs nobody outside the industry has heard of. Each one wants different fields on a sale, validates account numbers differently, has its own commission rules, its own portal an agent has to copy the order into. The product question is simple: an agent picks a provider, fills a form, the sale flows through approval and into payroll. The architecture question is the one that keeps you up: how do you support number 27 without it being the 27th place you forgot to update?

The wrong answer is one giant `if (provider === 'frontier')` ladder that metastasizes into every service. The other wrong answer is 27 polymorphic subclasses, a `FrontierSale extends Sale`, a `SpectrumSale extends Sale`, and a factory the size of a phone book. I've shipped both shapes in past lives. Both punish you the same way: a change to how *all* sales behave now touches 27 files, and a change to how *one* provider behaves leaks into the shared base because someone needed "just one hook."

What actually worked was drawing a hard line down the middle. One spine that every sale shares. The provider-specific weirdness pushed out to the edges, where it can be as ugly as it needs to be without infecting anything. Here's how that's built.

## One table, one entity, one spine

There is exactly one `sales` table and one `Sale` entity. Every provider writes to it. The columns are the things that are true of a sale no matter who the carrier is: who sold it, when, the customer, the status, the money.

```ts
@Entity('sales')
export class Sale {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column() providerId: string;        // the only thing that says "this is Frontier"
  @Column() agentId: string;
  @Column() fronterId: string | null;  // the agent who set the appointment, if any

  @Column({ type: 'enum', enum: SaleStatus, default: SaleStatus.PENDING })
  status: SaleStatus;

  @Column('json', { nullable: true })
  providerData: Record<string, unknown>; // the per-carrier fields live here

  @CreateDateColumn() createdAt: Date;
}
```

The trick is `providerData`. Frontier wants a `cafScore`. Spectrum wants a `serviceTier` and a `promoCode`. Optimum wants a drop date. None of those get their own column, because the day you add a `caf_score` column for Frontier is the day someone adds a `spectrum_tier` column, and now your `sales` table is 90 columns wide and 85 of them are null on any given row. So the shared, queryable, reportable facts are real columns. The provider's private vocabulary lives in a JSON blob keyed by provider.

This is the single most important decision in the whole thing, and it's a tradeoff I'll defend but won't pretend is free. JSON columns in MySQL are second-class. You can't put a normal index on a key inside them without generated columns, the query syntax is `JSON_EXTRACT(providerData, '$.cafScore')` which nobody enjoys, and TypeORM hands them to you as `unknown` so you're casting at every read. I accepted all of that because the alternative — a wide sparse table or a join-per-provider satellite table — was worse for *this* shape of data, where 95% of reads only ever touch the spine columns and the provider fields are mostly write-once, display-later.

## Validation belongs at the edge, not in the entity

The spine doesn't know what a valid Frontier sale looks like, and it shouldn't. The entity's job is to be a faithful row. Knowing that Frontier requires a `cafScore` between 0 and 850 is provider policy, and provider policy lives in provider-specific validators.

```ts
export interface ProviderModule {
  readonly id: string;                 // 'frontier'
  readonly label: string;              // 'Frontier Communications'
  validate(input: CreateSaleInput): ValidationResult;
  toPayload(sale: Sale): ProviderPayload; // shape for the carrier portal export
  commission(sale: Sale): Money;
}
```

Each carrier implements that interface and nothing more. Frontier's validator is allowed to be opinionated and weird because it's quarantined:

```ts
@Injectable()
export class FrontierProvider implements ProviderModule {
  readonly id = 'frontier';
  readonly label = 'Frontier Communications';

  validate(input: CreateSaleInput): ValidationResult {
    const errors: string[] = [];
    const caf = Number(input.providerData?.cafScore);
    if (!Number.isFinite(caf) || caf < 0 || caf > 850) {
      errors.push('cafScore must be between 0 and 850');
    }
    // Frontier account numbers are 13 digits, no dashes
    if (!/^\d{13}$/.test(String(input.providerData?.accountNo ?? ''))) {
      errors.push('Frontier account number must be 13 digits');
    }
    return { ok: errors.length === 0, errors };
  }
  // toPayload, commission...
}
```

When AT&T changes their account-number format next quarter — and they will, with two weeks' notice — I edit one file. `git blame` points at exactly one place. No shared validator grows a new branch. That property, "one provider change touches one file," is the whole point of the design, and it's the thing I check every time someone proposes a shortcut.

## The registry is the seam everything else reads through

Now the question is: how does the rest of the system get from a `providerId` string on a row to the right `ProviderModule`? You do *not* want `SalesService` importing `FrontierProvider`, `PayrollService` importing it again, `ExportService` a third time. That's how the `if`-ladder sneaks back in through the side door.

There's one registry. Everyone asks it.

```ts
@Injectable()
export class ProviderRegistry {
  private readonly modules = new Map<string, ProviderModule>();

  constructor(@Inject(PROVIDER_MODULES) modules: ProviderModule[]) {
    for (const m of modules) this.modules.set(m.id, m);
  }

  get(id: string): ProviderModule {
    const m = this.modules.get(id);
    if (!m) throw new UnknownProviderError(id);
    return m;
  }

  all(): ProviderModule[] {
    return [...this.modules.values()];
  }
}
```

The modules array is assembled once in the Nest module via a provider token, so wiring a new carrier is one line in one array. Every subsystem that needs provider behavior depends on `ProviderRegistry` and nothing carrier-specific:

```ts
const provider = this.registry.get(sale.providerId);
const result = provider.validate(input);   // sales
const pay = provider.commission(sale);     // payroll
const payload = provider.toPayload(sale);  // portal export
```

`SalesService`, `PayrollService`, and the export job all read through the same seam. None of them knows Frontier exists. When I add carrier 28, those three services don't change at all — which is exactly the test of whether the seam is in the right place. If adding a provider forces a change in a service that isn't the registry, the abstraction is leaking and I go find out why.

A nice side effect: the registry is also where the frontend's provider dropdown comes from. The Angular form does a GraphQL query that maps over `registry.all()` and gets back `{ id, label, fields }`. The list of providers a human can pick from is, by construction, exactly the list of providers the backend can actually process. They can't drift, because there's one source.

## Where this advice is wrong

I want to be honest about the seams of the seam, because "make a registry and an interface" is the kind of advice that sounds universally correct and isn't.

The interface only works while the providers are *variations on one workflow*. A sale is a sale; validate, price, export. The moment a carrier needs a fundamentally different lifecycle — say, one that requires a two-step provisioning callback before the sale is even real — `ProviderModule` is the wrong tool. I hit a softer version of this with providers that have a "pending serviceability check" state that others don't. I resisted adding `checkServiceability()` to the interface for a long time, because the second you put an optional method on a shared interface, 26 providers implement it as `return true` and you've got 26 lines of noise hiding the one provider that actually does something. I eventually added it, but as a *separate*, optional capability interface (`ServiceabilityCapable`) that only the two relevant providers implement, and the registry exposes a `getCapable<T>(id, guard)` lookup. Keep the core interface small; bolt optional behavior on as separate capabilities. Don't grow the base to fit the outlier.

The other place it bites: `providerData` as untyped JSON means the database will not stop you from writing garbage. The validator is the only guardrail, so if a code path creates a sale *around* the validator — a bulk import, an admin override, a migration — you get malformed blobs that explode at display time, three weeks later, in a stack trace that points at the renderer instead of the actual culprit. My rule now is that nothing constructs a `Sale.providerData` except through the provider's `validate` path. No exceptions, including the "quick" admin script. I learned that one the expensive way, debugging a `cafScore` of `"undefined"` (the string) that a one-off import had cheerfully persisted.

## The long tail wanted a schema, not a class

The first dozen providers each got a hand-written `ProviderModule` and it was fine. Then the long tail showed up — small regional ISPs where the only difference from a generic sale is "they want four extra text fields and a dropdown." Writing a full TypeScript class with a bespoke validator for a carrier that does 30 sales a month is wildly out of proportion. That's where I went schema-driven.

Instead of code, those providers are a JSON field schema, stored and editable without a deploy:

```json
{
  "id": "ripple-fiber",
  "label": "Ripple Fiber",
  "fields": [
    { "key": "accountNo", "type": "string", "required": true, "pattern": "^[A-Z]{2}\\d{6}$" },
    { "key": "installWindow", "type": "enum", "options": ["AM", "PM"], "required": true },
    { "key": "referralCode", "type": "string", "required": false }
  ]
}
```

A single generic `SchemaDrivenProvider` implements `ProviderModule` once, reads the schema, and runs the validation loop dynamically. The frontend renders the form from the same `fields` array, so a new low-volume carrier goes live by inserting one schema row — no PR, no deploy, no class. The same Angular dynamic-form component drives all of them, which is its own reward: one form renderer instead of 27.

The honest cost is that schema-driven validation can only express what the schema language can express. `pattern`, `required`, `enum`, ranges. The day a provider needs "this field is required only if that other field is `AM`," the schema starts sprouting a little rule engine, and a little rule engine always wants to become a big one. I drew the line: cross-field and conditional logic means you graduate back to a hand-written class. Schema for the boring long tail, code for anything with real rules. Knowing which side of that line a provider is on, before you start, saves you from building a DSL nobody asked for.

## What I'd tell someone starting this

The spine-and-edges split is the load-bearing idea, and everything else is consequence. A few things I'd take to the next one without re-deriving them:

- Put the discriminator (`providerId`) and the shared facts in real columns. Put the per-provider vocabulary in one JSON column. Resist the urge to promote a provider's pet field to a top-level column the first time it's convenient — that's the first crack.
- The registry is worth building on day two, even with three providers. It's the seam that stops carrier knowledge from spreading. Adding a provider should touch one array and one folder, and if it ever touches a service, treat that as a bug in the architecture, not a chore.
- Keep the shared interface ruthlessly small. Optional behavior goes on capability interfaces, not the base. Twenty-six `return true` implementations is a design smell wearing a polite disguise.
- Go schema-driven for the long tail *only*, and write down the exact rule complexity at which a provider graduates back to code. Without that line, your schema turns into a programming language with no debugger.

The measure of all of it is boring on purpose. Carrier 28 should be a quiet afternoon: one folder or one schema row, a validator, done. The day onboarding a provider is a sprint, the spine has rotted and the edges have leaked into the middle, and it's time to go find where the line got crossed.
