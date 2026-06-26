---
title: "orderDate vs createdAt: a timezone join that quietly returned nothing"
description: "Reusing recordDate for two different timestamps produced empty joins and null fields. Parameterized, separated, fixed."
date: "2026-04-06"
updated: "2026-04-06"
kind: "deepdive"
category: "Databases"
tags: ["mysql", "timezones", "typeorm", "sql"]
month: "2026-04"
repo: "backend"
author: "Sachal Chandio"
---

The Sale Status report came back empty. Not an error, not a 500 — empty. An agent who had closed eleven AT&T deals that month opened the dashboard, picked her name, picked the period, and got a card that said zero sales and a list of line-of-business fields that were all blank: internet null, tv null, phone null, mobile null. The query had run. It had returned rows for the agent header. It just hadn't returned any *sales*.

That's the worst kind of bug. A crash gives you a stack trace and a line number. This gave me a clean response with the wrong contents, and a 200 status code lying about it.

## The first guess was wrong

My first instinct was that the join to the line-of-business data had broken. The report stitches together three things: the `sale_stage` rows (who closed what, and the stage it's in), a search-index row that carries denormalized fields like customer name and commission, and a per-provider subquery that maps each provider's package columns into four canonical columns — `internetId`, `tvId`, `phoneId`, `mobileId`. If that subquery returned nothing, you'd get exactly this: a header with the agent, and null LOB fields, because they all come through a `LEFT JOIN` against the subquery.

So I went and stared at `buildLobUnionSubquery` for twenty minutes. Read the column mapping for AT&T three times. It was fine. The subquery, run on its own with the agent's sale IDs hardcoded, returned every row I expected. The LOB data was there.

The join wasn't the problem. The *rows feeding the join* were the problem — there were zero of them before the LEFT JOIN ever ran, so of course everything downstream was null.

## What was actually filtering everything out

Here's the part of the query that decided which sale stages counted for the period:

```ts
.innerJoin(SearchIndex, 'si', 'si.recordId = ss.saleId AND si.recordType = :recordType', {
  recordType: 'sale',
})
.where('ss.stage = :status', { status })
.andWhere('si.recordDate >= :startDate AND si.recordDate < :endDateExclusive', {
  startDate,
  endDateExclusive,
});
```

One column, `si.recordDate`, was doing two completely different jobs. It was the period filter — "show me sales in April" — and, down in the JSON aggregation, it was also the source for both timestamps the frontend renders:

```ts
"'createdAt', COALESCE(sp.createdAt, si.recordDate), " +
"'orderDate', COALESCE(sp.orderDate, DATE(si.recordDate)), " +
```

`createdAt` is when the sale row was written to the database. `orderDate` is the business date the customer's order is booked against — the field reps actually file the sale under, the one a manager means when they say "April numbers." On most rows those are close. They are not the same thing, and they don't even have the same type. `createdAt` is a full `DATETIME` stored in UTC. `orderDate` is a calendar day with no time component and no zone — it's whatever date the rep typed.

The report had collapsed both into `recordDate`, and the period boundaries were being computed one way while the values were stored another. The agent's sales were booked late in the day, US-time. By the time those order dates were turned into `DATETIME` boundaries and compared against a UTC-ish `recordDate`, the window had slid off the end of them. April 1st 00:00 in one frame is April 1st 04:00 or 05:00 in another. Eleven sales sitting right at the start of the month fell on the wrong side of `>= :startDate` and got filtered out before any join ran.

Zero rows in. Null everything out.

## The interpolation that made it worse

The older version of this report — the one I was migrating away from, still sitting in a commented-out block in the same file — had built its date range as strings and pasted them straight into the predicate:

```ts
// the old shape, paraphrased
.andWhere('sale.orderDate BETWEEN :orderStart AND :orderEnd', {
  orderStart: orderStartString,
  orderEnd: orderEndString,
});
```

Bound parameters there, technically. But upstream, `orderStartString` and `orderEndString` were assembled by hand — `${y}-${m}-${d} 00:00:00` and `23:59:59.999` — from a `Date` that had already been shifted into local time by the Node process. The filter service that fed it did the same thing, and you can still see the pattern in the per-provider services:

```ts
const orderDateStart = new Date(`${filter.orderDate} 00:00:00`);
const orderDateEnd = new Date(`${filter.orderDate} 23:59:59.999`);
```

`new Date('2026-04-01 00:00:00')` is parsed in the server's local zone. Build that string on a box set to anything other than the zone your `orderDate` values assume, and your 24-hour window is shifted by the offset. You don't get an error. You get a window that's off by a few hours and silently drops the rows that live in the gap. Every layer was re-deriving "the start of the day" with its own idea of which day, and which zone, and they didn't agree.

## The fix

Two changes, and they're boring, which is the point.

First, stop overloading one column. `createdAt` comes from the sale; `orderDate` comes from the sale's own record, not from the period-filter column. They get resolved independently in the aggregation instead of both falling back to `recordDate`:

```ts
"'createdAt', COALESCE(sp.createdAt, si.recordDate), " +
"'orderDate', COALESCE(sp.orderDate, DATE(si.recordDate)), " +
```

The `DATE(...)` on the fallback matters — it strips the time so an `orderDate` is always a clean calendar day, never a `DATETIME` that drags a phantom time-of-day into the next comparison. When the per-provider subquery has a real `orderDate`, we use it; the `recordDate` fallback is only there for legacy rows that predate the column, and even then it's truncated to a day.

Second, the period filter compares against the same column the data is stored in, with both bounds passed as bound parameters and the upper bound *exclusive*:

```ts
.andWhere('si.recordDate >= :startDate AND si.recordDate < :endDateExclusive', {
  startDate,
  endDateExclusive,
});
```

`>= start AND < endExclusive`, not `BETWEEN start AND end`. `BETWEEN` is inclusive on both ends, which means a `DATETIME` at exactly midnight on the last day either sneaks in or gets dropped depending on whether you remembered the `.999`. A half-open interval has no such edge: every instant belongs to exactly one period, and you compute `endDateExclusive` as the start of the *next* period instead of trying to land on `23:59:59.999` of the current one. No string formatting anywhere in the predicate. The values go in as parameters; MySQL does the comparison against the stored column type without me hand-rolling a single boundary string.

Once `recordDate` was the thing being filtered *and* the data was stored against it, the agent's eleven sales were back. The LOB fields filled in. The join was never broken; it had just been fed an empty set.

## One unrelated thing I pulled out while I was in there

Chasing this, I found a validation rule on the AT&T sale path that was rejecting legitimate sales. It refused any order that had both a mobile line and a phone line, on the theory that phone is an internet-bundle add-on. But mobile-only sales are real, and the frontend sometimes carried a stale phone selection in the payload, so a valid mobile sale got bounced with a confusing error.

The rule now allows it instead of throwing:

```ts
if (!phoneNone) {
  if (internetNone) {
    // Allow mobile-only sales even if the frontend sent a stale phone selection.
    // Phone stays restricted to internet bundles.
    if (!mobileNone) {
      phoneNone = true;
    } else {
      throw new BadRequestException(
        'Phone can only be sold with Internet. Select an Internet package.',
      );
    }
  }
}
```

Phone is still only sold with internet — that constraint is real. But a stray phone flag on a mobile sale gets quietly dropped now instead of blocking the whole order. Different bug, same afternoon.

## When this bites

The lesson isn't "timezones are hard," though they are. It's narrower than that, and I keep relearning it.

A column name is a contract about what the value *means*. The moment one column answers two different questions — "when did this hit the database" and "what day does the business count this against" — every query that touches it has to silently pick which question it's answering, and the two answers drift apart in production where the rows actually live. They look identical in your seed data. They diverge for the agent who sold at 9pm Pacific on the first of the month.

And string-built date boundaries are where the drift hides, because they never throw. A type mismatch errors. A bad parameter errors. A `DATETIME` string assembled in the wrong zone returns a perfectly valid query that's wrong by exactly one offset, and you won't see it until someone whose sales sit near a period boundary opens a report and finds nothing. Keep your timestamps as `Date` objects and bound parameters all the way to the driver; let MySQL compare against the stored type; use half-open intervals so midnight belongs to exactly one day. If you find yourself writing `${something} 23:59:59.999` to define a range, stop — that's the bug, you just haven't found the agent it breaks for yet.
