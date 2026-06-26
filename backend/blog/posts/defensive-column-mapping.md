---
title: "Defensive column mapping in a multi-tenant schema"
description: "Exclusion lists, exact-then-legacy matching, and why fuzzy column lookups are a footgun at scale."
date: "2025-11-02"
updated: "2025-11-02"
kind: "deepdive"
category: "Backend"
tags: ["schema", "typeorm", "defensive"]
month: "2025-11"
repo: "backend"
author: "Sachal Chandio"
---

Here's the thesis, up front: any time you map a generic concept like "the phone line of business" onto 27 provider tables whose column names nobody coordinated, a fuzzy matcher will eventually grab the wrong column — and it will do it silently, with data that looks plausible, weeks after the change that caused it. The defense isn't a smarter match. It's a denylist, a strict matching order, and schema introspection you can actually trust. That's the whole recipe, and the rest of this post is why each part is load-bearing.

Telelinkz grew the way these systems always grow. Each telecom provider started as its own table — `spectrum_sale`, `cox_sale`, `ziply_sale`, `atnt_sale`, and a couple dozen more — every one with its own column shape, written by whoever onboarded that provider that quarter. Later we consolidated new providers onto a shared `dynamic_sale` table. But the legacy tables stayed, because they hold real historical sales and you don't get to delete those. So now I have a status-counts report that has to `UNION ALL` across all of them, normalize wildly different schemas into one `SaleDTO`, and answer a deceptively simple question per row: does this sale have an internet line? a TV line? a phone line? a mobile line?

The DTO is clean. The schema underneath it is not.

```ts
// what the report promises
internet?: string | null;
tv?: string | null;
phone?: string | null;
mobile?: string | null;
```

## Why a generic mapper at all

The obvious objection is: don't map dynamically, just hardcode the column per table. I tried that. It's a `switch` with 27 cases and four lines of business each, and every new provider means editing it, and the cases drift out of sync with the actual schema the moment someone runs a migration you didn't write. A hardcoded map is correct exactly until it isn't, and when it's wrong it's wrong loudly in code review — which sounds good until you realize nobody reviews the 28th case as carefully as the first.

So I went the other way: read the column metadata at runtime and resolve each line of business by name. TypeORM hands you the schema for free. Every entity's metadata carries a `columns` array, and each column has both `databaseName` (the real MySQL column) and `propertyName` (the TS field). You can pull it straight off the DataSource:

```ts
const meta = this.dataSource.getMetadata(SpectrumSale);
const cols = meta.columns.map((c) => ({
  db: c.databaseName,
  prop: c.propertyName,
}));
// => [{ db: 'phoneNumber', prop: 'phoneNumber' },
//     { db: 'phonePkgVersionId', prop: 'phonePkgVersionId' }, ... ]
```

This is the introspection layer, and it's the one part of the recipe I trust completely — because it comes from the same metadata TypeORM uses to build queries. It can't drift from the schema; it *is* the schema. Every clever idea that follows is downstream of this being a source of truth and not a guess.

## The footgun, concretely

For the phone line I want a column like `phonePkgVersionId` (an FK to a package version) or, on the oldest tables, a plain label column literally named `phone`. The naive resolver matched on a substring: find the first column whose lowercased name `includes('phone')`.

You already know what's wrong. Every one of these tables inherits the customer contact columns from a shared base entity — `phoneNumber` and `phoneNumber_second`, the customer's actual ten-digit number, `NOT NULL`, indexed. And `'phonenumber'.includes('phone')` is `true`. So the matcher walks the column list, hits `phoneNumber` first, and resolves the *phone line of business* to the *customer's phone number*. Every sale has a customer phone number. So every sale counted as a phone sale, and the value being rolled up was someone's cell, not a package.

The part that makes this a footgun and not just a bug: it depends on column declaration order. `pickColumn` returns the first match, and TypeORM's `columns` array follows declaration order. On most tables the real `phone` column happened to be declared before the inherited contact columns, so the bug was masked. It only surfaced when one entity got its fields reordered. The reorder didn't introduce anything — it stopped hiding what was always there. A heuristic that's correct only because of accidental column order isn't a heuristic; it's a landmine with good manners.

## Part one: the denylist comes first

The instinct is to make the match smarter. Wrong instinct. The fix is to make a short list of columns that are *never* the answer and remove them from consideration entirely, before any matching logic runs.

```ts
// Inherited by EVERY sale table. None of these is ever a line-of-business
// column, no matter what token you're resolving. Excluded at every tier.
const ALWAYS_EXCLUDE = [
  'phonenumber', 'phone_number',
  'phonenumber_second', 'phone_number_second',
  'phone2', 'secondaryphone',
];
```

I keep these as substring checks even though my real matching is exact, and that asymmetry is deliberate. If a provider ever ships a `customerPhoneNumber` or a `phoneNumberRaw`, I want it swept up too. The contact columns are the one thing I'm willing to be aggressive about, because the cost of a false exclude here is exactly zero — none of them is ever a real LOB column — while the cost of a false include is a wrong report that nobody catches because it looks right.

