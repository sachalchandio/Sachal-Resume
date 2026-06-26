---
title: "Schema-driven edit forms via GraphQL codegen"
description: "Hand-wiring an edit form per provider doesn't scale. Generating typed operations and hydrating from the schema."
date: "2026-04-08"
updated: "2026-04-08"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "graphql", "codegen", "forms"]
month: "2026-04"
repo: "frontend"
author: "Sachal Chandio"
---

A sale could be created. It could not be edited. Someone fat-fingers an order number on a Spectrum sale, and the only fix was to delete the record and re-enter the whole thing from a blank form. Thirty fields, retyped, because one of them was wrong.

We have something like thirty provider modules. Xfinity, Spectrum, Frontier, Optimum, AltaFiber, BlazingHog, and a long tail of smaller carriers. Each one has its own `new-sale` component with its own field set, because the providers genuinely differ: Spectrum tracks a `workOrderNumber` and `tpvNumber`, Starlink tracks a separate shipping address and a `shipmentTrackingNumber`, ForeverFreedom asks whether the roof is shaded. There is no universal sale shape. So "add edit mode" wasn't one change. It was potentially thirty.

## The naive version, and why it scares me

The obvious move is to open each provider component, write a `getXfinitySaleById`, write an `updateXfinitySale`, hand-roll a fetch in `ngOnInit`, and copy a block of `this.input.cx_firstName = sale.cx_firstName` for every field. Multiply by the field count, multiply by thirty providers.

I started down that road for exactly one provider before I stopped. The hand-mapping is where the bugs live. You forget `phoneNumber_second`. You copy `installationDate` straight across and the form date input renders nothing because the backend handed you a full MySQL timestamp and `<input type="date">` wants `YYYY-MM-DD`. You map a field that no longer exists on that provider and TypeScript says nothing, because everything was typed as `any` at the Apollo boundary anyway. Then you do it twenty-nine more times, and each copy is a fresh chance to drift.

Two things had to be true for this to be sane. The queries and mutations had to be typed, so the compiler catches a field that doesn't belong on a provider. And the data-to-form copy had to be one function, shared, not thirty bespoke copies.

## Step one: write the operations as documents, let codegen do the rest

The project already runs `@graphql-codegen` with the Apollo Angular plugin. The config is small:

```yaml
overwrite: true
schema: "http://localhost:3000/graphql"
documents:
  "src/**/*.graphql"
generates:
  src/generated/graphqlTypes.ts:
    plugins:
      - "typescript"
      - "typescript-operations"
      - "typescript-apollo-angular"
```

It points at the running NestJS server's schema and at every `.graphql` document under `src`. So I don't write TypeScript types for sales by hand. I write the query and the mutation as GraphQL, and codegen emits the typed `Document` constants, the `Query`/`Mutation` result types, and the `Variables` types.

The get-by-id queries went into one file, one per provider. They are deliberately boring:

```graphql
query GetXfinitySaleById($id: String!) {
  getXfinitySaleById(id: $id) {
    id
    orderDate
    cx_firstName
    cx_lastName
    orderNumber
    installationDate
    installationTime
    streetAddress
    streetAddressLine2
    city
    state
    zipcode
    phoneNumber
    phoneNumber_second
    email
    product
    packageSold
    saleStatus
    providerPortalId
    providerPortal {
      portalName
    }
    fronter {
      name
      email
    }
  }
}
```

Note what's in the selection set beyond the flat fields: `providerPortal { portalName }` and `fronter { name email }`. Those are relations. The form doesn't bind to them directly — it binds to a `providerPortalId` string and a fronter email — but I need their human-readable values to rehydrate the dropdown and the agent autocomplete. Keep that detail in your head; it bites later.

The update mutations went into a second file, again one per provider, each returning the fields it actually owns:

```graphql
mutation UpdateXfinitySale($input: UpdateXfinitySaleInput!) {
  updateXfinitySale(input: $input) {
    id
    orderDate
    agent {
      id
    }
    cx_firstName
    cx_lastName
    orderNumber
    # ... the rest of this provider's fields
  }
}
```

