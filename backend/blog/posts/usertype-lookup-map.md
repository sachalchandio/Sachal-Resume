---
title: "Replacing regex-y role matching with a lookup map"
description: "normalizeRole checked eight spellings of one role. A Map built from the enum did it once."
date: "2026-04-05"
updated: "2026-04-05"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "typescript", "enums", "auth"]
month: "2026-04"
repo: "frontend"
author: "Sachal Chandio"
---

The function was called `normalizeRole`, and by the time I opened it again it had grown to about ninety lines of `if` and `||`. Most of it was one role. Someone, somewhere, had decided a QA manager could be a `qa-manager`, a `qa_manager`, a `QAManager`, a `Qa Manager`, a `qamanager`, or — my favorite — a bare `qm`. So the function checked all of them. Then it did the same dance for half a dozen other roles, and the bottom of the file was a graveyard of dead branches for roles that no longer existed.

It worked. That's the dangerous part. Nobody touches a function that works, so it accretes. A new spelling shows up in the data, someone adds another `||`, and the thing gets a little more load-bearing and a little less legible every quarter.

What finally pushed me to rewrite it was a bug that wasn't even in `normalizeRole`. A `*ngIf` was hiding the internet-provider menu from a QA manager who should have seen it. I traced it down through three components and landed on a string compare — `userType === 'QA_MANAGER'` — that was correct, but the value flowing in had come through a different code path that lowercased it. Two truths, one role, never equal. That's the bug you get when "what counts as a QA manager" is answered in fifteen different files.

## The actual source of truth

The thing is, we already had a source of truth. The backend ships a GraphQL schema, and our codegen turns the `UserType` enum into a real TypeScript enum in `src/generated/graphqlTypes.ts`:

```ts
export enum UserType {
  Admin = 'ADMIN',
  Agent = 'AGENT',
  // ...
  Qa = 'QA',
  QaDeveloper = 'QA_DEVELOPER',
  QaManager = 'QA_MANAGER',
  CustomerRetention = 'CUSTOMER_RETENTION',
  CustomerRetentionManager = 'CUSTOMER_RETENTION_MANAGER',
  // ...24 of them
}
```

That enum is the *only* set of values the server will ever hand us. `QA_MANAGER` is the canonical form. Everything else — the hyphens, the camelCase, the `qm` — is something a human typed somewhere it shouldn't have been typed, or a legacy field that predated the enum. So the rewrite is conceptually simple: pick `QA_MANAGER` as the one true value, and make every other variant resolve to it through exactly one chokepoint.

The trick is doing that without writing out the variants by hand again, because hand-maintained alias lists are how you get back to ninety lines.

## What I rejected first

My first instinct was a regex per role. `/qa[-_\s]?manager/i`. Clean to write, terrible to live with. Regex matching is fuzzy by design, and fuzzy is exactly wrong for an authorization decision. `/qa[-_\s]?manager/i` happily matches `senior-qa-manager-trainee`, which is not a role we have. The whole point is a closed set, and a regex is an open one. I'd be trading a wall of `if`s for a wall of regexes that silently over-match. No.

Second idea: a hand-written alias object.

```ts
const ROLE_ALIASES: Record<string, UserType> = {
  'qa-manager': UserType.QaManager,
  'qa_manager': UserType.QaManager,
  'qamanager': UserType.QaManager,
  // ...and now maintain this forever
};
```

Better — it's a closed set again, and lookups are O(1). But it has the same rot problem as the original. Every new role means new rows, and the rows are redundant: `qa-manager` and `qa_manager` differ only by a character I could strip programmatically. I was hand-encoding a transformation a function should do.

So the real design is two pieces that I'd kept conflating:

1. A **canonicalizer** — a pure string transform that collapses all the cosmetic variation (case, separators) so any spelling of one role lands on the same key.
2. A **lookup Map** built *from the enum itself*, so the set of valid roles is never typed twice.

## Building the Map from the enum

`Object.values(UserType)` gives you every canonical string. I run each one through the same canonicalizer I'll later run the input through, and use the result as the Map key. Build it once, at module load:

```ts
import { UserType } from 'src/generated/graphqlTypes';

/** Strip cosmetic variation so 'QA_MANAGER', 'qa-manager', 'Qa Manager'
 *  all collapse to the same key. Letters and digits only, lowercased. */
function canonicalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Built once from the enum — the enum is the source of truth, not this Map.
const USER_TYPE_LOOKUP: ReadonlyMap<string, UserType> = new Map(
  Object.values(UserType).map((value) => [canonicalizeToken(value), value]),
);

export function normalizeUserType(
  raw: string | null | undefined,
): UserType | null {
  if (!raw) return null;
  return USER_TYPE_LOOKUP.get(canonicalizeToken(raw)) ?? null;
}
```

`canonicalizeToken('QA_MANAGER')` is `qamanager`. So is `canonicalizeToken('qa-manager')`, and `canonicalizeToken('Qa Manager')`, and `canonicalizeToken('qaManager')`. They all hit the same Map entry. The variants I used to enumerate by hand are now generated by the transform — I never list them anywhere. Add a role to the backend enum, regenerate types, and it's in the Map on the next build with zero edits to this file.

