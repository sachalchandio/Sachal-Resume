---
title: "A timezone survival guide for line-of-business apps"
description: "Store one zone, render another; ISO at the edges; parameterize ranges; and why ‘just use UTC’ sometimes loses."
date: "2024-12-20"
updated: "2024-12-20"
kind: "deepdive"
category: "Databases"
tags: ["timezones", "dates", "mysql"]
month: "2024-12"
repo: "both"
author: "Sachal Chandio"
---

Every date bug I shipped on Telelinkz was the same bug. Not literally — they wore different hats — but they all traced back to two values that were supposed to mean the same calendar day disagreeing about which zone they lived in, and nobody noticing until the disagreement crossed midnight. A rep saw December 2nd for a sale she filed on the 1st. A report came back empty for an agent who had closed eleven deals. A table sorted three different string formats of the same field. None of them threw. That's the through-line: timezone bugs don't crash, they return a clean, plausible, wrong answer, and which answer you get depends on the wall clock of the box that built the query.

So this is the survival guide I wish I'd had. Four rules, each one paid for. They are not in tension with the textbook — mostly they *are* the textbook — except the first one, which is where the textbook and the floor in Ohio part ways.

## Rule 1: Pick one storage zone on purpose, and write it down

"Always store UTC" is good advice and I still reach for it first. It's also advice that assumes every consumer of the data converts on the way out. Ours didn't.

The Telelinkz floor is in Ohio. Eastern time. There is exactly one office and there will not be a second one — that's not an architecture decision, it's a fact about the business. The data has one audience, and that audience reads the database through five different tools: the Angular app, a couple of Bull jobs that bucket sales by day, raw exports a manager opens in a spreadsheet, reporting queries, and a SQL console the operations lead types into directly. Every one of those is a place where "convert at the edges" means "remember to apply the offset." Humans don't.

The symptom: a server running UTC, a `@BeforeInsert` hook calling `new Date()`, and a rep saving a sale at 8pm Eastern. The server clock already reads 1am the next day, so `createdAt` writes tomorrow's date. The list view sorted by `createdAt`, so it showed tomorrow. One query found every drifted row:

```sql
SELECT id, orderDate, createdAt
FROM sale
WHERE DATE(createdAt) <> orderDate
ORDER BY createdAt DESC
LIMIT 20;
```

Every result was created after roughly 7pm Eastern. Every one had `createdAt` a day ahead. The fix was to stop handing the database a UTC instant and hand it Eastern wall-clock time instead:

```ts
// Eastern Standard. The floor is in Ohio and there is exactly one office.
const EST_OFFSET_MS = 5 * 60 * 60 * 1000;

export function nowInOffice(): Date {
  return new Date(Date.now() - EST_OFFSET_MS);
}
```

I'll defend this against the purists. The database no longer holds true UTC instants — and I'm at peace with that, because nobody downstream was treating them as instants anyway. A single-timezone shop is allowed to store wall-clock time. It's matching the storage to the reader, not heresy.

The discipline that makes it survivable is the *on purpose* part. I wrote in the PR: "the day we open a second office, this is wrong and I migrate to UTC." I set `TZ=America/New_York` in the deploy env so any stray `new Date()` I missed at least agrees with the helper instead of fighting it. The helper is the source of truth; the env var keeps the surprises small. Deliberate beats default. A zone you chose and documented is recoverable. A zone that leaked in from a container default is a landmine.

## Rule 2: Normalize to ISO at the API boundary, on write

Storage zone is half the problem. The other half is *format*, and format rots at the seams where data enters.

Telelinkz integrates a stack of telecom providers — AltaFiber, AT&T, Xfinity, more behind a dynamic-form builder — each built in a different sprint by whoever was free. Each invented its own way of writing `orderDate` to MySQL. Some stored a real `datetime`. Some stored a `YYYY-MM-DD` string in a `varchar`. The create path often just handed the form payload straight to `repository.save`. The DTOs all declared `@Field(() => String)`, which means GraphQL does *nothing* on the way out — whatever string sits in the row ships to the wire verbatim.

The day it bit: a table sorting `2024-11-08T00:00:00.000Z`, `2024-11-08`, and `Fri Nov 08 2024 00:00:00 GMT+0000` — same field, same query, different rows. The client's `new Date(a) - new Date(b)` returned nonsense whenever the coercion disagreed.

My first instinct was wrong, and I shipped it: a parser on the Angular side that sniffed the three known shapes. It worked, and it meant the API was still lying — the next consumer would hit the same mess and write the same parser. Patching the reader is how you get five readers and one broken writer.

The fix lives at the boundary, on write, so the column only ever holds one canonical shape:

```ts
// Coerce at the create boundary. Order matters: check before you convert.
export function toIsoDateOrNull(value?: string | Date | null): string | null {
  if (value === undefined || value === null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null; // Invalid Date, not a throw
  return d.toISOString();
}
```

That `Number.isNaN(d.getTime())` guard is load-bearing. The naive version was `new Date(input.installationDate).toISOString()`, and `installationDate` is usually undefined — installation gets scheduled later. `new Date(undefined).toISOString()` throws a `RangeError`, so a valid sale with no install date yet blew up the whole create. Validation after use, the classic ordering bug. Fix the writer once and every reader is fixed for free.

## Rule 3: Always parameterize range filters — never build them from strings

This is the one I'd tattoo on a junior. The single highest-leverage habit in date handling is: no date boundary ever becomes a string that touches your SQL.

I found this reading a sales-report query out loud to a teammate. It built the month range like this:

