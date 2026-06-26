---
title: "Normalizing every GraphQL date to an ISO string"
description: "A dozen providers, a dozen date formats. Picking one representation at the API boundary."
date: "2024-11-16"
updated: "2024-11-16"
kind: "deepdive"
category: "Backend"
tags: ["graphql", "dates", "validation"]
month: "2024-11"
repo: "backend"
author: "Sachal Chandio"
---

A frontend dev pinged me because the date column on the AltaFiber sales table was sorting wrong. Some rows sorted as `2024-11-08T00:00:00.000Z`, some as `2024-11-08`, and one — I had to read it twice — as `Fri Nov 08 2024 00:00:00 GMT+0000`. All three were the *same field*, `orderDate`, coming back from the *same* GraphQL query, on different rows. The client was doing `new Date(a.orderDate) - new Date(b.orderDate)` and getting nonsense whenever the string-to-Date coercion disagreed across formats.

That's the bug that finally made me deal with it. The real problem was older and wider than one column.

## How a dozen formats got into one API

Telelinkz integrates a stack of telecom providers — AltaFiber, AT&T, Xfinity, and a growing list behind a dynamic-form builder. Each provider got built at a different time, by whoever was free that sprint, and every one of them invented its own way of writing a sale's `orderDate` and `installationDate` to MySQL. Some stored a real `datetime`. Some stored a `YYYY-MM-DD` string in a `varchar` because the original form sent a date-only value and nobody converted it. The create path was the worst offender: it just took whatever the form posted and handed it to `repository.save`.

So by the time these dates came back out through a GraphQL resolver, the column type, the stored string, and the DTO declaration all disagreed. The DTOs themselves told the story — across the provider DTOs, `orderDate` and `installationDate` were typed as `@Field(() => String)`:

```ts
@Field(() => String)
orderDate: string;

@Field(() => String, { nullable: true })
installationDate?: string;
```

A `String` field. Which means GraphQL does *nothing* to it on the way out — no scalar, no coercion, no validation. Whatever string sat in the row got serialized to the wire verbatim. If the row held `2024-11-08`, that's what shipped. If a different code path had run `new Date()` and assigned the result, TypeORM persisted the `Date`'s default string form and *that* shipped. The schema promised a `String` and delivered, faithfully, whatever garbage we'd stored.

I want to be honest about the naive thing I did first, because it was wrong and I shipped it. My instinct was to fix the sort on the client: write a parser that sniffed the three known shapes and normalized them in the Angular table. It worked. It also meant the API was still lying, and the next consumer — a report export, a downstream sync — would hit the exact same mess and have to write the exact same parser. Patching the reader is how you end up with five readers and one broken writer. The fix had to live at the boundary, not in every client.

## Where to normalize, and what I rejected

Three options, roughly.

I could have written a custom GraphQL scalar — an `ISODate` scalar whose `serialize` runs `toISOString()` on the way out, the way I'd later do for the WebSocket date bug. Clean in theory. But these fields were declared as `String` everywhere, sometimes legitimately holding a date-only value the UI rendered as-is, and flipping every one of them onto a date scalar meant auditing every read site for whether it wanted `2024-11-08` or `2024-11-08T00:00:00.000Z`. Too big a blast radius for the afternoon I had.

I could have normalized on read in each resolver. That spreads the same three lines across a dozen provider services and guarantees one of them drifts.

What I actually chose: normalize on **write**, at the create boundary, and make every provider funnel through the same coercion. If the only thing that ever lands in the column is a canonical ISO string (or `null`), then the `@Field(() => String)` declaration stops being a liability — it's just passing through a value that's already correct. Fix the writer once and every reader is fixed for free.

## The before, and the foot-gun in it

Here's roughly what one provider's create looked like before — and the bug is subtle:

```ts
const sale = this.repo.create({
  // ...
  orderDate: new Date(input.orderDate).toISOString(),
  installationDate: new Date(input.installationDate).toISOString(),
});
```

Looks fine until `input.installationDate` is `undefined`, which it often is — installation gets scheduled later. `new Date(undefined)` is `Invalid Date`, and `Invalid Date.toISOString()` doesn't return a weird string. It **throws** a `RangeError`. So a perfectly valid sale with no installation date yet would blow up the whole create with a stack trace nobody expected, because the conversion ran *before* anyone checked whether there was a value to convert. Validation after use. The classic ordering bug.

## The after

The rule I settled on: check validity first, then convert, and let a missing or unparseable date resolve to `null` instead of detonating.

