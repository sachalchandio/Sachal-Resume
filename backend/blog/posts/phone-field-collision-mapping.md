---
title: "When a generic ‘phone’ lookup matched the wrong column"
description: "A fuzzy column matcher grabbed the base phoneNumber instead of a provider-specific phone field. Defensive matching to the rescue."
date: "2025-11-05"
updated: "2025-11-05"
kind: "deepdive"
category: "Backend"
tags: ["typeorm", "schema", "data-mapping"]
month: "2025-11"
repo: "backend"
author: "Sachal Chandio"
---

The status board for one provider was showing phone-line sales it had no business showing. A sale where the rep had only sold internet was lighting up under the "Phone" line of business, and the count it was rolling up against was the customer's actual phone number — a 10-digit string — not a package code. Nobody had touched that report in weeks. So the first question was the usual one: what changed, and why now.

Nothing changed. That was the annoying part.

## The setup that made it possible

Telelinkz has a pile of legacy provider tables — `spectrum_sale`, `cox_sale`, `ziply_sale`, and a dozen more — each with its own column shape from before we consolidated everything onto the shared `dynamic_sale` table. They all extend the same base entity, which means every single one of them inherits the contact columns: `phoneNumber` and `phoneNumber_second`. Those are the customer's actual phone number, indexed, ten chars, `NOT NULL`.

On top of that, each legacy table has its own line-of-business columns. For some providers the phone *line* is an FK to a package version (`phonePkgVersionId`, `phonePackageId`). For older ones it's a plain varchar label column literally named `phone`, or `phone_legacy` after a migration renamed it to get out of the way.

To build the status-counts report across all of these heterogeneous tables in one `UNION ALL`, I wrote a heuristic that scans each entity's column metadata at runtime and picks the right column for each LOB. It looked at TypeORM's `columns` array and matched on name tokens. Here's the naive version I shipped — the one that worked fine until it didn't:

```ts
private pickLobColumn(
  cols: { db: string; prop: string }[],
  requiredTokens: string[],
  qualifierTokens: string[],
): string | null {
  const toLower = (s: string) => s.toLowerCase();

  // Strong match: required token AND a qualifier (e.g. "phone" + "package")
  for (const c of cols) {
    const name = toLower(c.db || c.prop);
    if (
      requiredTokens.some((t) => name.includes(t)) &&
      qualifierTokens.some((t) => name.includes(t))
    ) {
      return c.db;
    }
  }
  // Weak match: required token alone
  for (const c of cols) {
    const name = toLower(c.db || c.prop);
    if (requiredTokens.some((t) => name.includes(t))) {
      return c.db;
    }
  }
  return null;
}
```

For the phone line I called it with `['phone']` as the required token. The strong match wants `phone` *and* a package qualifier — that's how it finds `phonePkgVersionId`. The weak match is the fallback for legacy tables where the LOB column is just `phone`.

You can probably see it now. `phoneNumber`, when you lowercase it, is `phonenumber`. And `'phonenumber'.includes('phone')` is `true`.

## Chasing the wrong thing first

I didn't see it now, though. I spent the first half hour convinced the bug was in the data, not the query. The report joins `sale_stage` and `search_index` to figure out which stage each sale is in, and that join is the part I distrust most — it's the piece that drifts when a sale gets re-staged. So I went and pulled the raw stage rows for one of the offending sales, expecting to find a stale `phone` stage row that should've been cleaned up.

The stage rows were fine. The sale really was internet-only.

Then I dumped the actual SQL the report generates. The subquery builder stitches together a `SELECT` per provider table, and the column it picks per LOB is interpolated right into the string:

```sql
SELECT s.id AS saleId, s.createdAt, s.orderDate,
       s.internetPkgVersionId AS internetId,
       s.tvPkgVersionId       AS tvId,
       s.phoneNumber          AS phoneId,   -- <-- there it is
       s.mobilePkgVersionId   AS mobileId,
       ...
FROM ziply_sale s
```

`phoneNumber AS phoneId`. The matcher had walked the column list, hit `phoneNumber` before it ever reached the real LOB column, and `includes('phone')` happily returned it. Downstream, any non-null value in that column counts as "this sale has a phone line," and every sale has a customer phone number, so *every* sale counted as a phone sale. The number being rolled up wasn't a package code at all — it was someone's cell phone.

