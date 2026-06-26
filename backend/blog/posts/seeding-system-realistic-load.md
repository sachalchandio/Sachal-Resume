---
title: "A seeding system built to test analytics under real load"
description: "Ten seed rows hide every scaling bug. A configurable seeder that loads sales, calls and the search index."
date: "2025-09-18"
updated: "2025-09-18"
kind: "deepdive"
category: "DevOps"
tags: ["seeding", "testing", "scripts"]
month: "2025-09"
repo: "backend"
author: "Sachal Chandio"
---

The "Sales by Agent" dashboard looked great on my machine. Sub-100ms, every chart instant, the date filters snappy. Then I ran the same query against a window where one agent had a few thousand call logs instead of four, and the p95 fell off a cliff. The chart spinner just sat there. The query plan that was fine over 40 rows was doing a filesort over a join the moment the table had real depth to it.

That's the thing nobody tells you about the ten-row fixture. It doesn't test your analytics. It tests whether your analytics return *something*. Whether they return it in time, with the right index, without the ORM quietly N+1ing across a relation — none of that shows up until the data has shape and volume. So before I trusted a single number on those live dashboards, I needed the database to look like production. Not production data — I was never going to copy real customer PII into a dev box — but production *shape*: hundreds of agents, tens of thousands of call logs spread across a believable date window, sales skewed across providers the way they actually skew, and a search index that mirrors it all.

This is the seeder I built for that. It's a NestJS standalone context script over TypeORM and MySQL, and the design is mostly about the parts you don't see in a tutorial: resume, date windows, and the toggles that let you trade fidelity for speed when you're iterating.

## The config is the whole design

Everything routes through one config object and one entry point. The shape:

```ts
export interface MasterSeedConfig {
  users: number;
  customers: number;
  tasks: number;
  // ...chats, events, notifications
  batchSize: number;
  useMultipleWorkers: boolean;
  truncateFirst: boolean;
}
```

And three named presets, because "how much data" is really three different questions. `seedTesting()` is 10 users and 50 customers — fast enough to run in a watch loop. `seedDevelopment()` is 100 users and 30K customers. `seedProduction()` is 500 users and 200K customers, `batchSize: 2000`, workers on. The runner picks one from `argv`:

```bash
npm run seed:all production
npm run seed:all custom 100 30000 1057 5000
```

The named modes matter more than they look. When I'm debugging a single chart I want `testing` volume — instant feedback. When I'm load-testing the search endpoint I want `production`. Having to hand-edit a number every time is how you end up accidentally seeding 200K rows into the wrong database, which I did exactly once, which is part of why the next section exists.

## Non-destructive by default, and I mean it

The original seeder truncated everything first. Clean slate, deterministic, the textbook move. It's also a loaded gun pointed at whatever database your `.env` happens to point at — and mine points at a shared RDS instance, not localhost. So I gutted it. `truncate()` and `truncateAllTables()` are still there as methods, but they're no-ops that log a warning and return:

```ts
async truncate(): Promise<void> {
  const tableName = this.repository.metadata.tableName;
  // Non-destructive mode: do not truncate tables
  console.log(`truncate() is disabled for table: ${tableName}. No data was deleted.`);
}
```

Leaving the method as a no-op instead of deleting it was deliberate. The call sites still compile, and the warning shows up in the log so future-me knows the safety is *on*, not missing. Seeding became purely additive. The cost is that you can run it twice and double your data — which is real, and which is exactly why the resume feature had to be good.

## Resume and date windows

The heaviest part is call logs. I model them as `interested_customer` rows — one row per call an agent makes — and I want them distributed the way calls actually happen: every active agent, every day, 30 to 50 of them, across a window of days. That's the realistic shape the dashboards group on.

The core loop walks a date offset from today and, for each day, each agent gets a faker-random count of calls placed at random times within that day:

```ts
for (let offset = -daysBefore; offset <= daysAfter; offset++) {
  const day = new Date(today);
  day.setDate(today.getDate() + offset);
  const dayStr = day.toISOString().slice(0, 10);

  // resume + hard window filters
  if (resumeFromDate && dayStr < resumeFromDate) continue;
  if (startDate && dayStr < startDate) continue;
  if (endDate && dayStr > endDate) continue;

  for (const agent of agentChunk) {
    const callsToday = this.faker.number.int({ min: minPerAgentPerDay, max: maxPerAgentPerDay });
    // ...generate, push to batch, flush at thresholds
  }
}
```

The string comparison on `YYYY-MM-DD` is doing real work there. ISO dates sort lexicographically the same way they sort chronologically, so `dayStr < resumeFromDate` is a correct date comparison without parsing anything back into a `Date`. Cheap and right.

Why resume at all? Because the run is long and the connection to RDS is over the open internet with real latency, and a seeding run *will* die partway — a transient network blip, a lock wait timeout, me hitting Ctrl-C because I noticed a bad value. When it dies on 2025-10-04, I don't want to re-seed everything from the start of the window and double up the earlier days. I pass `resumeFromDate: '2025-10-04'` and it skips straight to where it stopped. Combined with the non-destructive default, that's the whole recovery story: rerun, point at the day it died, carry on.

The dispositions aren't uniform either, because real call outcomes aren't:

```ts
const dispositions = [
  { item: CallDisposition.CUSTOMER_SERVICE, weight: 50 },
  { item: CallDisposition.LEAD_INTERESTED,  weight: 20 },
  { item: CallDisposition.SALE_MADE,        weight: 10 },
  { item: CallDisposition.CALLBACK,         weight: 10 },
  { item: CallDisposition.WRONG_NUMBER,     weight: 3 },
  // DNC, DEAD_CALL, SPANISH_CUSTOMER...
];
```

A 10% sale rate, half the calls going to plain customer service. If I'd seeded these uniformly, the "conversion by disposition" chart would have been a flat bar and I'd never have caught that one of the aggregation queries was double-counting `CALLBACK` rows. Realistic *distribution* is what makes seed data a test instead of a placeholder.

## Performance toggles

The seeder writes to two tables for every call log: the `interested_customer` row and a `search_index` row that powers global search. Building the searchable text — lowercased name, email, phone, address, city, state, zip all joined — and bulk-inserting it roughly doubles the write cost. Most of the time I don't care; I'm iterating on a sales chart, not search. So there's a toggle:

```ts
const { created } = await this.customerSeeder.seedCallLogsDistributed({
  activeAgents,
  daysBefore: 0,
  daysAfter: 0,
  minPerAgentPerDay: 30,
  maxPerAgentPerDay: 50,
  batchSize: 5000,        // big batches to amortize round-trip latency
  resumeFromDate: '2025-10-04',
  skipSearchIndex: true,  // defer indexing; resync separately later
  quiet: true,            // console.log in a hot loop is not free
});
```

`skipSearchIndex` defers the index write entirely; I run a resync script afterward to rebuild it in one pass, which is faster than interleaving the writes. `quiet` kills the per-record logging — sounds trivial, but `console.log` inside a loop that runs hundreds of thousands of times genuinely shows up in the wall-clock time over a slow link. And `agentsChunkSize` lets me process agents in slices per day instead of all at once, to keep CPU from spiking on the 2-core box this runs on. None of these change *what* gets seeded. They change how much it costs to get there, and that's the difference between a 30-second iteration and a coffee break.

## The bulk insert, and where it bit me

The base seeder doesn't use `repository.save()` for the volume work. Saving entities one transaction at a time over a high-latency connection is death. Instead `bulkInsert` builds one giant multi-row `INSERT` from the entity metadata:

```ts
const valuesSql = normalizedRecords
  .map((rec) => `(${dbColumns.map((col) => serialize(col, rec[col])).join(', ')})`)
  .join(', ');

const sql = `INSERT INTO ${tableName} (${dbColumns.join(', ')}) VALUES ${valuesSql}`;
await queryRunner.query(sql);
```

Each batch is one round trip. Over RDS, that's the entire ballgame — going from per-row inserts to 5000-row batches took a development seed from "I'll come back later" to a couple of minutes.

But hand-rolling the SQL means hand-rolling the serialization, and that's where I lost an afternoon. `serialize()` has to special-case everything MySQL is picky about: `Date` becomes `'YYYY-MM-DD HH:mm:ss'` (slice the ISO string at 19, swap the `T` for a space), booleans become `1`/`0`, arrays become comma-joined strings for `simple-array` columns, objects get `JSON.stringify`, and every string gets its single quotes doubled to escape them. Miss any one and the whole batch rolls back inside its transaction with an error that points at character 40,000-something of a query you can't read. The one that got me: a `Date` passed through `JSON.stringify` instead of the date branch produces `"2025-10-04T..."` with quotes and a `T`, and MySQL rejects it as an invalid datetime. The fix was just ordering the type checks correctly — `instanceof Date` before the generic `typeof === 'object'` — but finding it meant logging the generated SQL and eyeballing it.

If I did this again I'd reach for a driver-level batch insert with real parameter binding before writing my own serializer. The raw-SQL path is fast, but I rebuilt a worse version of something the MySQL driver already does correctly, and I paid for it in escaping bugs. The speed win was real; the serializer was a tax I didn't need to pay.

## What I'd keep and what I'd change

The provider sales seeder weights its output the way the business actually skews — Xfinity 20, AT&T 18, down to Vivint at 0.3 — and pulls real field templates from a `sales-data-sample.json` so each provider's quirky required columns and package IDs come out valid. That part earned its keep. A naive seeder would put equal sales across 25 providers and the "top providers" chart would be a lie. The weighting is what made the chart trustworthy, and trustworthy was the entire point of the exercise.

What I'd change: the modes and toggles accreted. Half of `master-seeder.ts` is commented-out steps — tasks, chats, events, notifications — because for the analytics work I only needed call logs and sales, and I kept disabling things rather than parameterizing them. It works, but a stranger reading it can't tell what's load-bearing and what's a fossil. The honest version would have a flag per entity instead of a graveyard of `/* ... */`.

Here's where this bites you if you skip it: you ship a dashboard that's correct and fast on your laptop, a customer with eight months of history opens it, and the query that never touched an index over 40 rows now scans a few hundred thousand and times out. You don't find that in code review. You find it when the data has weight. Seed data that looks like production isn't a chore you do before the real testing — for anything analytical, it *is* the test.