```ts
const start = `${year}-${month}-01 00:00:00`;
const end = `${year}-${month}-${lastDay} 23:59:59`;

const rows = await this.dataSource.query(`
  SELECT ... FROM sale_stage ss
  WHERE ss.orderDate BETWEEN '${start}' AND '${end}'
`);
```

Two bugs, same line. The injection seam — those values pasted into the SQL string, and `month` was reused elsewhere in a code path that accepted a free-text custom-period label. And the timezone bug: `new Date(\`${year}-${month}-01\`)` parses in the server's *local* zone. On a UTC box it's one instant; on someone's Pacific laptop it's another. The `23:59:59` cutoff drops anything in the last second of the day, and the missing `.999` drops `23:59:59.500` once a downstream join hits a `DATETIME` column. Same query, same database, different wall clock — so a sale at the end of the month shows up for one engineer and vanishes for another.

The fix kills both at once. Build `Date` objects in UTC, pass them as bound parameters, and use a half-open interval:

```ts
function monthWindowUtc(year: number, month: number) {
  // month is 1-based; Date.UTC wants 0-based.
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDateExclusive = new Date(Date.UTC(year, month, 1)); // first instant of next month
  return { startDate, endDateExclusive };
}

const { startDate, endDateExclusive } = monthWindowUtc(year, month);

await this.saleStageRepo
  .createQueryBuilder('ss')
  .where('ss.orderDate >= :startDate AND ss.orderDate < :endDateExclusive', {
    startDate,
    endDateExclusive,
  })
  .getMany();
```

`Date.UTC` doesn't care what zone the box is in. Bound parameters mean the driver quotes and coerces against the column type — there's no string for an apostrophe to break out of, so the injection seam is closed permanently, not patched. And `>= start AND < endExclusive` is half-open: midnight on the first of next month belongs to next month, cleanly. No `23:59:59.999`, no fencepost, no off-by-a-millisecond row to lose.

I almost left one subquery on `BETWEEN` because "it's a `DATE` column, the time doesn't matter." It does the moment that subquery feeds a join against a `DATETIME`, which this one eventually did. I made all of them half-open so I never have to remember which column is which type. If you ever write `${something} 23:59:59.999` to define a range, stop — that's the bug, you just haven't found the agent it breaks for yet.

## Rule 4: One column, one meaning

The subtlest failure isn't zone or format. It's overloading.

The Sale Status report came back empty for an agent with eleven closed deals — a 200 status lying about its contents. I stared at the line-of-business join for twenty minutes before realizing the join was fine; it was being fed zero rows. The culprit was one column doing two jobs:

```ts
.andWhere('si.recordDate >= :startDate AND si.recordDate < :endDateExclusive', {
  startDate,
  endDateExclusive,
})
// ...and the same column, down in the aggregation:
"'createdAt', COALESCE(sp.createdAt, si.recordDate), " +
"'orderDate', COALESCE(sp.orderDate, DATE(si.recordDate)), " +
```

`recordDate` was both the period filter *and* the fallback for two different timestamps. `createdAt` is when the row hit the database — a UTC `DATETIME`. `orderDate` is the business day the customer's order is booked against — a bare calendar day with no zone, whatever the rep typed. They are not the same thing and don't even share a type. The agent's sales were filed late in the day; once `orderDate` got compared against a UTC-ish `recordDate`, the window slid off the end of them. Eleven sales fell on the wrong side of `>= :startDate`. Zero rows in, null everything out.

A column name is a contract about what the value *means*. The moment one column answers two questions — "when did this hit the database" and "what day does the business count this against" — every query silently picks which one it's answering, and the two drift apart in production where the rows actually live. They look identical in seed data. They diverge for the agent who sold at 9pm on the first of the month. The fix was to resolve them independently and truncate the day-only one with `DATE(...)` so it never drags a phantom time-of-day into the next comparison.

## When the advice is wrong

Rule 1 is wrong the day you open the second office. Wall-clock storage is ambiguous the instant two zones read the same table, and you're back to UTC plus a migration. I'd give "store UTC" to anyone starting fresh — I only stored Eastern because the single-audience, five-readers, nobody-converts situation was already true and the cheaper fix was to make the stored value correct for the only people who read it.

Rule 4 has an exception too: sometimes one column *is* the right answer, when "created" and "ordered" genuinely are the same event and you're inventing a distinction the business doesn't have. Two columns you keep in sync by hand is its own bug. The test is whether a manager would ever file something under a different day than it was entered. For sales, yes — backdating happens. For an audit log, no.

And UTC isn't a free pass. It moves the bug, it doesn't delete it. Store flawless UTC and you've just relocated the offset to render time, where a forgotten conversion in one of five readers produces the exact same off-by-five-hours wrong number. The zone you store is a decision about *where* the conversion lives, not whether you need one.

## The rules of thumb, earned

Keep timestamps as `Date` objects and bound parameters all the way to the driver — the first string boundary is where drift hides, because strings never throw. Use half-open intervals so every instant belongs to exactly one period and midnight is never ambiguous. Normalize format once at the write boundary, not in every reader. Give every date column exactly one meaning and put it in the name. Pick your storage zone deliberately and write down the day it stops being right.

The day someone reintroduces a string boundary "just for logging" and then reuses it in a query is the day all of this regresses. Timezone bugs are patient. They wait for the one agent whose sales sit on the boundary, the one evening that crosses midnight, the one box set to the wrong zone — and then they return a perfectly valid answer that happens to be wrong. The whole guide is just refusing to give them anywhere to hide.
