---
title: "Naming every index: schema observability at scale"
description: "IDX_/UQ_ conventions across every entity so an index name tells you what it covers without opening the code."
date: "2025-12-09"
updated: "2025-12-09"
kind: "deepdive"
category: "Databases"
tags: ["typeorm", "mysql", "indexes", "governance"]
month: "2025-12"
repo: "backend"
author: "Sachal Chandio"
---

A slow query came in on the sale-stage analytics table. I pulled the plan, saw the optimizer had picked a key called `IDX_8a3f1c...` — TypeORM's auto-generated hash name — and I had no idea which columns it covered. So I opened MySQL, ran `SHOW INDEX FROM sale_stage`, and got a wall of those hashes. Every one a riddle. To find out what `IDX_8a3f1c` actually indexed I had to cross-reference the `Column_name` rows by hand, then go back into the entity file to confirm the order matched what I thought I'd written.

That round trip — plan to MySQL to source and back — is the whole problem. An index name should answer "what does this cover" on its own. The auto-generated ones answer nothing.

## How TypeORM names things when you don't

If you write `@Index(['agentId', 'shiftDate'])` and leave the name blank, TypeORM hands you a deterministic name built from a hash of the table and columns. Something like `IDX_a1b2c3d4e5f6...`. It's stable, it's unique, and it's completely opaque to a human reading a query plan at 11pm. MySQL's `EXPLAIN` shows you `key: IDX_a1b2c3d4` and `key_len: 8`, and unless you've memorized the hash you're now context-switching to figure out whether the planner picked the index you wanted.

The same goes for unique constraints. A `@Unique(['channelId', 'userId'])` becomes some `UQ_<hash>`, and when an insert blows up with `ER_DUP_ENTRY: Duplicate entry '12-45' for key 'UQ_8f2a...'`, the error tells the user nothing and tells me nothing. I have to go look up which constraint `UQ_8f2a` is before I can even decide whether the duplicate is a bug or expected.

Across the Telelinkz backend this had accreted into roughly a hundred indexes spread over the sales, QA, chat, broadcast, HR, and analytics modules. Some had explicit names because whoever wrote them cared that day. Most didn't. The naming was a coin flip per decorator.

## Constraints I was working under

This is a live CRM with a shared AWS RDS instance behind it. I had a few hard rules going in.

I was not going to drop and recreate indexes on a production table just to rename them — on the bigger tables that's minutes of lock-adjacent pain and a window where a query could fall back to a full scan. Renaming an index in MySQL is itself not free historically; older versions did a copy. So whatever I did had to be reviewable and had to go through a generated migration, not a hand-written one. I don't hand-write migrations — I let `typeorm migration:generate` diff the entities against the schema and produce the SQL, then I read it before it runs.

And I wanted the convention to be mechanical. If two engineers can't independently arrive at the same index name for the same columns, the convention has failed. No judgment calls.

## The convention

I settled on `IDX_<entity>_<fields>` for plain indexes and `UQ_<entity>_<fields>` for unique ones. Entity is the logical table name, fields are the column names in index order, joined by underscores. Where the index exists for a specific purpose, I'd suffix it — `_analytics`, `_active`, whatever the query it serves is called.

That last part matters more than it looks. Order is part of the name because order is part of the index. A composite on `(saleType, createdAt, stage)` is a different beast from `(createdAt, saleType, stage)` — the first serves "filter by sale type, then range-scan by date," the second doesn't. Encoding the order in the name means the name lies to you if you reorder the columns and forget to update it, which is exactly the kind of mistake I want to be loud.

Some of the real ones it produced:

```ts
// sale-stage.entity.ts
@Index('IDX_sale_stage_saleType_createdAt_stage_analytics', ['saleType', 'createdAt', 'stage'])
@Index('IDX_sale_stage_createdAt_analytics', ['createdAt'])
@Index('IDX_sale_stage_saleType_stage_updatedAt', ['saleType', 'stage', 'updatedAt'])

// qa-form-template.entity.ts
@Index('UQ_qa_form_template_slug_version', ['slug', 'version'], { unique: true })

// broadcast-channel-member.entity.ts
@Index('UQ_broadcast_channel_member_channelId_userId', ['channelId', 'userId'], { unique: true })

// chat/message.entity.ts
@Index('IDX_message_chatId_createdAt', ['chatId', 'createdAt'])
```

