---
title: "Idempotent migrations: dropping an index that may or may not exist"
description: "Wrapping DROP/CREATE in try/catch so a migration survives being half-applied across environments."
date: "2026-01-11"
updated: "2026-01-11"
kind: "deepdive"
category: "DevOps"
tags: ["typeorm", "migrations", "mysql"]
month: "2026-01"
repo: "backend"
author: "Sachal Chandio"
---

The migration ran clean on my laptop. It blew up on staging with this:

```
QueryFailedError: Can't DROP 'IDX_designation_name'; check that column/key exists
```

Same migration. Same code. Different history. On my machine the index existed because an earlier branch had created it by hand months ago and I'd never wiped my dev DB. On staging it had never been created. So `DROP INDEX` found nothing to drop and MySQL refused. Welcome to the migration ran clean on my laptop hall of fame.

## What I was actually trying to do

`designations` is a small lookup table — job titles for sales agents, things like "Closer", "Fronter", "Team Lead". The bug I was fixing was that nothing stopped two designations with the same name inside the same company. We had a "Closer" and a "closer " (trailing space, different casing further up the stack) and the reporting joins double-counted. The fix is a composite unique key on `(companyId, name)`.

The catch: an old migration had at some point added a plain non-unique index `IDX_designation_name` on just `name`. In some environments. The exact lineage was lost to a few force-merges and one DB that got restored from a backup taken mid-refactor. So before I could add the new composite unique, I wanted to drop the stale single-column one to keep the table clean.

So the `up()` I wrote, the naive version, was just this:

```ts
export class AddDesignationCompanyNameUnique1736500000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `IDX_designation_name` ON `designations`',
    );
    await queryRunner.query(
      'ALTER TABLE `designations` ' +
        'ADD UNIQUE INDEX `UQ_designation_company_name` (`companyId`, `name`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `designations` DROP INDEX `UQ_designation_company_name`',
    );
  }
}
```

Clean on my machine. Fatal on staging, because the `DROP INDEX` is the first statement, and when it throws, the migration aborts before the `ADD UNIQUE` ever runs. TypeORM rolls the transaction back and marks the migration as not run. So you're stuck: it won't apply, and you can't move forward without intervention.

## The reflex I resisted first

My first instinct was the wrong one, and I'll own it. I went to the migration and just deleted the `DROP INDEX` line. "It doesn't exist on staging anyway, so don't drop it." That makes staging green and leaves my dev box with a dead non-unique index hanging around forever, plus any environment that *did* have the index never gets it cleaned up. You've made the symptom go away on the one box you tested and quietly forked the schema across environments. That's how you end up with three databases that disagree about what the table looks like, which is the exact thing migrations exist to prevent.

The other reflex — also wrong — is to hand-edit the migration to "match reality." I have a standing rule with myself: never hand-write or hand-trim a generated migration. Drift you patch by hand is drift you'll be debugging at 11pm six months later when `migration:generate` spits out a diff you can't explain. So I left the SQL alone and made the *execution* tolerant instead.

## Making `up()` idempotent

The shape of the fix is: try to drop the index; if it isn't there, that's fine, keep going. Same idea for the create — if the unique key already got added by a half-run, don't fail on the second pass.

```ts
public async up(queryRunner: QueryRunner): Promise<void> {
  // Drop the legacy single-column index if it's present.
  // Some environments never had it; that's not an error here.
  try {
    await queryRunner.query(
      'DROP INDEX `IDX_designation_name` ON `designations`',
    );
  } catch (err) {
    // 1091 = Can't DROP ...; check that column/key exists
    if ((err as { errno?: number }).errno !== 1091) throw err;
  }

  try {
    await queryRunner.query(
      'ALTER TABLE `designations` ' +
        'ADD UNIQUE INDEX `UQ_designation_company_name` (`companyId`, `name`)',
    );
  } catch (err) {
    // 1061 = Duplicate key name (the unique was already added)
    if ((err as { errno?: number }).errno !== 1061) throw err;
  }
}
```

The part that matters is the `errno` check. I am not swallowing every error — I'm swallowing exactly two: `1091` for "index isn't there to drop" and `1061` for "key name already exists." Anything else — a permissions error, a connection drop, a genuinely malformed statement — still throws and still aborts the migration the way it should. A bare `catch {}` here would be the real crime. That turns the migration into a coin flip: it always "succeeds" and you have no idea whether the schema is actually correct. The whole value of the try/catch is in how narrow it is.

If you want the cleaner version that doesn't lean on MySQL error numbers, you can ask the schema first. TypeORM gives you a query runner that knows how to introspect:

```ts
public async up(queryRunner: QueryRunner): Promise<void> {
  const table = await queryRunner.getTable('designations');

  const legacy = table?.indices.find((i) => i.name === 'IDX_designation_name');
  if (legacy) {
    await queryRunner.dropIndex('designations', legacy);
  }

  const hasUnique = table?.indices.some(
    (i) => i.name === 'UQ_designation_company_name',
  );
  if (!hasUnique) {
    await queryRunner.createIndex(
      'designations',
      new TableIndex({
        name: 'UQ_designation_company_name',
        columnNames: ['companyId', 'name'],
        isUnique: true,
      }),
    );
  }
}
```

I went with this introspection version in the end. It reads as intent — "if the legacy index exists, drop it" — instead of "run this and forgive a specific failure code." The try/catch version is the pragmatic one to reach for when the statement is raw SQL you can't easily express through the query-runner API (a `FULLTEXT` index, a funky collation, a generated column). When you can express it through `getTable`, do.

One sharp edge worth calling out: `getTable` reflects the table as it was at the start of the migration's transaction. If you drop and recreate indices within the same `up()` and then re-query, the in-memory `Table` object doesn't magically refresh — you have to call `getTable` again or track state yourself. I got bitten by checking `table.indices` after I'd already mutated it and wondering why the count was stale.

## The down() has the same disease

If `up()` can run against a table that may or may not have an index, `down()` can too. A rollback on an environment that never got the unique key added will fail on `DROP INDEX UQ_designation_company_name` for the same reason. So I made the reverse symmetric:

```ts
public async down(queryRunner: QueryRunner): Promise<void> {
  const table = await queryRunner.getTable('designations');
  const unique = table?.indices.find(
    (i) => i.name === 'UQ_designation_company_name',
  );
  if (unique) {
    await queryRunner.dropIndex('designations', unique);
  }
  // Deliberately do NOT recreate IDX_designation_name.
  // It was legacy cruft; resurrecting it on rollback just spreads it again.
}
```

Note what `down()` doesn't do: it doesn't put the old `IDX_designation_name` back. A strict reading of "down should exactly reverse up" says I should. But the legacy index was the thing I was trying to eradicate, and recreating it on every rollback would reintroduce the drift I was cleaning up. Rollbacks are a developer convenience here, not a guarantee I rebuild a worse past. I made a judgment call and left a comment so the next person knows it was a call, not an oversight.

## When this is pragmatic and when it's hiding a real problem

Here's the line I draw, because idempotent migrations are a tool that doubles as a smell.

It's pragmatic when the divergence is **historical and one-time**: an index that some environments created out-of-band years ago, a column an old branch added by hand, anything where the "should it exist" answer legitimately differs by environment for reasons you understand and can name. You make the migration tolerant *once*, the environments converge to the same shape on the other side, and from then on they're back in lockstep. The try/catch is a bridge across a gap that existed before the migration framework was the source of truth. After this migration runs everywhere, every database has `UQ_designation_company_name` and none has `IDX_designation_name`. Convergence is the test.

It's hiding a real problem when you find yourself reaching for try/catch **routinely** — when half your migrations defensively guard their own DROPs because you genuinely don't trust what state any given database is in. That's not idempotency, that's a schema that has gone feral, and the right fix is upstream: figure out *why* environments drift. Usually it's someone running raw SQL against staging, or a `synchronize: true` that should never have been on, or migrations getting run out of order across branches. If a fresh DB built purely from migration history doesn't match production, no amount of try/catch saves you — you're just papering over the fact that your migrations are no longer the source of truth. I keep a CI check that spins up an empty MySQL, runs every migration top to bottom, and diffs the result against a dumped schema. The day that diff is non-empty is the day to stop writing tolerant migrations and go find the leak.

## What I'd do differently

I'd have written the unique constraint correctly the first time and never let the plain `IDX_designation_name` exist — a lookup table's name column wanting uniqueness within a tenant is obvious in hindsight. The drift was self-inflicted by an earlier me who added a casual index "for the lookup query" and never thought about the constraint.

And I'd reach for the `getTable` introspection form before the error-number form by default. The try/catch on `errno` works, but it encodes MySQL-specific knowledge into the migration (1091, 1061 are MySQL's numbers; you'd be rewriting them if you ever moved engines) and it reads like you're forgiving a failure rather than expressing a condition. Save the raw-SQL-plus-catch for the genuinely awkward statements. For "does this index exist," ask the table — it already knows.

The lesson that stuck: a migration's job isn't to run; it's to converge. If running it twice, or running it against a database with a slightly different past, leaves you in the same correct end state, it's a good migration. If it only works against the exact history on your laptop, you don't have a migration — you have a snapshot of your luck.
