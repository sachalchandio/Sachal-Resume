---
title: "Provider-specific validation that tells you what's actually wrong"
description: "Cryptic BadRequest errors waste everyone's time. Writing validation messages a rep can read."
date: "2024-07-09"
updated: "2024-07-09"
kind: "deepdive"
category: "Backend"
tags: ["validation", "nestjs", "dx"]
month: "2024-07"
repo: "backend"
author: "Sachal Chandio"
---

A rep messaged me on a Tuesday: "the Xfinity form won't save and I don't know why." She'd been staring at it for ten minutes. The error she got back was:

```
Invalid package code "" for provider "GENERIC_TYPES" service "OTHER/INSTALLATION_TYPE"
```

She is a salesperson. She closes deals on the phone. She does not know what `GENERIC_TYPES` is, what a `serviceType` of `OTHER` means, or why "INSTALLATION_TYPE" is shouting at her in screaming snake case. She knew one thing: the form was broken. It wasn't. She'd left the Installation Type dropdown on its placeholder, which posts an empty string, and the package lookup blew up trying to resolve `""` into a real package row.

That message is the whole post. The validation worked perfectly. It just spoke a language nobody on the sales floor reads.

## Where the bad message came from

Every Xfinity sale runs every dropdown value through `PackageLookupService`. Internet, TV, Phone, HMS, TPV status, sale status, installation type — they all get resolved from a code the form sends (`"CONNECT_75"`, `"SELF_INSTALLATION"`) into a `packageVersion` row so we can attach the right FK and pin the price at sale time. The service does this in one batched query for all seven fields, which is good. The error path is where it falls down:

```ts
// package-lookup.service.ts — the generic failure
if (!matchingPackage) {
  const serviceDesc = item.subCategory
    ? `${item.serviceType}/${item.subCategory}`
    : item.serviceType;
  throw new BadRequestException(
    `Invalid ${item.fieldName} package code "${item.code}" for ` +
    `provider "${item.providerCode}" service "${serviceDesc}"`,
  );
}
```

This is a fine message for *me*. It tells me the provider, the service type, the subcategory, and the exact code that didn't match a row. When I'm debugging a seed problem or a bad enum migration, it's the message I want. The provider/service/subcategory tuple is a database identity, and the failure is real — there genuinely is no active package row for that code.

But notice what triggers it. A blank dropdown sends `""`. The lookup treats `""`, `NONE`, and `UNDETERMINED` as "no selection" and returns `null` instead of throwing — that's the `if (!packageCode || packageCode === 'NONE' …)` guard at the top. So an empty Installation Type *should* sail through as null. The catch: installation type is not optional for Xfinity. A sale with no installation type is meaningless — somebody has to roll a truck or mail a self-install kit. So the empty value slips past the "no selection is fine" guard, and then something downstream — a NOT NULL column, or a later required-field check — rejects it with whatever generic message happened to be nearest. The rep gets database identity tuples. Nobody mapped the failure back to "the dropdown you forgot."

## The reframe: an error message is a UX surface

I want to be precise about the claim, because it's easy to wave at. The validation logic was correct. Nothing was insecure, nothing was wrong about *what* it rejected. The only defect was the string.

And a string that a user reads when they're blocked is UI. It is as much a UX surface as the dropdown itself. We spend real effort on the placeholder text in that dropdown and then ship a 500-adjacent error that reads like a stack trace. The asymmetry is the bug.

There's a sharper version of this for a CRM specifically. The person filling the form does not have the business rules memorized. "Xfinity requires an installation type, TPV status, and at least one service package; sale status can't be left as undetermined when the order is confirmed" — that lives in my head and in the validators. The rep is doing twenty of these an hour. The form's job is to *carry* the rules so the rep doesn't have to. When a rule is violated, the message is the one moment the rule becomes visible. If it's gibberish at that moment, the rule may as well not exist.

## What I changed

I added explicit, field-aware checks in the Xfinity service *before* the generic resolver ever runs, so the required-but-empty case gets caught by something that knows it's about installation type, not about a `GENERIC_TYPES` tuple. The naive version I shipped first was a wall of `if`s right in `create()`:

```ts
if (!input.installation || input.installation === 'NONE' || input.installation === 'UNDETERMINED') {
  throw new BadRequestException('Installation type is required and cannot be NONE.');
}
if (!input.comcastTpvStatus || input.comcastTpvStatus === 'NONE') {
  throw new BadRequestException('TPV status is required for Xfinity sales.');
}
// ...and four more of these
```

