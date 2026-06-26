---
title: "Stop interpolating dates into SQL: parameterize your range filters"
description: "String-built date ranges broke timezones and invited injection. Bound parameters fix both at once."
date: "2024-11-26"
updated: "2024-11-26"
kind: "deepdive"
category: "Databases"
tags: ["sql", "typeorm", "security", "timezones"]
month: "2024-11"
repo: "backend"
author: "Sachal Chandio"
---

I was reading our sales-report query out loud to a teammate, trying to explain why a manager's monthly total was off by a couple of deals, when I got to the date filter and stopped mid-sentence. It built the range like this:

```ts
const start = `${year}-${month}-01 00:00:00`;
const end = `${year}-${month}-${lastDay} 23:59:59`;

const sql = `
  SELECT ... FROM sale_stage ss
  WHERE ss.orderDate BETWEEN '${start}' AND '${end}'
`;
```

Two things hit me at once. The first was a security problem hiding in plain sight: those values are pasted into the SQL string. The second was the bug I'd actually come to find — the range was wrong, and it was wrong in a way that depended on which server the query ran on.

I'd been staring at the timezone symptom. The injection seam was sitting right next to it the whole time, and the same change fixes both.

## How it got built this way

Nobody decided to write injectable SQL. It accreted. The report started life as a hand-tuned query with a few `LEFT JOIN`s and a `GROUP BY` that the query builder made ugly, so someone dropped to a raw template string to keep it readable. Fair enough — I've done the same. But once you're inside a backtick template, interpolating the date range feels like the path of least resistance. You've already got `${...}` everywhere. What's two more.

The dates weren't coming from a request body directly, which is the story everyone tells themselves. `year` and `month` came off query params, got parsed to numbers, and got stuffed back into a string. "It's just numbers, it's fine." And mostly it was fine, until you remember that `month` was also used, elsewhere in the same service, in a code path that accepted a free-text period label for a custom range. The moment any part of that range can carry a character a user typed, `'${start}'` is a quote away from being a problem. I don't want to be in the business of auditing every caller to prove a string is clean. I want the database to treat it as data no matter what's in it.

## The timezone half, because it's the one that bit first

Even with perfectly trusted input, the string range was wrong. Here's why.

`ss.orderDate` is a MySQL `DATE` — a calendar day, no time, no zone. The string boundaries, though, carried a time component (`00:00:00` and `23:59:59`) and were built from a `Date` that Node had already rendered in the server's local timezone. Our app boxes ran UTC. A chunk of the team's machines, and at least one staging box someone spun up, did not.

So `BETWEEN '...00:00:00' AND '...23:59:59'` meant something slightly different depending on where it executed. The `23:59:59` cutoff is the part that actually drops data: it excludes anything stamped in the last second of the day, and worse, when a downstream subquery joined against a full `DATETIME` column instead of the `DATE`, the missing `.999` meant rows at `23:59:59.500` fell outside the window. A sale booked at the very end of the last day of the month would show up for one engineer and vanish for another. Same query, same database, different wall clock on the box that built the string.

That's the failure mode I hate most. It doesn't throw. It returns a clean, plausible, wrong number, and which number you get depends on the environment, so it's a nightmare to reproduce.

## What I considered

The obvious patch was to sanitize the interpolated strings — validate that `year` and `month` are integers in range, maybe escape the result. I rejected it. Sanitizing-then-interpolating is a treadmill: it works until someone adds a new field to the range, forgets the validation, and you're back to auditing call sites. Escaping date strings by hand to defend against injection is solving a problem the driver already solved better than I will.

I also looked at keeping the strings but parsing them into `Date` objects "at the right zone" with a date library, normalizing everything to UTC before formatting. That fixes the timezone half and does nothing for the injection half. Two problems, one of them still open.

The thing that fixes both at once is the boring one: stop building SQL out of strings. Pass the boundaries as bound parameters and let the MySQL driver handle quoting and type coercion. TypeORM's query builder takes named parameters, so I didn't even have to leave the raw-ish style I was in.

And while I was there, change the shape of the interval. `BETWEEN start AND end` is inclusive on both ends, which is exactly what forces you to hunt for the right `23:59:59.999` upper bound. A half-open interval — `>= start AND < endExclusive` — sidesteps the whole edge. You compute `endExclusive` as the first instant of the *next* period and never have to think about how many nines go after the decimal point.

