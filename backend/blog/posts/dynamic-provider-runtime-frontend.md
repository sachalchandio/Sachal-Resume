---
title: "A no-code form builder in Angular"
description: "Each carrier used to mean cloning five components and editing thirty files. So I made the form a definition the UI renders."
date: "2026-06-16"
updated: "2026-06-16"
kind: "deepdive"
category: "Architecture"
tags: ["angular", "dynamic-forms", "no-code"]
month: "2026-06"
repo: "frontend"
author: "Sachal Chandio"
---

A sales manager pinged me on a Tuesday: "We signed a new carrier, can we start logging sales for them by Friday?" I said sure. Then I opened the repo and remembered what "adding a provider" actually meant.

Five components, copied. About thirty existing files, touched. A new set of GraphQL documents written by hand. Each carrier had its own `dynamic-new-sale`, its own `dynamic-package-pitch`, its own audit form, its own statistics view — and every one of them was a near-duplicate of the carrier next to it, differing in which fields existed, which dropdown had which options, and what counted as required. The first time I onboarded a provider it took two days. The third time it still took most of a day, because the duplication had quietly drifted: provider A's sale form validated the account number, provider B's didn't, and nobody could tell me whether that was a decision or a copy-paste miss.

That's the tell. When onboarding a new instance of the same concept means editing source code, the source code is in the wrong shape. The differences between carriers aren't logic. They're data. So I moved them into data.

## The thing I built instead

Two pieces.

A **Provider Table Builder**: an admin screen where someone configures a provider's sale form visually — adds fields, picks types, sets dropdown options, writes validation, wires up dependencies between fields. It produces a JSON definition and publishes it.

A **generic runtime**: one module — `dynamic-provider` — that takes a published definition and renders the whole sale flow from it. No carrier-specific component. The provider you're looking at is whatever the route param resolved to, fed through `DynamicProviderContextService`.

The shape of a definition is boring on purpose:

```ts
interface FieldDef {
  key: string;                 // column on the sale record, e.g. 'accountNumber'
  label: string;
  type: 'text' | 'number' | 'select' | 'date' | 'boolean' | 'package';
  required: boolean;
  options?: { value: string; label: string }[];   // for select
  rules?: Rule[];              // dependency / validation rules
  order: number;
}

interface ProviderForm {
  providerId: string;
  version: number;
  status: 'draft' | 'published';
  fields: FieldDef[];
}
```

A carrier is now a row of config and an array of `FieldDef`. Adding one is a form-fill, not a pull request.

## Why a builder and not just a config file

My first instinct was the lazy one: skip the UI, let me hand-write the JSON, commit it, done. I actually shipped that version internally for one provider. It worked and I hated it within a week.

The problem isn't writing JSON. It's that the people who know what a carrier's sale form should contain are ops managers, not engineers. Hand-written config means every new provider still routes through me. I'd removed the component duplication but kept myself as the bottleneck, which is the less visible half of the same problem. The builder exists so that the person who knows the requirement can express it without knowing Angular. That's the actual win — not lines of code deleted, but a decision moved to the person who owns it.

The builder writes the same `ProviderForm` I'd have written by hand. It just also validates that I didn't give two fields the same `key`, or set a `select` with zero options, before it lets anyone publish.

## Rendering anything from a definition

The runtime is a `for` loop over sorted fields and a `switch` on `type`. The interesting part is the form itself. I build a reactive form from the definition at init and let the template follow it:

```ts
buildForm(def: ProviderForm): FormGroup {
  const group: Record<string, FormControl> = {};
  for (const f of def.fields) {
    const validators = f.required ? [Validators.required] : [];
    group[f.key] = new FormControl(null, validators);
  }
  return this.fb.group(group);
}
```

Template, trimmed to the shape:

```html
@for (field of fields(); track field.key) {
  <div class="field" [formGroup]="form">
    @switch (field.type) {
      @case ('select') {
        <mat-select [formControlName]="field.key">
          @for (opt of field.options; track opt.value) {
            <mat-option [value]="opt.value">{{ opt.label }}</mat-option>
          }
        </mat-select>
      }
      @case ('package') {
        <app-dynamic-package-pitch [providerId]="providerId()" />
      }
      @default {
        <input matInput [type]="field.type" [formControlName]="field.key" />
      }
    }
  </div>
}
```

`fields()` is a signal off the context service. Switch providers, the signal updates, the form rebuilds, the template re-renders. There is no provider B code path. There is one code path and a different definition.

## Dependency rules: REQUIRE_IF and friends

Static `Validators.required` covers the easy 80%. The 20% that made carriers feel bespoke was conditional logic. On one provider, **IMEI** is mandatory only when **device type** is `BYOD`. On another, the **promo code** field unlocks only if **plan** is one of three values. That conditional shape is exactly what used to justify a hand-written component per carrier.

So rules are data too:

```ts
interface Rule {
  when: { field: string; op: 'EQ' | 'IN' | 'TRUTHY'; value?: unknown };
  then: 'REQUIRE_IF' | 'SHOW_IF' | 'DISABLE_IF';
}
```

The runtime subscribes to the driving field's `valueChanges` and re-applies validators or visibility when it fires:

```ts
applyRules(def: ProviderForm) {
  for (const f of def.fields) {
    for (const r of f.rules ?? []) {
      const driver = this.form.get(r.when.field)!;
      driver.valueChanges
        .pipe(startWith(driver.value), takeUntilDestroyed(this.destroyRef))
        .subscribe(v => {
          const active = this.evalCondition(r.when, v);
          const control = this.form.get(f.key)!;
          if (r.then === 'REQUIRE_IF') {
            control.setValidators(active ? [Validators.required] : []);
            control.updateValueAndValidity({ emitEvent: false });
          }
          // SHOW_IF / DISABLE_IF flip a signal / call disable()
        });
    }
  }
}
```

`emitEvent: false` on `updateValueAndValidity` is load-bearing. Leave it off and a rule that re-validates a field whose `valueChanges` drives another rule will trigger that one, which re-validates the first — and you've built an infinite loop out of two innocent dropdowns. I found that out the way you'd expect: the tab froze, the profiler showed `updateValueAndValidity` calling itself a few thousand times deep, and I sat there feeling clever about my generic engine.

## The live preview that earned its keep

Builders are dangerous because the author can't see what they're shipping until a rep hits it in production. So the builder renders the *actual runtime component* next to the editor, fed the in-progress draft. Same `dynamic-provider` view the rep will use, live, updating as you drag fields around.

The part that mattered most was **package binding**. Sale forms attach a telecom package — a plan with a price and bundled options — and reps were picking wrong packages because the form didn't show what a choice implied. So the `package` field type pulls real packages for the selected provider and previews the binding inline: pick a plan, see the monthly price and what's bundled before you commit. In the builder, the admin sees that exact preview while designing, which kills a whole category of "this field is technically there but nobody understands it" feedback.

## One GraphQL document instead of N

The duplication I haven't mentioned yet lived in the data layer. Every provider had its own typed query and mutation, because each sale shape was a distinct GraphQL type, which meant `@graphql-codegen` spat out a fresh hook per carrier. New provider, new documents, regenerate, import in five places.

I collapsed that to one generic pair. The sale payload crosses the wire as a keyed bag of values rather than a fixed-column type:

```ts
const SUBMIT_DYNAMIC_SALE = gql`
  mutation SubmitDynamicSale($providerId: ID!, $values: JSON!) {
    submitDynamicSale(providerId: $providerId, values: $values) {
      id
      status
    }
  }
`;
```

The backend resolves `providerId` to the published definition, validates `values` against it server-side — because client validation is a UX nicety, never a guarantee — and writes the row. One document. One generated type. Onboarding a carrier touches zero GraphQL.

I'll be honest about the cost: I gave up compile-time type safety on the sale payload. `JSON` is a scalar; the typed `accountNumber: string` that codegen used to hand me is now `values['accountNumber']`, unchecked at build time. I traded it deliberately. The definition is the contract now, enforced at runtime on both ends, and that's the right call when the schema is genuinely dynamic — but it does mean a typo'd `key` in a definition fails as a runtime validation error, not a red squiggle. I added a Zod-style check in the builder's publish step to claw some of that back at authoring time.

## Where this bites

A few things I'd tell the next person, or my past self.

Versioning is not optional, and I learned it the hard way. A rep starts a sale against `version: 3`, an admin publishes `version: 4` that renames a field's `key`, the rep submits — and the values bag references a key that no longer exists. Now every published definition is immutable and stamped with a version; in-flight sales carry the version they started under, and the backend validates against *that* one. I didn't design that up front. I added it after a sale silently dropped a field.

The builder can express forms that are technically valid and practically nonsense — a `REQUIRE_IF` that points at a field below it in tab order, a `SHOW_IF` chain that hides the field driving it. Schema validation won't catch "this is confusing." The live preview catches most of it because the author feels the awkwardness, which is the real reason the preview is non-negotiable, not just a nicety.

And the dynamic approach is correct exactly when the variation is data and incorrect the moment it becomes logic. The day a carrier needs a genuinely novel interaction — a multi-step wizard with branching, a custom integration mid-flow — I will not contort the definition schema to express it. I'll write a real component for that one carrier and let the runtime handle the other dozen. A generic engine that tries to express everything stops being generic and starts being a worse programming language than the one I already have.

What I'd do differently from day one: build the versioning and the publish-time validation before the builder UI, not after. The rendering was the fun part and the easy part. The boring guarantees around it — immutable versions, server-side validation, a published-vs-draft boundary — are what make it safe to hand to someone who isn't an engineer. That handoff was the entire point, and Friday's carrier went live in twenty minutes.