The one alias the transform *can't* derive is `qm`, because there's no string operation that turns `qamanager` into `qm`. That's a genuine alias, not cosmetic variation, and it gets its own explicit entry. The difference matters: I want the file to make it obvious which mappings are mechanical and which are real human shorthand I'm choosing to support.

```ts
const EXPLICIT_ALIASES: ReadonlyMap<string, UserType> = new Map([
  ['qm', UserType.QaManager],
  ['crm', UserType.CustomerRetentionManager],
]);

export function normalizeUserType(
  raw: string | null | undefined,
): UserType | null {
  if (!raw) return null;
  const key = canonicalizeToken(raw);
  return USER_TYPE_LOOKUP.get(key) ?? EXPLICIT_ALIASES.get(key) ?? null;
}
```

Two short, declarative aliases versus a function that grew every time someone fat-fingered an underscore.

## Reading it synchronously

The other half of the pain was *where* the role came from at call time. The current user lives in an observable — it arrives after a GraphQL round-trip, gets refreshed, can change. Half the `normalizeRole` callers were template expressions or guard checks that wanted a yes/no answer *now*, and threading an observable through every one of them was its own mess. People were subscribing in odd places and caching the result in component fields, which is how you get the stale value that started this whole bug.

Since we're on signals now, I cache the normalized current type in a signal and let everything read it synchronously:

```ts
private readonly _currentUserType = signal<UserType | null>(null);
readonly currentUserType = this._currentUserType.asReadonly();

// fed once from the user stream
this.currentUser$
  .pipe(takeUntilDestroyed())
  .subscribe((u) => this._currentUserType.set(normalizeUserType(u?.userType)));

readonly isQaManager = computed(
  () => this.currentUserType() === UserType.QaManager,
);
```

One subscription owns the conversion. Everything downstream — guards, `*ngIf`, derived `computed`s — reads `currentUserType()` and compares against an enum member with `===`. No string literals in templates, no re-normalizing, no re-subscribing. The signal is the single synchronous read point, and because the value going in was canonicalized once on the way in, a `===` is now safe everywhere. That's the equality bug fixed at the source: there is exactly one representation of "QA manager" in the app, and it's `UserType.QaManager`.

## Before and after at the call site

Before, a route guard looked like this, and this is the *condensed* version:

```ts
const role = (user.userType ?? '').toLowerCase().trim();
if (
  role === 'qa_manager' ||
  role === 'qa-manager' ||
  role === 'qamanager' ||
  role === 'qa manager' ||
  role === 'qm'
) {
  return true;
}
```

After:

```ts
if (normalizeUserType(user.userType) === UserType.QaManager) {
  return true;
}
```

And checking membership in a set of roles — say, "can this person reach the internet-provider menu" — stops being a chain of ORs and becomes a real set lookup against canonical values:

```ts
const PROVIDER_ACCESS = new Set<UserType>([
  UserType.Admin,
  UserType.Manager,
  UserType.Agent,
  UserType.QaManager,
]);

export function canAccessProviders(raw: string | null | undefined): boolean {
  const type = normalizeUserType(raw);
  return type !== null && PROVIDER_ACCESS.has(type);
}
```

This fit the grain of code we already had — elsewhere in the auth folder we were already doing `new Set(RETENTION_USER_TYPES)` and calling `.has()` for retention checks. The lookup-map rewrite just extended that instinct backwards to the normalization step instead of leaving a regex-y mess in front of clean set logic.

## The tradeoffs I took

The Map is built eagerly at module load. For 24 enum values that's nothing, and it's done once per page load, not per call. If the enum were thousands of entries I'd think harder, but it isn't and it never will be — it's job roles.

`normalizeUserType` returns `null` for anything it doesn't recognize, and I made every caller handle `null` explicitly rather than defaulting to some "guest" role. A silent default is how an unknown string quietly becomes a permission. If garbage comes in, the answer is "no role," and the access check fails closed. I'd rather a legit user briefly see less than have a typo grant access.

The cost I accepted: the explicit-alias Map still needs a human. `qm` and `crm` won't appear by magic, and if marketing invents a new shorthand tomorrow I have to add a line. But that's two lines in an obvious place, clearly labeled as human shorthand, instead of judgment calls smeared across the codebase. And I keep `EXPLICIT_ALIASES` honest with a tiny test that asserts every alias resolves to a real enum member, so a typo there fails CI instead of production.

The lesson I keep relearning: when matching gets complicated, it's almost always because the data has more than one representation of the same thing. The fix isn't smarter matching. It's collapsing the representations to one — pick a canonical form, derive it from whatever your real source of truth already is, and force everything through that funnel exactly once. The day you find yourself enumerating spellings, the spellings are the bug. This bites hardest in auth, because there a near-miss isn't a glitch, it's a door left open.