On the backend side that meant a `getXfinitySaleById` query resolver and an `updateXfinitySale` mutation taking an `UpdateXfinitySaleInput` per provider — partial versions of the create inputs with an `id`. Tedious, but mechanical, and once the resolver exists the schema introspection feeds codegen automatically.

Then:

```bash
npm run codegen
```

Out comes `GetXfinitySaleByIdDocument`, `UpdateXfinitySaleDocument`, `CreateXfinitySaleInput`, `UpdateXfinitySaleInput`, and friends, all in `src/generated/graphqlTypes.ts`. Now the editor knows that `UpdateSpectrumSaleInput` has a `tpvNumber` and `UpdateXfinitySaleInput` does not. That's the safety net I wanted before touching thirty components.

## Step two: one hydration helper, not thirty copy blocks

The part I actually care about is the data-to-form copy. Every provider's create form is backed by a plain input object — `altafiberSaleInput`, `xfinitySaleInput`, whatever — already shaped exactly like the create input. So hydration is: take the fetched sale, and for every key the form's input object already has, copy the value across. Ignore everything else.

That generalizes cleanly, so it became a generic in a shared `edit-mode.helpers.ts`:

```ts
export function hydrateMatchingInputFields<T extends Record<string, any>>(
  template: T,
  sale: Record<string, any>,
): T {
  const hydrated = Object.keys(template).reduce((acc, key) => {
    const saleValue = sale[key];

    if (
      saleValue === undefined ||
      saleValue === null ||
      typeof saleValue === 'object'
    ) {
      return acc;
    }

    acc[key as keyof T] = saleValue;
    return acc;
  }, {} as Partial<T>);

  return { ...template, ...hydrated };
}
```

The `template` is the form's input object, which doubles as the allowlist of fields to copy. If the form doesn't have a key, we don't touch it. That `typeof saleValue === 'object'` guard is deliberate — it's what skips `providerPortal` and `fronter`. Those nested relations don't belong in the flat input; they get unpacked by hand right after, because a `providerPortalId` string and a fronter email are derived from them, not copied from them.

The same file holds the small, finicky converters that keep tripping people up:

```ts
export function toDateInputValue(value?: string | null): string {
  if (!value) return '';

  const normalized = value.trim();
  const directMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) return directMatch[1];

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return normalized.split('T')[0] ?? normalized;
  }
  return date.toISOString().split('T')[0];
}

export function toTimeInputValue(value?: string | null): string {
  if (!value) return '';
  return value.length >= 5 ? value.slice(0, 5) : value;
}
```

`toDateInputValue` exists because the backend hands back values in a few shapes — a clean `2026-04-08`, a full ISO timestamp, sometimes a MySQL `DATETIME` string — and a native date input wants exactly `YYYY-MM-DD`. The regex shortcut at the top is there so a value that's already correct never gets dragged through `new Date()`, which would shove it into the browser's timezone and occasionally hand back yesterday.

## Step three: wire each provider with the same six lines

With the helper in place, every provider's edit path collapses to the same shape. Here's AltaFiber, which is representative. The component knows it's in edit mode because it was opened as a dialog with `{ mode: 'edit', saleId, fronterName }`:

```ts
private loadSaleForEdit(): void {
  if (!this.editingSaleId) return;

  this.isLoadingSale = true;
  this.apollo
    .query({
      query: GetAltaFiberSaleByIdDocument,
      variables: { id: this.editingSaleId },
      fetchPolicy: 'network-only',
    })
    .subscribe({
      next: ({ data }) => {
        this.isLoadingSale = false;
        const sale = (data as any)?.getAltaFiberSaleById;
        if (!sale) { /* show "not found" snackbar, bail */ return; }

        this.altafiberSaleInput = hydrateMatchingInputFields(
          this.altafiberSaleInput,
          sale,
        );
        this.altafiberSaleInput.orderDate = toDateInputValue(sale.orderDate);
        this.altafiberSaleInput.installationDate = toDateInputValue(sale.installationDate);
        this.altafiberSaleInput.installationTime = toTimeInputValue(sale.installationTime);
        this.altafiberSaleInput.fronterEmail = sale.fronter?.email ?? '';
        this.providerPortal = sale.providerPortal?.portalName ?? '';
        this.providerPortalUserId = sale.providerPortalId ?? '';
        this.editingFronterName = sale.fronter?.name ?? this.editingFronterName;
        this.editingFronterEmail = sale.fronter?.email ?? '';

        if (this.providerPortal) {
          this.loadProviderPortalUserIds(this.providerPortal);
        }
        this.syncFronterSelection();
      },
      error: (error) => { this.isLoadingSale = false; this.snackService.gqlError(error, '...'); },
    });
}
```

