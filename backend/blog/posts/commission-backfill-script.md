---
title: "Writing a backfill script you can actually trust (missing / all / date-range / dry-run)"
description: "When commission became part of the search index, history needed backfilling. The flags that kept it safe."
date: "2025-11-13"
updated: "2025-11-13"
kind: "deepdive"
category: "Backend"
tags: ["scripts", "backfill", "typeorm", "data-migration"]
month: "2025-11"
repo: "backend"
author: "Sachal Chandio"
---

We moved commission onto the `search_index` table. That was the whole change — one `decimal(10,2)` column, indexed, denormalized so the analytics queries could read commission without joining four tables of package versions per sale. The migration added the column with a default of `0`. Which meant every sale we'd ever recorded now had a commission of exactly zero, and the live indexing path only filled it in going forward. New sales got real numbers. The hundreds of thousands of historical rows were a wall of zeros lying confidently to the dashboard.

So I needed to walk the history and compute commission for rows that already existed. That's a backfill. The naive version is a `for` loop and an `UPDATE`. The version I actually wanted to run against production was a lot more careful, because the thing about a backfill is that it touches real rows at scale and there is no undo button waiting for you afterward.

## What the column actually holds

Commission isn't stored on the sale. It lives on `package_version` — each version of a package carries its own `commission` value, and a sale references the specific versions it was sold under via a pile of `*PackageId` columns that differ per provider. Xfinity has `internetPkgVersionId`, `tvPkgVersionId`, `phonePkgVersionId` and more; AT&T has `internetPackageId`, `phonePackageId`, `mobilePackageId`. There are twenty-something providers, each with its own table (`xfinity_sale`, `atnt_sale`, `spectrum_sale`) and its own set of package fields.

So computing commission for one historical sale means: look up the provider, pull the right package-id columns from the right per-provider table, fetch the `commission` for each of those package versions, and sum. Mobile is special — it multiplies by the number of lines. The shape of it:

```ts
// per sale: sum the commission of every package version it was sold under
let total = 0;
for (const item of selected) {
  const base = commissionBySalePvId.get(item.salePackageVersionId) || 0;
  total += item.field === 'mobilePackageId' ? base * mobileLines : base;
}
```

None of that is the interesting part. The interesting part is the harness around it — the flags that let me run it on a slice, see what it would do, and trust the count at the end.

## Three modes, because "backfill" means three different jobs

I gave the script a `--mode` flag with three values, and the difference between them is which rows it touches and when it decides to write.

`--mode=missing` is the conservative one. It only looks at rows where commission is null or zero, and it only writes when it computed something positive. This is the mode for the first real run: fill in the gaps, never overwrite a number that's already there. The guard is explicit:

```ts
const shouldUpdate =
  MODE === 'missing'
    ? calculatedCommission > 0 && currentCommissionNum === 0
    : calculatedCommission !== currentCommissionNum;
```

`--mode=all` recomputes everything and writes whenever the new number differs from the stored one. You reach for this after you've fixed a bug in the calculation itself — say the mobile-lines multiplier was wrong — and you need to correct rows that already have a (wrong) value. It's the heavier hammer. It will happily overwrite, which is exactly why it's not the default.

The default is `missing`. If someone runs the script with no flags at all, the worst it does is fill blanks. That's a deliberate choice: the safe mode is the one you get by forgetting to pass arguments.

I also kept a `recheck` mode around for spot-auditing, but in practice `missing` and `all` are the two that matter. Two modes would have been enough. Three was me hedging.

## The date window, and why `--since` and `--until` earn their keep

`--since` and `--until` clamp the run to a `recordDate` range:

```ts
if (SINCE) whereClauses.push(`si.recordDate >= '${SINCE}'`);
if (UNTIL) whereClauses.push(`si.recordDate <= '${UNTIL} 23:59:59'`);
```

These exist for two reasons. The first is blast radius. The very first time you run a backfill against production, you do not run it against all of history. You run it against last week — `--since=2025-11-01` — eyeball the result, check a handful of rows by hand against what you know the commission should be, and only then widen the window. A date range turns "rewrite the entire table" into "rewrite a Tuesday."

The second reason is resumability. If a run dies halfway — connection drops, you lose the VPN, the box reboots — you don't start over. You note where the progress log was and restart with a `--since` past the part that finished. It's a poor man's checkpoint, but it costs one flag and it has saved me an hour more than once.

The `23:59:59` tacked onto `--until` is there because `recordDate` is a `datetime`. Without it, `<= '2024-12-31'` reads as midnight at the *start* of the 31st and silently drops everything that happened during that day. If I were writing this again I'd compute an exclusive upper bound — `< '2025-01-01'` — and pass both ends as bound parameters instead of interpolating the strings into the WHERE clause. The values come from my own argv here, not from users, so it's not an injection risk, but interpolating dates is exactly the habit that bites you in the report query three files over. Do it right even when it doesn't matter, so the muscle memory is correct when it does.

## Chunking, because you can't hold the table in memory

There are hundreds of thousands of these rows. You don't `SELECT *` them into a Node array. The loop pages through with `LIMIT`/`OFFSET` and a stable `ORDER BY`:

```ts
const searchQuery = `
  SELECT si.id, si.recordId, p.code as providerCode, si.commission as currentCommission
  FROM search_index si
  LEFT JOIN provider p ON si.providerId = p.id
  ${whereClause}
  ORDER BY si.recordDate ASC
  LIMIT ${BATCH_SIZE} OFFSET ${offset}
`;
```

`BATCH_SIZE` defaults to 500 and is itself a flag. The `ORDER BY si.recordDate ASC` matters — without a deterministic order, OFFSET pagination can skip or repeat rows as the underlying data shifts, and "this row got processed twice" is a fun bug to chase in a script whose whole job is to mutate rows. In a `missing` run, reprocessing is harmless because the write is idempotent — once commission is set, the `currentCommissionNum === 0` guard skips it next time. In an `all` run it'd just recompute the same value. The ordering is cheap insurance either way.

Honest caveat: `OFFSET` on a large table gets slower the deeper you page, because MySQL still walks and discards the rows it's skipping. For a one-shot backfill of this size it was fine. If this were a recurring job over millions of rows I'd switch to keyset pagination — `WHERE recordDate > :lastSeen ORDER BY recordDate LIMIT 500` — and drop OFFSET entirely. I didn't, because it ran in a few minutes and I had other things to do. That's a real tradeoff, not a confession.

## The dry run is non-negotiable

Here's the flag I will not write a backfill without. `--dry-run` does everything — reads the rows, computes the commission, evaluates the `shouldUpdate` guard, increments the same counters — and skips exactly one line: the `UPDATE`.

```ts
if (shouldUpdate && !DRY_RUN) {
  await connection.execute(
    'UPDATE search_index SET commission = ? WHERE id = ?',
    [calculatedCommission, searchIndexId],
  );
  updated++;
} else if (shouldUpdate && DRY_RUN) {
  updated++; // count what we *would* have changed
}
```

The point is that the dry run gives you a real number for how many rows the live run will touch. Not an estimate. The exact count, produced by the exact same decision logic, because the only thing the `DRY_RUN` flag changes is whether the `UPDATE` fires. If a dry run says it'll update 12,400 rows and the table has 300,000, and you expected it to fill most of them — stop. Something in the calculation is returning zero. Go find out why before you write anything.

That's not hypothetical. The first time I dry-ran this, it reported far fewer updates than there were zero-commission rows, and the `zeroCommission` counter was huge. The package-version lookup was returning nothing for a chunk of providers because their package ids hadn't been populated on those old sales — there was no commission to compute, the data simply wasn't there. A dry run turned "I corrupted history" into "oh, these rows were always going to stay zero, and now I know why." That distinction is the entire reason the flag exists.

A dry run that just prints "would update some rows" is theater. A dry run that runs the real decision path and hands you the real count is the difference between confidence and hope.

## Count everything, then print the counts

The other half of trust is the tally at the end. Every row falls into exactly one bucket and every bucket has a counter: `processed`, `updated`, `skipped` (no provider mapped), `zeroCommission` (computed to nothing), `errors`. The run prints them:

```ts
console.log(`📊 Total processed: ${processed.toLocaleString()}`);
console.log(`📝 Total updated: ${updated.toLocaleString()}`);
console.log(`⏭️ Total skipped (no provider): ${skipped.toLocaleString()}`);
console.log(`💰 Zero commission calculated: ${zeroCommission.toLocaleString()}`);
console.log(`❌ Total errors: ${errors.toLocaleString()}`);
```

These numbers are how you reconcile. `processed` should equal the total the count query found. `updated + (rows that were already correct) + skipped` should account for everything. If `errors` is anything but zero, the per-row `catch` logged which provider and sale id blew up, and you go look. A single sale failing to compute shouldn't abort a run of three hundred thousand — it gets caught, counted, and the loop moves on:

```ts
} catch (error) {
  console.warn(`⚠️ Error processing ${providerCode}:${saleId} -> ${error.message}`);
  errors++;
}
```

A progress line every batch (`Progress: 45,000/312,000 (14.4%)`) means I'm not staring at a dead terminal wondering whether it hung. For a long-running script against production, "is it still alive" is a real question, and a heartbeat is the cheap answer.

## What I'd change next time

The interpolated date strings, first — bound parameters and an exclusive upper bound, for the reasons above. And I'd build the run-on-a-slice workflow into the script instead of relying on myself to remember it: a `--limit` that caps total rows regardless of the date window, so the very first production run is mechanically incapable of touching more than, say, a thousand rows no matter what flags I fat-finger.

I'd also drop the OFFSET paging for keyset if this ever became a recurring job, and I'd write the final counts to a row in an audit table rather than only to stdout, so there's a record of "we backfilled commission on the 13th, touched 248,902 rows, 0 errors" that survives the terminal scrollback.

But the bones are right, and the bones are the cheap part. Modes that default to the safe one. A date window so the first run is a slice. Chunked reads with a stable order. Counters for every outcome. And a dry run that exercises the real decision path and hands you the real number before a single row changes. A backfill you trust isn't one that's clever. It's one that told you exactly what it was going to do, and then did exactly that.