Why now? Because `pickLobColumn` returns the *first* matching column, and column order in TypeORM's metadata follows declaration order. A recent change to that provider's entity had reordered the contact fields above the LOB fields. Before, the real `phone` column happened to come first and the bug was masked. The reorder didn't introduce the bug; it just stopped hiding it. The matcher had been one column-shuffle away from breaking the whole time.

## The fix

Two things were wrong. First, a generic `includes('phone')` should never have been allowed to match the contact columns — those are structurally off-limits for LOB resolution, full stop. Second, "first column that contains the token" is too loose a rule for legacy label columns; I want an exact name or an explicit `_legacy` suffix, not anything that merely contains the word.

So I split the legacy-column picker out from the FK picker and gave it a hard exclusion list plus a tiered matching strategy: try exact, then the legacy pattern, and only then fall back to a contains-match — with the contact columns excluded at every tier.

```ts
private pickLegacyLobColumn(
  cols: { db: string; prop: string }[],
  requiredTokens: string[],
  excludeTokens: string[],
): string | null {
  const toLower = (s: string) => s.toLowerCase();
  const normalizedRequired = requiredTokens.map((t) => toLower(t));

  // The contact columns are inherited by EVERY sale table. They must never
  // be resolved as a line-of-business column, no matter the token.
  const alwaysExclude = [
    'phonenumber', 'phone_number', 'phone-number',
    'phonenumber_second', 'phone_number_second', 'phone-number-second',
    'phone2', 'secondaryphone',
  ];

  // Tier 1: exact name, or the explicit legacy variant (`phone`, `phone_legacy`).
  for (const c of cols) {
    const name = toLower(c.db || c.prop);
    if (alwaysExclude.some((t) => name.includes(t))) continue;
    if (excludeTokens.some((t) => name.includes(t))) continue;

    for (const token of normalizedRequired) {
      if (name === token) return c.db;
      if (name === `${token}_legacy` || name === `${token}legacy`) return c.db;
      if (name.endsWith(`${token}_legacy`) || name.endsWith(`${token}legacy`)) return c.db;
    }
  }

  // Tier 2: looser contains-match, still honoring both exclusion lists.
  for (const c of cols) {
    const name = toLower(c.db || c.prop);
    if (alwaysExclude.some((t) => name.includes(t))) continue;
    if (
      normalizedRequired.some((t) => name.includes(t)) &&
      !excludeTokens.some((t) => name.includes(t))
    ) {
      return c.db;
    }
  }
  return null;
}
```

The ordering of the tiers matters as much as the exclusion list. With a bare contains-match, `phone_legacy` and `phonePort` and `phoneNumber` are all equally valid candidates and you're at the mercy of column order. With exact-then-legacy first, a column literally named `phone` wins over anything that merely contains "phone", and the loose tier only ever fires when there's genuinely nothing better. The `alwaysExclude` check sits at the top of both loops so there is no path — no token, no ordering, no future entity change — that lets `phoneNumber` slip through.

I kept the exclusion list as substring matches (`includes`) on purpose, even though the tier-1 comparisons are exact. If a provider ever ships a `customerPhoneNumber` or a `phoneNumberRaw`, I want it caught too. The contact columns are the one thing I'm willing to be aggressive about excluding, because the cost of a false exclude there is zero — none of them is ever a real LOB column — while the cost of a false include is a wrong report that looks plausible.

## What I'd tell myself before writing the first version

Substring matching on identifier names is fine right up until two unrelated concepts share a word, and in a schema with both a *phone number* and a *phone line of business*, that collision is guaranteed, not hypothetical. The moment I wrote `includes('phone')` I'd signed up for this bug; I just didn't collect on it until a column reorder called it in.

The deeper lesson is about what "works" means for a heuristic. The naive matcher passed every test I gave it because every table I tested happened to declare its columns in a forgiving order. It was correct by accident. A heuristic that depends on column declaration order isn't a heuristic, it's a landmine with good manners — and the only honest fix is to make the rule independent of the thing that was accidentally saving you. Hence the exclusion list: it doesn't ask the matcher to be smarter, it removes the columns it must never touch from consideration entirely.

This bites hardest in exactly the situation I was in: a generic helper run across many schemas you don't fully control, where a shared base entity injects columns into every table. Whenever you find yourself fuzzy-matching column names across an inheritance hierarchy, write down the columns that are *never* the answer before you write the rule for the ones that are. The denylist is shorter than you think, and it's the part that actually keeps the data in the right column.