It worked, and the rep stopped messaging me. But six near-identical blocks at the top of `create()` is exactly the kind of thing you paste into the next provider and forget to update one of the field names. So I pulled it into a small helper that takes the field, its human label, and whether a "NONE" sentinel counts as empty:

```ts
type RequiredCheck = { value?: string | null; label: string; allowNone?: boolean };

function assertRequiredSelection(checks: RequiredCheck[]): void {
  for (const { value, label, allowNone } of checks) {
    const normalized = (value ?? '').trim().toUpperCase();
    const isEmpty =
      normalized === '' ||
      normalized === 'UNDETERMINED' ||
      (!allowNone && normalized === 'NONE');

    if (isEmpty) {
      throw new BadRequestException(
        `${label} is required and cannot be NONE.`,
      );
    }
  }
}
```

Then the call site reads like the business rule it encodes:

```ts
assertRequiredSelection([
  { value: input.installation,      label: 'Installation type' },
  { value: input.comcastTpvStatus,  label: 'TPV status' },
  { value: input.saleStatus,        label: 'Sale status' },
]);
```

Internet, TV, Phone, and HMS are different — for those, `NONE` is a legitimate answer (a customer can buy internet only), so they don't go through this list. `allowNone` exists exactly for the fields where the distinction matters. The rep who left installation blank now gets:

```
Installation type is required and cannot be NONE.
```

She knows what to fix without messaging me. That's the entire win, and it's worth more than it looks.

## The sharp edges

**Don't let the friendly message swallow the diagnostic one.** I almost replaced the generic `PackageLookupService` error with the human one. That would have been a mistake. When a code is *genuinely* invalid — a stale enum the frontend still offers after a package was deactivated — I want `Invalid Internet package code "FAST_400" for provider "XFINITY" service "INTERNET"`, with the tuple, because that's a real data bug I have to chase in the `package` table. The two messages serve two different readers. The fix is to catch the *user* error (required-but-empty) early and specifically, and leave the *engineer* error (code-doesn't-resolve) exactly as cryptic as it needs to be. Same exception type, different audience, different layer.

**`NONE` is overloaded and it bites.** Across the codebase `NONE`, `UNDETERMINED`, and `""` all mean "unselected" in some places and "deliberately none" in others. For Internet, `NONE` means the customer didn't buy internet — a real choice. For installation type, `NONE` means the rep forgot. Same string, opposite meaning, and the only thing that disambiguates is the field. Any required-selection helper has to be told per-field whether `NONE` is allowed; there is no global answer. I learned this by getting it wrong and rejecting a perfectly valid internet-only sale.

**Validation lives in three places and they drift.** There are `class-validator` decorators on `CreateXfinitySaleInput` (`@IsNotEmpty`, `@Length(5,5)` on zip, the `@Matches(/^\d{10}$/)` on phone), there's this service-level required-selection check, and there's the database. The decorators run first and catch shape problems. The service catches business rules that need a DB lookup or cross-field logic. Keeping the *messages* consistent in tone across those layers is a discipline, not something the framework gives you. The zip validator already says "Zipcode must be exactly 5 digits long" — that's the bar. The package errors were below it.

## What I'd do differently

I'd put the field label next to the field once and read it everywhere. Right now the human label `'Installation type'` is a string literal at the call site, and the GraphQL field is `installation`, and the column is `installation`, and the form label is set in Angular. Four copies of the same human concept. The clean version is a small metadata map — field key to display label to required-ness — that both the validator and the frontend form schema read from, so "Installation type" is written down exactly once. I haven't built that yet; with two dozen providers each with their own DTO, it's the obvious next consolidation, and the obvious place to get the abstraction wrong if I rush it.

The other thing: these messages should be the kind of thing you can assert on in a test, which means they shouldn't be assembled from variables the test can't predict. `Installation type is required and cannot be NONE.` is a constant. `Invalid ${field} package code "${code}"…` is not, and that's fine for the engineer-facing one, but it tells you which messages you actually consider part of the contract.

The lesson I keep relearning: the validation almost always works. What breaks is the sentence it hands back. If the person reading it has to ask an engineer what it means, you haven't validated the form — you've just moved the work onto them.