```ts
const sale = this.altaFiberSaleRepository.create({
  // ...
  orderDate: isNaN(new Date(createAltaFiberSaleInput.orderDate).getTime())
    ? null
    : new Date(createAltaFiberSaleInput.orderDate).toISOString(),
  installationDate: isNaN(new Date(createAltaFiberSaleInput.installationDate).getTime())
    ? null
    : new Date(createAltaFiberSaleInput.installationDate).toISOString(),
});
```

`new Date(x).getTime()` is `NaN` exactly when the date is invalid — `undefined`, empty string, malformed input, all of it. So `isNaN(...)` is the single gate that catches every bad case, and only past that gate do we call `toISOString()`. The value written to MySQL is now one of two things: a full ISO-8601 UTC string, or `null`. Never `Invalid Date`, never a bare `YYYY-MM-DD`, never a locale-formatted `Fri Nov 08`. One shape.

That ordering — `isNaN` guard, then `toISOString` — is the entire fix in miniature, and I copied it into every provider's create. The format restriction that the frontend dev wanted falls out of it: an order date that survives is always a real ISO timestamp, so `new Date(a.orderDate) - new Date(b.orderDate)` sorts correctly because both operands parse the same way, every time.

## The same ordering bug, hiding in the filters

While I had every provider open, I went looking for the inverse — the *read* side, where dates come in as filter parameters — and found the validate-after-use pattern again, this time per provider, in the query builders. The good news is at least one was already shaped right:

```ts
if (filter.orderDate) {
  // Validate first.
  if (isNaN(Date.parse(filter.orderDate))) {
    throw new Error('Invalid orderDate format. Expected yyyy-mm-dd.');
  }

  const orderDateStart = new Date(`${filter.orderDate} 00:00:00`);
  const orderDateEnd = new Date(`${filter.orderDate} 23:59:59.999`);

  queryBuilder.andWhere('sale.orderDate BETWEEN :odStart AND :odEnd', {
    odStart: orderDateStart,
    odEnd: orderDateEnd,
  });
}
```

`isNaN(Date.parse(...))` runs *before* the value gets interpolated into the `new Date(...)` constructions. Others weren't consistent — a couple built the range first and validated after, or skipped the check entirely and let an unparseable filter silently produce a `BETWEEN Invalid Date AND Invalid Date` that MySQL turned into zero rows with no error. Same disease as the create path: the check existed but fired in the wrong order, so it protected nothing. I made the ordering uniform across every provider's filter block — parse-check, *then* construct the boundaries, *then* `andWhere`.

I'll flag one thing I did **not** fix here, on purpose, because it's a separate post. Those boundary strings — `${filter.orderDate} 00:00:00` and `23:59:59.999` — get parsed by `new Date()` in the server's local zone, which is its own timezone bug waiting for an agent whose sales sit near midnight. Normalizing the stored value to ISO doesn't touch the *filter window* arithmetic; it just makes the column you're comparing against trustworthy. I scoped this change to "one representation in the column" and left the half-open-interval timezone cleanup for when I could test it properly. Doing both at once would've been two unrelated risks in one PR.

## The tradeoffs I accepted

Storing ISO strings in `varchar` columns instead of migrating them to proper `datetime` is a compromise, and I know it. The clean answer is a migration that retypes the columns and a scalar that enforces the shape in the schema. I didn't do that. Retyping a column that a dozen provider services and several reports read from is the kind of change that needs a maintenance window and a rollback plan, and the immediate fire was "the table sorts wrong and a valid sale can crash the create." Normalizing on write bought me a correct, consistent API today without touching the schema or every read site. The columns are still `String` in GraphQL. But now they're `String`s that all look the same, which is the entire property the client needed.

The other thing I gave up: a date-only value like `installationDate` now serializes as `2024-11-08T00:00:00.000Z`, a full timestamp with a midnight-UTC time component that was never real. The customer didn't schedule installation for exactly midnight — there was no time, just a day. The frontend slices the `T` off for display, so it doesn't show. But it's a small lie in the data, and if a downstream consumer ever does timezone math on that midnight it'll land a day early for anyone west of UTC. I decided one consistent format with a fake time beats three honest formats that don't sort, and I'd make the same call again. Just know it's a call, not a free win.

The thing I keep relearning: a column's *type* and its *consistency* are different problems, and you can fix consistency without fixing the type. The DTO still says `String`. But the day every writer agrees on one string, the field is honest again — and the place to make them agree is the one boundary they all pass through on the way in, not the dozen places they fan out to on the way back.
