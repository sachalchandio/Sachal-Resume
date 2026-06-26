---
title: "Search that survives filthy data: casing, whitespace, and the disposition-date filter"
description: "Real customer data is messy. Making name search and date filters tolerant without making them slow."
date: "2024-09-15"
updated: "2024-09-15"
kind: "deepdive"
category: "Backend"
tags: ["search", "mysql", "data-quality"]
month: "2024-09"
repo: "backend"
author: "Sachal Chandio"
---

A team lead pinged me on a Tuesday: "I searched a customer's name and got nothing, but the sale is right there in the list." She sent a screenshot. The sale was visible in the table — `John  Smith`, dispositioned that morning. She typed `john smith` into the search box and the grid emptied out. Zero results. The row she could see with her own eyes had vanished.

My first instinct was wrong, so let me walk it the way it actually went.

## The wrong guess: pagination

The dynamic-sale grid is paginated and filtered server-side. My first theory was that search and pagination were fighting — that the search ran against page one's slice instead of the whole table, so a match on a later page never surfaced. That's a real class of bug, I've shipped it before, and it would explain "I can see it but search can't find it" if the row lived on page three.

I checked. The query builder applies the search predicate before `take`/`skip`, against the full table. Pagination was innocent. The match wasn't on a later page. The match wasn't being produced at all.

So I copied the exact name out of the row and pasted it into the box. Still nothing. That's when it stopped being a query-structure problem and became a data problem, which is a different and more annoying animal.

## The actual cause: the bytes don't match what your eyes see

I pulled the raw row. The column was `cx_firstName = 'John'` and `cx_lastName = 'Smith '` — with a trailing space. And in a few hundred other rows, names came in as `JOHN`, `Smith`, `mcdonald`, `O'Brien ` with leading whitespace, every casing permutation a human and three different intake forms can produce. This data flows in from sales agents typing fast, from a dialer export, and from a provider's own API. None of those three sources agree on casing or trimming, and none of them should be trusted to.

The search clause was a plain `LIKE` with the term wrapped in wildcards:

```ts
if (search) {
  queryBuilder.andWhere(
    '(sale.cx_firstName LIKE :search ' +
      'OR sale.cx_lastName LIKE :search ' +
      'OR sale.email LIKE :search ' +
      'OR sale.orderNumber LIKE :search ' +
      'OR sale.phoneNumber LIKE :search)',
    { search: `%${search}%` },
  );
}
```

Here's the subtle part. MySQL `LIKE` on a `utf8mb4_general_ci` or `_unicode_ci` column is case-insensitive by collation, so `JOHN` would have matched `john` on its own. Casing wasn't actually the thing that bit *this* search. The trailing space was. The user searched `john smith` as one token, but the stored value is `John` in one column and `Smith ` in another — the search term spanned two columns and never matched either. And the moment a user did paste a single name with an accidental leading space, `' john'` against `cx_firstName LIKE '% john%'` failed too, because the wildcard sits outside the space the user fat-fingered.

The lesson underneath: collation hides *some* dirt and lulls you into thinking the column is clean. It papers over casing and then you assume whitespace is handled too. It isn't. `'Smith'` and `'Smith '` are different strings under any collation, and `LIKE '%smith%'` matches both — but exact-equality filters elsewhere in the same query don't, and that inconsistency is where bugs breed.

## Making the match tolerant

I normalized both sides of the comparison. Lowercase and trim the column, lowercase and trim the term, and compare the cleaned versions. The column side uses MySQL's `TRIM` and `LOWER`; the term side gets cleaned in TypeScript so I'm not shipping junk into the parameter:

```ts
if (search) {
  const term = `%${search.trim().toLowerCase()}%`;
  queryBuilder.andWhere(
    '(LOWER(TRIM(sale.cx_firstName)) LIKE :search ' +
      'OR LOWER(TRIM(sale.cx_lastName)) LIKE :search ' +
      "OR LOWER(TRIM(CONCAT(sale.cx_firstName, ' ', sale.cx_lastName))) LIKE :search " +
      'OR LOWER(TRIM(sale.email)) LIKE :search ' +
      'OR sale.orderNumber LIKE :search ' +
      'OR sale.phoneNumber LIKE :search)',
    { search: term },
  );
}
```

Two things changed beyond the obvious `LOWER(TRIM(...))`. First, the `CONCAT(firstName, ' ', lastName)` branch — that's what fixes the original report. "john smith" is one search token and needs one concatenated haystack to match against, not two separate columns. Second, I left `orderNumber` and `phoneNumber` untrimmed-but-not-lowercased on purpose; order numbers are already canonical and phone numbers get normalized to digits at write time, so spending `LOWER(TRIM())` on them is wasted work.

Now, the honest tradeoff. Wrapping a column in `LOWER(TRIM(...))` makes the predicate non-sargable — MySQL can't use a plain B-tree index on `cx_firstName` once it's wrapped in functions, so this is a full scan over the filtered set. For the dynamic-sale grid that's fine: by the time the search clause runs, the query is already narrowed by workspace, provider, status, and a date range, so it's scanning thousands of rows, not millions. If this were searching the entire sales table unfiltered I'd reach for a generated column — store a `cx_searchName` that's `LOWER(TRIM(CONCAT(...)))` computed at write time and indexed — and match against that instead. I didn't, because the win wasn't worth the migration here. That's the kind of call worth making consciously rather than reflexively reaching for the "correct" answer.

The deeper fix is at the boundary. I now trim on write for these fields, so new rows come in clean and the read-time normalization is only there to cover the historical mess:

```ts
// in the create path, before persist
input.cx_firstName = input.cx_firstName?.trim();
input.cx_lastName = input.cx_lastName?.trim();
```

Read-side tolerance protects you from the data you already have. Write-side trimming stops you from making more of it. You want both — trimming on write alone doesn't retroactively clean three years of rows, and `LOWER(TRIM())` on read alone means every query pays for dirt you could have stopped at the door.

## The date filter that quietly did nothing

While I was in there, the same lead mentioned the date filter "doesn't seem to do anything." Different symptom, same family of problem.

The grid lets you filter sales by their disposition date — when the sale was worked, stored on `sale.orderDate`. Pick a single day, you should see that day's sales. The filter was passed as a `yyyy-mm-dd` string from the frontend, and the original code did the lazy thing: compared the column directly to the date string. `sale.orderDate = '2024-09-10'`. That matches nothing, because `orderDate` is a `DATETIME` and stores `2024-09-10 14:22:08`, never `2024-09-10 00:00:00.000` on the nose. A `DATETIME` equals a date-only string roughly never.

The fix is to treat a single day as the half-open range it actually is — the whole 24 hours — and the multi-day case as an explicit `BETWEEN`:

```ts
if (filter.orderDate) {
  const orderDateStart = new Date(`${filter.orderDate} 00:00:00`);
  const orderDateEnd = new Date(`${filter.orderDate} 23:59:59.999`);
  queryBuilder.andWhere('sale.orderDate BETWEEN :odStart AND :odEnd', {
    odStart: orderDateStart,
    odEnd: orderDateEnd,
  });
  delete filter.orderDate;
}
```

That `delete filter.orderDate` line matters more than it looks. Further down, the service has a generic loop that turns any leftover filter key into `sale.<key> = :value`:

```ts
Object.entries(filter).forEach(([key, value]) => {
  if (value !== undefined && value !== null && value !== '' && value !== 'NONE') {
    queryBuilder.andWhere(`sale.${key} = :${key}`, { [key]: value });
  }
});
```

If I handle `orderDate` as a range above but forget to delete it from the filter object, this loop *also* appends `sale.orderDate = '2024-09-10'` — the exact broken equality I just replaced — and ANDs it back in. The two predicates together guarantee zero rows. That's almost certainly what the original bug was: a range branch was bolted on later, but the key was never removed from the catch-all, so the dead equality clause silently killed every result. Deleting handled keys before the generic loop runs is the actual fix; the `BETWEEN` was only half of it.

For a multi-day window the same shape applies, with validation so a malformed string fails loud instead of matching nothing:

```ts
if (filter.startDate && isNaN(Date.parse(filter.startDate))) {
  throw new Error('Invalid startDate format. Expected yyyy-mm-dd.');
}
const saleStartDate = filter.startDate ? new Date(`${filter.startDate} 00:00:00`) : null;
const saleEndDate = filter.endDate ? new Date(`${filter.endDate} 23:59:59.999`) : null;
if (saleStartDate && saleEndDate) {
  if (saleStartDate > saleEndDate) throw new Error('startDate cannot be after endDate.');
  queryBuilder.andWhere('sale.orderDate BETWEEN :saleStartDate AND :saleEndDate', {
    saleStartDate, saleEndDate,
  });
}
```

Throwing on `start > end` and on an unparseable date is deliberate. A filter that silently returns nothing is the worst failure mode there is, because it looks exactly like "no data matched." The lead spent ten minutes assuming the day genuinely had no sales before she thought to question the filter. An error message would have saved her that.

## While I was there: findByUser

The visibility query that decides which clients a user can see — `findByUser` in the client service — had a related smell. Regular users see clients they created plus clients where they have an assigned task, and that second set comes from a raw `SELECT DISTINCT t.clientId FROM tasks t WHERE t.assignedToId = ?`. Fine. But the original passed those ids back into a `find({ where: { id: In(ids) } })` even when `ids` was empty, and `IN ()` is a syntax error in MySQL — or, depending on how the ORM serializes it, a clause that matches everything. So I guard the empty case explicitly and fall back to created-clients-only:

```ts
if (ids.length === 0) {
  return this.clientRepository.find({
    where: { createdBy: { id: userId }, isActive: true },
    relations: ['createdBy', 'workspace', 'groups'],
    order: { createdAt: 'DESC' },
  });
}
return this.clientRepository.find({
  where: [
    { createdBy: { id: userId }, isActive: true },
    { id: In(ids), isActive: true },
  ],
  // ...
});
```

An empty `IN` list is one of those edge cases that never shows up in your tests, because your test user always has tasks. The first user in production with a brand-new account and zero assignments is the one who finds it.

## When this bites

It bites whenever the input crosses a boundary you don't own. The names came from agents and a dialer and a provider API, and not one of those will ever hand you trimmed, consistently-cased data, no matter how clearly the contract says they should. Your tests are clean because *you* typed them, and you typed them the way the schema wants. The trailing space, the all-caps name, the `IN ()` for the user with no tasks, the date string compared to a `DATETIME` — none of those live in a fixture you'd think to write.

So I've started assuming two things by default. Any string from outside gets normalized on both ends — trimmed and case-folded on write so new data is clean, and compared in normalized form on read so old data still matches. And any filter that can match nothing should be able to tell you *why* it matched nothing — throw on garbage input instead of returning an empty grid that looks identical to a genuinely empty result. The empty result that lies to you is the one that costs an afternoon.
