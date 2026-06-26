---
title: "Storing time in Ohio, not UTC: a date-drift fix"
description: "The team works EST, the server stored UTC, and the dates a rep saw didn't match the database. Aligning them."
date: "2024-12-11"
updated: "2024-12-11"
kind: "deepdive"
category: "Databases"
tags: ["timezones", "mysql", "dates"]
month: "2024-12"
repo: "backend"
author: "Sachal Chandio"
---

A rep called me on the first of the month. She'd just submitted a sale, the form said order date December 1st, she hit save, and the row in her sales list said December 2nd. Same sale. She refreshed. Still the 2nd. "Did I break something?" No. The system did exactly what it was told. That's the worst kind of bug.

It only showed up in the evening. Sales entered in the morning looked fine. By 7pm the `createdAt` column and the `orderDate` she'd typed started disagreeing, and a sale logged on the last day of the month would quietly roll into the next month — which matters a lot when commissions are bucketed by month. A sale on November 30th that books as December 1st is a sale that lands in the wrong payroll period.

## The first guess was wrong

My first instinct was the frontend. Angular, Apollo, some `Date` getting serialized through three layers, of course it's the client mangling the timezone on the way in. I spent a good half hour in the browser, logging the value the form held right before the mutation fired. It was correct. `2024-12-01`, clean, no time component, no `Z`. The payload going over the wire was correct too — I watched the GraphQL request in the network tab.

So it wasn't the client. The right value left the browser. Something between the resolver and the disk was adding hours.

Then I looked at what we actually store. The interesting columns:

```ts
@Column('date', { nullable: false })
orderDate: Date;
```

```ts
@CreateDateColumn({ nullable: true })
createdAt: Date;
```

`orderDate` is a MySQL `date` — no time, no zone, just a calendar day. `createdAt` is a `@CreateDateColumn`, which under the hood we were setting with `new Date()` in the base entity's `@BeforeInsert`. Two different mechanisms, and they only diverged in the evening. That's the tell. If your bug is time-of-day dependent, it's a timezone bug until proven otherwise.

## The root cause

The server runs in UTC. Of course it does — that's the default everyone parrots, "always store UTC," and our containers honored it. The floor is in Ohio. Eastern time. In December that's UTC-5.

`new Date()` on a UTC box gives you a UTC instant. When a rep saves a sale at 8pm Eastern on December 1st, the server clock already reads 1am on December 2nd. So `createdAt` writes `2024-12-02`. Meanwhile `orderDate` is the literal day string `2024-12-01` the rep typed, which MySQL stores verbatim into a `date` column without applying any zone. The two columns drift apart by exactly the offset, but only once the local evening crosses midnight UTC.

The "wrong number" the rep saw wasn't even `orderDate`. The list view sorted and grouped by `createdAt`, and that was the column living five hours in the future.

I confirmed it with one query against the live data:

```sql
SELECT id, orderDate, createdAt
FROM sale
WHERE DATE(createdAt) <> orderDate
ORDER BY createdAt DESC
LIMIT 20;
```

Every row in the result was created after roughly 7pm Eastern. Every one had `createdAt` a day ahead of `orderDate`. There was the bug, sitting in a table.

## The decision, which I'll defend

"Just store UTC and convert at the edges" is correct advice. I'd give it to anyone starting fresh. The problem is that it assumes every consumer of the data converts on the way out, and ours didn't. We have reporting queries, a couple of Bull jobs that bucket sales by day, raw exports a manager opens in a spreadsheet, and a SQL console that the operations lead uses directly. Every one of those is a place where "convert at the edges" means "remember to apply the offset," and humans don't.

There is exactly one timezone this company operates in. There will not be a second one. Given that, the pragmatic move is to make the stored value already correct for the only audience that reads it. Store the wall-clock time of Ohio. A `createdAt` of `2024-12-01 20:14` reads as the day it happened, in every tool, without anyone converting anything. The cost is that the database no longer holds true UTC instants — and I'm at peace with that, because nobody downstream was treating them as instants anyway.

If we ever open a second office in a different zone, this decision is wrong and I'll have to migrate. I wrote that sentence in the PR description so future me has no excuse.

## The fix

The change was small, which is the satisfying part of timezone bugs once you find them. I stopped handing the database a raw `new Date()` and started handing it Eastern wall-clock time. A tiny helper:

```ts
// Eastern Standard. The floor is in Ohio and there is exactly one office.
const EST_OFFSET_MS = 5 * 60 * 60 * 1000;

export function nowInOffice(): Date {
  return new Date(Date.now() - EST_OFFSET_MS);
}
```

Then the base entity, before and after.

Before — UTC slipped in here:

```ts
@BeforeInsert()
updateCreatedAt() {
  if (!this.createdAt) {
    const date: Date = new Date();
    this.createdAt = date;
    this.updatedAt = date;
  }
}
```

After:

```ts
@BeforeInsert()
updateCreatedAt() {
  if (!this.createdAt) {
    const date = nowInOffice();
    this.createdAt = date;
    this.updatedAt = date;
  }
}

@BeforeUpdate()
updateUpdatedAt() {
  this.updatedAt = nowInOffice();
}
```

`orderDate` needed nothing — it was already a bare `date` holding the day the rep typed. The whole bug was that `createdAt` was computed in a different reference frame than the value sitting next to it. Once both spoke Eastern, the list view stopped lying.

I also did the boring hardening: setting `TZ=America/New_York` in the deployment env so anything I missed — log timestamps, a stray `new Date()` in a report I'd forgotten about — at least agreed with the helper rather than fighting it. Belt and suspenders. The helper is the source of truth; the env var is there to keep the surprises small.

### The transformer cleanup

While I was in there I found the actual mess. We had date handling scattered across resolvers — one place doing `value.toISOString().split('T')[0]`, another doing manual `getFullYear()`/`getMonth()` string-building, a third trusting whatever TypeORM returned. They didn't all agree, which is how you get a bug that's correct on Tuesday and wrong on Wednesday.

I already had a `Trim()` transformer pattern in the codebase — a thin wrapper over `class-transformer`'s `Transform`:

```ts
import { Transform } from 'class-transformer';

export function Trim() {
  return Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}
```

So I made a date one in the same shape, to normalize day-only fields to a plain `YYYY-MM-DD` string in office time on the way out, instead of every resolver inventing its own formatting:

```ts
import { Transform } from 'class-transformer';

// Render a day-only field as the Ohio calendar day, no time, no Z.
export function OfficeDate() {
  return Transform(({ value }) => {
    if (!value) return value;
    const d = value instanceof Date ? value : new Date(value);
    const local = new Date(d.getTime() - EST_OFFSET_MS);
    return local.toISOString().split('T')[0];
  });
}
```

Now `orderDate` and `installationDate` carry one decorator and produce one consistent string. The ad-hoc `.split('T')[0]` calls are gone. Fewer places for the next person to get the offset wrong by being clever.

## Backfilling the rows that already drifted

The code fix only protects new rows. The historical rows written under UTC still had `createdAt` running ahead, and the operations lead was going to keep seeing the old wrong numbers. I asked before touching anything — the rule in this shop is no data change without a human signing off — and we agreed to correct only the rows that demonstrably drifted, the ones where the date didn't match `orderDate`:

```sql
UPDATE sale
SET createdAt = createdAt - INTERVAL 5 HOUR,
    updatedAt = updatedAt - INTERVAL 5 HOUR
WHERE DATE(createdAt) <> orderDate
  AND createdAt >= '2024-01-01';
```

I ran it on a copy first, eyeballed twenty rows, then ran it for real against the audited set. Could I have shifted everything by five hours unconditionally? Not safely — some rows already matched because they were entered during the day, and a blind shift would have broken the ones that were fine. The condition mattered.

## What I'd tell the next person

Storing UTC is the right default and I still reach for it first. It loses when your data has exactly one audience, that audience reads the database through five different tools, and not one of those tools converts on the way out. At that point "store UTC, convert at the edges" quietly becomes "convert at the edges, and pray every edge remembers." A single-timezone shop is allowed to store wall-clock time. It's not heresy; it's matching the storage to the reader.

Here's when this bites you, written down so I believe it later: the day you open the second office. The moment two zones read the same table, wall-clock storage is ambiguous and you're back to UTC plus a migration. Until that day, the dates match what the rep typed, the last-of-the-month sale lands in the right commission bucket, and nobody calls me on the first of the month asking what they broke.
