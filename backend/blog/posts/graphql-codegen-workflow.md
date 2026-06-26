---
title: "Why I let codegen write my Angular GraphQL services"
description: "Typed operations, no any casts, the schema as a contract, and a shared edit-mode helper across providers."
date: "2026-04-21"
updated: "2026-04-21"
kind: "deepdive"
category: "Frontend"
tags: ["graphql", "codegen", "angular", "typescript"]
month: "2026-04"
repo: "frontend"
author: "Sachal Chandio"
---

The bug that finally convinced me was a renamed enum. The backend changed a Starlink sale's `shipmentPartner` from a free string to a proper GraphQL enum — `FEDEX`, `UPS`, that sort of thing — and the Angular side kept compiling, kept building, kept shipping. It just silently sent the old lowercase string and the mutation rejected it at runtime, in production, in front of a rep trying to save a sale. The type system had nothing to say because I'd hand-typed the response as `any` and the variables as a local interface I'd written by hand months earlier and never touched again.

That's the whole problem in one sentence: a hand-written GraphQL call means a hand-maintained type, and a hand-maintained type drifts from the schema the moment someone changes the schema. The schema is the contract. If your client types aren't *derived* from it, they're a copy, and copies rot.

So I moved everything to `@graphql-codegen`. The thesis here is narrow and I'll defend it: for an Angular + Apollo app, you should not be writing the GraphQL plumbing by hand. Let the schema generate your operation types and your injectable services. What's left for you to write is the part that actually has judgment in it.

## What "by hand" looked like

Here's the pattern I had everywhere, lifted from the provider-form service that — at time of writing — still hasn't been migrated, which makes it a perfect before-shot:

```ts
const UPDATE_DYNAMIC_SALE = gql`
  mutation UpdateDynamicSale($input: UpdateDynamicSaleInput!) {
    updateDynamicSale(input: $input) { id providerCode orderNumber }
  }
`;

updateDynamicSaleFronter(id: string, fronterEmail: string | null) {
  return this.apollo
    .mutate<{ updateDynamicSale: { id: string } }>({
      mutation: UPDATE_DYNAMIC_SALE,
      variables: { input: { id, fronterEmail } },
    })
    .pipe(map(({ data }) => data!.updateDynamicSale));
}
```

Look at everything I'm asserting by hand. The shape of `data` — `{ updateDynamicSale: { id: string } }` — I typed that. The shape of `input` is whatever object literal I happen to pass; nothing checks it against `UpdateDynamicSaleInput`. The `data!` non-null assertion is me promising TypeScript something I haven't actually verified. And the `gql` string is a free-form template that the compiler treats as opaque text. If I typo a field name, or the server drops `orderNumber`, I find out when a customer does.

The file even has a comment on it admitting the debt: *"Uses gql tags + local interfaces so it does NOT depend on codegen. Run codegen later to migrate to typed documents if desired."* That "if desired" aged badly. It's always desired.

## The setup is three plugins and a schema path

The config is boring, which is the point. `codegen.yml` and a tiny runner:

```yml
overwrite: true
schema: 'http://localhost:3000/graphql'
documents: 'src/**/*.graphql'
generates:
  src/generated/graphqlTypes.ts:
    plugins:
      - 'typescript'
      - 'typescript-operations'
      - 'typescript-apollo-angular'
```

Three plugins, layered. `typescript` emits the schema's scalars, enums, and input types — this is where `UsState`, `ShipmentPartner`, and `UpdateStarlinkSaleInput` come from. `typescript-operations` reads my `.graphql` documents and emits the exact shape each query and mutation returns. `typescript-apollo-angular` is the one that earns its keep: for every operation it generates an `@Injectable` service extending `Apollo.Mutation` or `Apollo.Query`, fully parameterized.

One detail worth stealing. I don't point codegen at the running server in CI — I point the local runner at the committed schema file the backend exports:

```js
// generate.js — schema from disk, not a live endpoint
const schema = process.env.GRAPHQL_SCHEMA || '../telelinkz-backend/schema.gql';
await generate({ schema, documents: 'src/**/*.graphql', generates: { /* … */ } }, true);
```

Generating against a live `localhost:3000` is fine on your machine and miserable everywhere else — it means codegen can't run unless the API is up, which couples your frontend build to a backend boot. Reading `schema.gql` off disk means codegen is a pure function of two files you can both commit. The backend regenerates that file; the frontend regenerates its types from it. Two repos, one contract, no network in the loop.

## The after: inject the operation, get the types for free

Here's the same Starlink update from the actual edit form, the new way. The component injects a generated service in its constructor:

```ts
constructor(
  private updateStarlinkSaleGQL: UpdateStarlinkSaleGQL,
  // …
) {}
```

and calls it:

```ts
this.updateStarlinkSaleGQL
  .mutate({ variables: { input } })
  .subscribe({
    next: (res) => { /* res.data!.updateStarlinkSale is fully typed */ },
    error: (error) => {
      const msg = error?.graphQLErrors?.[0]?.message ?? 'Failed to update sale.';
      this.snackBar.open(msg, 'Close', { duration: 4000 });
    },
  });
```

No `gql` string in the component. No response interface. `input` is checked against the generated `UpdateStarlinkSaleInput`, so the enum problem from the top of this post is now a red squiggle the instant the schema changes:

```ts
export type UpdateStarlinkSaleInput = {
  id: Scalars['String']['input'];
  state?: InputMaybe<UsState>;          // not 'string'
  shipmentPartner?: InputMaybe<ShipmentPartner>;
  shipmentStatus?: InputMaybe<ShipmentStatus>;
  zipcode?: InputMaybe<Scalars['String']['input']>;
  // … every field, exactly as the backend declares it
};
```

`res.data` is typed too, down to the nullable `fronter` object I asked for in the document. The `any` cast that hid the original bug has nowhere left to live. When the backend renamed that enum, the next `npm run generate` regenerated `ShipmentPartner`, and `tsc` lit up every call site that passed the old string. That's the entire value proposition: schema drift becomes a compile error instead of a support ticket.

## Where it actually paid off: the per-provider edit forms

Telelinkz has a pile of providers — Starlink, Forever Freedom, AltaFiber, and a long tail more — and early on each one got its own bespoke mutation. `CreateForeverFreedomSale`, `UpdateStarlinkSale`, each with its own field list, each wired into its own edit form with its own hand-rolled `mutate<{...}>()` call and its own response interface. Every new provider was a copy-paste-and-pray of the last one's glue. The forms weren't even the hard part; the *plumbing around* the forms was, and it was duplicated N times.

Codegen didn't magically unify the mutations — they're genuinely different operations against different backend types. What it did was make the per-provider service layer disappear. Each provider's `.graphql` document generates its own `XGQL` service; the component injects exactly the one it needs; the variables and response come pre-typed off that document. There's no longer a hand-written service file per provider to keep in sync. The document *is* the source.

That cleared the runway for the real fix, which was schema-driven forms. The dynamic provider builder lets an admin define a provider's fields as data, and a single edit component renders and submits any of them through one `UpdateDynamicSale` mutation. One helper, driven by the form definition, replacing what used to be a folder of near-identical edit components. The codegen migration was the unglamorous prerequisite — once the typed operations existed, the per-provider boilerplate was thin enough to delete and replace with one thing.

## When this advice is wrong

I don't want to oversell it. A few honest edges.

If you have a handful of operations and a stable schema, codegen is ceremony you don't need. The build-step indirection, the generated file in your diff, the "did you re-run generate?" ritual — that overhead only pays back when the schema moves often or the surface is large. Telelinkz is both; a small dashboard might be neither.

The generated file is a real artifact you have to manage. Ours is north of 56,000 lines. Some teams gitignore it and regenerate in CI; I commit it, because a typed file that isn't in the repo can't make a PR diff scream when a field changes, and that scream is half the point. Pick one deliberately. The worst outcome is a stale committed file nobody regenerates — then your "types" are lying with extra confidence.

Codegen also won't save you from a server that doesn't honor its own schema. If the backend declares a field non-null and returns null anyway, the generated type says non-null and your code trusts it. The contract is only as good as the side that issues it. I've been bitten by exactly that, and the fix is on the server, not the client.

And it leaks at the edges, like every code generator. The plugin's idea of a nullable nested object — `fronter?: { … } | null` — pushes optional chaining through your component whether you find that pleasant or not. You take the generator's opinions with its types.

## Rules of thumb I'd actually repeat

Generate from a committed schema file, never a live endpoint, so the build doesn't depend on a server being up.

Commit the generated output and read the diff. A changed field should show up in a PR as a changed type, not as a runtime surprise three sprints later.

Treat any remaining `gql` string or `mutate<{...}>()` cast in a component as a TODO, not a style. Those are the spots where drift gets back in.

When you find yourself writing the third hand-typed service for the third near-identical thing — three providers, three reports, three of anything — that's not a codegen task, it's the signal to make the thing data-driven. Codegen just makes the floor low enough that you can see the duplication clearly and go delete it.

The enum that started all this still ships fine, by the way. The difference is that the next time someone renames it, I'll hear about it from `tsc` on my machine, not from a rep who couldn't save a sale.