Write the denylist before you write the matcher. In a schema with both a *phone number* and a *phone line of business*, the collision isn't a risk you're managing — it's a guarantee you're designing around. The columns that must never match are shorter to enumerate than the rules for the ones that should.

## Part two: exact match before legacy patterns

With the contact columns gone, you still have to pick among the legitimate candidates, and "first column containing the token" is too loose. `phone`, `phone_legacy`, `phonePort`, `phonePkgVersionId` — a bare contains-match treats all of them as equal and hands the win to whichever was declared first. Same landmine, smaller blast radius.

So I tier the match. Exact name first, then the explicit legacy variant, and only then the loose contains-match — with the denylist honored at every tier.

```ts
function pickLobColumn(
  cols: { db: string; prop: string }[],
  tokens: string[],          // e.g. ['phone']
  exclude: string[] = [],    // per-LOB exclusions on top of ALWAYS_EXCLUDE
): string | null {
  const norm = (s: string) => s.toLowerCase();
  const want = tokens.map(norm);

  const blocked = (name: string) =>
    ALWAYS_EXCLUDE.some((t) => name.includes(t)) ||
    exclude.some((t) => name.includes(t));

  // Tier 1: exact name, or the explicit `_legacy` rename.
  for (const c of cols) {
    const name = norm(c.db || c.prop);
    if (blocked(name)) continue;
    for (const t of want) {
      if (name === t) return c.db;
      if (name === `${t}_legacy` || name.endsWith(`${t}_legacy`)) return c.db;
    }
  }

  // Tier 2: looser contains-match, last resort, denylist still enforced.
  for (const c of cols) {
    const name = norm(c.db || c.prop);
    if (blocked(name)) continue;
    if (want.some((t) => name.includes(t))) return c.db;
  }

  return null;
}
```

The tier order does as much work as the denylist. A column literally named `phone` now beats anything that merely contains "phone", so the loose tier only ever fires when there is genuinely nothing more specific. The naive version was all Tier 2. The whole bug lived in skipping straight to the loosest rule.

One detail that matters: I check `c.db || c.prop`, the database name first. The MySQL column is what ends up interpolated into the `UNION ALL` SQL, so the database name is the thing that has to be right. The property name is a fallback for the rare column where they diverge.

## Where this advice is wrong

I want to be honest about the edges, because "always use a denylist and exact-match" is the kind of rule that ossifies into cargo cult.

The denylist is maintenance you're signing up for. Every column you add to `ALWAYS_EXCLUDE` is a fact about your schema that now lives in two places — the entity and the list — and the list has no compiler to keep it honest. On a schema that changes weekly this gets stale fast and a stale exclude is its own silent bug, in the opposite direction: a real LOB column you accidentally blocked, rendering as a permanent `null`. The denylist is the right call precisely because Telelinkz's contact columns are *stable* — they've been `phoneNumber` and `phoneNumber_second` for years. If your "never match" set churns, you don't want a denylist; you want explicit per-table mapping in a config you can diff.

And the whole runtime-introspection approach is wrong when the answer is genuinely fixed. If you have four tables and they'll always be four, the `switch` is more honest. You can read it, a reviewer can read it, it fails in code review instead of in a status report. Dynamic mapping earns its keep at 27 tables and an open-ended provider list, where the cost of the indirection is finally smaller than the cost of editing every case by hand. Below some threshold — call it a dozen tables — fuzzy mapping is just cleverness you'll pay interest on. I went dynamic because new providers land monthly and each one is a `dynamic_sale` row I never want to touch code for.

Exact-then-legacy also assumes your legacy columns follow a *convention* — a `_legacy` suffix, a predictable rename. Telelinkz had that because the migrations were disciplined about it. If your old columns are named whatever the original author felt like that day, no tiering saves you; the legacy tier degrades into a guess and you're back to needing an explicit map for the wild ones. Tiered matching is a way to encode a convention you already have, not a way to invent one you don't.

## Rules of thumb I'd hand my past self

Write down the columns that are *never* the answer before you write the rule for the ones that are. The denylist is the part that actually keeps data in the right column; the matcher is just tie-breaking among survivors.

Treat declaration order as something your logic must be immune to, not something you can lean on. If reordering an entity's fields can change what your mapper returns, you don't have a mapper — you have a coincidence with a function signature.

Make introspection your source of truth and build everything on top of it. `dataSource.getMetadata(Entity).columns` can't lie about the schema the way a hand-maintained map can. The bug is never in the metadata; it's always in what you decided to do with it.

And know your table count. The defensive recipe here is the right answer at scale and overengineering at four tables. The honest version of this lesson isn't "fuzzy matching is bad" — it's that fuzzy matching across schemas you don't fully control is a loan, and the denylist plus strict ordering is the only collateral that keeps it from coming due as a corrupted report three weeks after the commit that caused it.