Now when `EXPLAIN` says `key: IDX_sale_stage_saleType_createdAt_stage_analytics`, I'm done reading. I know the table, the columns, the order, and the reason it exists. No round trip.

## Before and after

The before was a mix of three things: bare `@Index()` with no args, `@Index(['col'])` with no name, and a scatter of inconsistent names like the lowercase `idx_comment_sale` someone wrote early on.

```ts
// before — three different styles in three entities
@Index()
@Column()
lastMessageAt: Date;

@Index(['agentId', 'shiftDate'])           // composite, no name
@Index(['agentId', 'clockInTime'])

@Index('idx_comment_sale', ['saleId', 'saleType'])   // named, but lowercase + ad hoc
```

The after is uniform. Even the single-column ones declared at the property get a name:

```ts
// after
@Index('IDX_chat_lastMessageAt')
@Column()
lastMessageAt: Date;

@Index('IDX_qa_agent_stats_agentId_bucket_periodStart', ['agentId', 'bucket', 'periodStart'])

@Index('idx_comment_sale', ['saleId', 'saleType'])   // left lowercase on purpose — see below
```

I deliberately left a couple of older lowercase names (`idx_comment_sale`, `idx_comment_parent`) alone because they were already explicit, already in production, and renaming them bought me a migration for zero observability gain — the name already told me what it covered. The goal was self-documenting names, not aesthetic uniformity. That's a distinction worth holding onto: I was buying readability, not satisfying a linter.

## Approaches I rejected

I considered just renaming the worst offenders — the composite indexes on hot tables — and leaving the single-column ones auto-named. Half-measure. The value of a convention is that `SHOW INDEX` is uniformly readable; if a third of the rows are still hashes you're still doing the round trip, just less often. Consistency is the feature.

I considered a runtime check — a startup assertion that walks the metadata and throws if any index lacks an explicit name. Tempting, and I may still add it as a CI lint. But a hard throw on boot is a bad failure mode for a production service: one un-named index someone adds in a hurry shouldn't take down the API. A lint that fails the build is the right place for that, not the runtime.

And I considered a naming scheme that encoded intent only — `IDX_sale_stage_analytics_main` — dropping the column list. Shorter, reads nicely. But it reintroduces the exact opacity I was fixing: the name no longer tells you the columns, so you're back to cross-referencing. Intent suffixes are a bonus on top of the columns, never a replacement.

## How I actually rolled it out

Renaming happened entity by entity in source, then I let the CLI do the schema diff:

```bash
npm run typeorm -- migration:generate src/migrations/NameAllIndexes -d src/data-source.ts
```

The generated migration is mostly pairs of `DROP INDEX` / `CREATE INDEX` per renamed index — MySQL has no in-place rename in the dialect TypeORM emits, so a rename is a drop-and-create. I read every line before running it. The thing I watched for: a generated `CREATE INDEX` that didn't have a matching `DROP` usually means I changed the column set, not just the name, and that's a different review. On the live RDS I ran it in a low-traffic window, and for the larger tables I checked that the drop-then-create gap wasn't long enough to matter — these tables aren't billions of rows, the indexes rebuild in seconds, but you check anyway.

One sharp edge worth flagging: TypeORM's migration diff is sensitive to a stale worktree. I once generated what looked like a huge "index drift" migration that turned out to be the entities diffing against an out-of-date local schema, not the real RDS state. Generate from up-to-date `main` against the actual target database, or the diff will invent work that isn't there.

## What it bought me

The payoff shows up in three places I touch constantly. Query plans read themselves now — `EXPLAIN` output names the covering index in plain English. Duplicate-key errors are legible: `ER_DUP_ENTRY ... for key 'UQ_salary_report_year_month_userId'` tells whoever's on call exactly which business rule got violated without anyone opening the source. And code review caught a real redundancy I'd have missed — once names were uniform, two indexes that were near-duplicates on the QA tables were obvious side by side in a diff, where before their hashes hid the overlap.

Here's when this bites you if you skip it. The cost of opaque index names is invisible right up until the moment you're debugging a slow query under pressure, and then it's a tax you pay on every single lookup at the worst possible time. Naming them is cheap insurance you buy once. The convention is mechanical enough that nobody has to think about it, and the migration to get there is a one-time, reviewable drop-and-create. The only real regret I have is not making it a CI lint the same day, so the next un-named index gets caught at the PR instead of in a query plan six months later.