`hydrateMatchingInputFields` does the bulk copy. The four lines under it handle exactly the fields that don't survive a naive copy: the two dates, the time, and the relations the `object` guard skipped. That's the whole pattern. Per provider it's the get-by-id document name, the `getXxxSaleById` accessor, and the input object name. Everything else is shared.

`fetchPolicy: 'network-only'` is not optional here. The same Spectrum sale may already sit in the Apollo cache from a list view, with a thinner selection set than the edit form needs. Default cache-first would return that partial object and the form would hydrate with holes. Edit always reads fresh.

Saving is the mirror image. `onSubmit` branches on `editMode`: if we're editing, skip the fronter-confirmation dialog and the localStorage draft logic that the create path runs, and call the update mutation with `{ id, ...buildInput() }`. On success the dialog closes with `{ updated: true }` so the parent list knows to refetch.

## The sharp edges

**Enum casing drift.** This one cost me an afternoon. The create defaults used title-cased sentinels like `installation: 'Undetermined'` and `saleStatus: 'Undetermined'`, but elsewhere the same fields default to the screaming `'UNDETERMINED'`. When you hydrate a real sale, whatever string the DB holds lands in the input verbatim — fine. But on a field the saved sale left blank, the form falls back to its default sentinel, and if that sentinel's casing doesn't match the option the `<select>` actually renders, the dropdown shows empty even though a value is "set." The fix was boring consistency, but the lesson is that hydration surfaces every casing inconsistency you'd been getting away with on create-only forms.

**The relations the guard drops.** The `typeof saleValue === 'object'` skip is correct, but it's silent. If you ever add a field whose value is legitimately an object and expect it to flow through `hydrateMatchingInputFields`, it won't, and nothing warns you. I'd rather that than have the function flatten a `providerPortal` object onto a string field, but it's a trap worth a comment. I left one.

**The autocomplete fights you back.** Setting the fronter wasn't a field copy — it's a Material autocomplete bound to a `FormControl`, and the agent list loads asynchronously, so at hydration time the matching agent object might not exist yet. `syncFronterSelection` resolves the fronter against whatever agents are loaded, and re-runs once they arrive. Critically it sets the control with `{ emitEvent: false }`. Without that, programmatically seeding the value fires `valueChanges`, which the create path treats as user input and writes a draft to localStorage — so opening an edit dialog would quietly stomp the agent's in-progress new sale. Seeding state into reactive forms always needs `emitEvent: false`; I relearn this roughly once a quarter.

**`as any` at the Apollo boundary.** I typed the documents but still reach in with `(data as any)?.getAltaFiberSaleById`. The codegen result types are a discriminated shape and pulling the named field out cleanly takes more ceremony than it earns at the call site. The win was never the read here — it's that `UpdateAltaFiberSaleInput` is typed on the way *out*, so the mutation can't be built with a field that provider doesn't have. The dangerous direction is guarded. The read is just plumbing.

## What I'd do differently

The repetition didn't fully die — it moved. There's still one `loadSaleForEdit` per provider, and they're 95% identical. If I did it again I'd push that into a tiny base class or a function that takes the document, the accessor key, and the input object, so a new provider's edit mode is genuinely one registration instead of a copy-pasted method. I didn't, because thirty near-identical-but-not-quite methods were easy to review one at a time and I wanted each provider's date/relation quirks visible at its own call site rather than buried behind an abstraction. That was the right call for shipping it. It will be the wrong call the day someone changes the loading-state convention and has to edit thirty methods to do it.

The real win was upstream of any of this. The moment the operations became typed documents and the copy became one generic, "add edit to every provider" stopped being thirty engineering problems and became one problem applied thirty times. That's the difference between a feature you can finish and a feature that finishes you.