## Before and after

Before — string-built, inclusive, injectable, timezone-dependent:

```ts
const start = `${year}-${month}-01 00:00:00`;
const end = `${year}-${month}-${lastDay} 23:59:59`;

const rows = await this.dataSource.query(`
  SELECT ss.orderDate, ss.stage, ss.saleId
  FROM sale_stage ss
  WHERE ss.orderDate BETWEEN '${start}' AND '${end}'
`);
```

After — bound parameters, half-open, and the boundaries computed once as real `Date` objects in UTC:

```ts
// One place that builds the window. Returns Date objects, not strings.
function monthWindowUtc(year: number, month: number) {
  // month is 1-based here; Date.UTC wants 0-based, so month-1.
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  // First instant of next month — exclusive upper bound.
  const endDateExclusive = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  return { startDate, endDateExclusive };
}

const { startDate, endDateExclusive } = monthWindowUtc(year, month);

const rows = await this.saleStageRepo
  .createQueryBuilder('ss')
  .select(['ss.orderDate', 'ss.stage', 'ss.saleId'])
  .where('ss.orderDate >= :startDate AND ss.orderDate < :endDateExclusive', {
    startDate,
    endDateExclusive,
  })
  .getMany();
```

A few things changed and each one is carrying weight.

The values go in as `Date` objects through named parameters. The driver decides how to quote and format them against the column type. There is no longer a quote character in my SQL string for an attacker — or a stray apostrophe in a custom period label — to break out of, because there's no string concatenation at all. That's the injection seam closed, permanently, not patched.

`Date.UTC(...)` builds the boundaries with no dependence on the server's local zone. `new Date(\`${year}-${month}-01\`)` is parsed in local time; `Date.UTC(year, month - 1, 1)` is not. Run this on a UTC box or a US/Pacific laptop and you get the same instant. The window stopped moving when the box moved.

`>= startDate AND < endDateExclusive` is half-open. Midnight on the first of next month belongs to next month, cleanly. There is no `23:59:59.999` anywhere, so there's no off-by-a-millisecond row to lose. When this column was a `DATE` the difference was small; the day the report grew a `DATETIME` join, the half-open interval is what kept it correct without anyone having to remember the nines.

## The subtlety I almost shipped wrong

`orderDate` here is a `DATE`. Some of the joined tables key off a `DATETIME` — `createdAt`, when the row was actually written. When the same window has to filter a `DATETIME` column, the half-open shape isn't a nicety, it's the only thing that's correct. With `BETWEEN`, you'd write `... AND '2024-11-30 23:59:59'` and silently drop every row in the last second of the month. With `< endDateExclusive` and `endDateExclusive` set to `2024-12-01 00:00:00`, every instant in November is included and December starts the moment November ends. No gap, no overlap, no fencepost.

I almost left one subquery on `BETWEEN` because "it's a `DATE` column, the time doesn't matter there." It does matter the moment that subquery feeds a join against a timestamp, which this one eventually did. I made all of them half-open so I never have to remember which columns are which type. Consistency was cheaper than the cleverness.

## The tradeoff I accepted

This is slightly more code than a template string. There's a `monthWindowUtc` helper now instead of two inline string literals, and you have to know that `Date.UTC` is zero-based on the month and `getMany` wants `Date` objects, not formatted strings. If you pass it a string, TypeORM will still bind it — but then you're back to relying on the format, and a string like `'2024-11'` binds differently than you'd hope. The discipline is: build `Date` objects up front, pass `Date` objects all the way down, never format a boundary into a string anywhere in the path. The day someone reintroduces a string boundary "just for logging" and then reuses it in the query is the day this regresses.

I also gave up the ability to eyeball the final SQL with the dates already baked in. With bound parameters the logged query shows `?` placeholders (or `:startDate`), not the literal range, so debugging a window means logging the parameters separately. Minor. I'd rather read placeholders and trust the driver than read a fully-interpolated string and have to trust every caller that built it.

If you take one thing from this: the timezone bug and the injection bug were the same bug wearing two hats, and the fix for both is to stop letting SQL and your application's strings touch. Hand the driver typed values and let it do the quoting it was built to do. The first time you watch a monthly total stay identical across three machines that used to disagree, you'll stop interpolating dates for good.
