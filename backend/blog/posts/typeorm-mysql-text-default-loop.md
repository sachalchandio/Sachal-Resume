---
title: "The migration that regenerated itself: TypeORM, MySQL, and TEXT defaults"
description: "simple-array columns with default '' made TypeORM emit the same ‘fix’ migration forever. The one-line cure."
date: "2025-12-10"
updated: "2025-12-10"
kind: "deepdive"
category: "Databases"
tags: ["typeorm", "mysql", "migrations"]
month: "2025-12"
repo: "backend"
author: "Sachal Chandio"
---

I generated a migration, looked at it, and threw it away. Then I generated it again the next day for a completely unrelated change and there it was again — the same block of SQL, trying to "fix" three columns I had never touched. I deleted it again. By the third time I started to suspect the problem was me.

The command was the usual:

```bash
npm run typeorm -- migration:generate src/migrations/AddCampaignNotes -d src/data-source.ts
```

I expected one `ALTER TABLE` for the new column I'd just added to the entity. Instead I got that, plus this riding along uninvited:

```ts
export class AddCampaignNotes1733... implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // the column I actually wanted
    await queryRunner.query(
      `ALTER TABLE \`campaign\` ADD \`notes\` text NULL`,
    );

    // ...and these three, which I did not ask for
    await queryRunner.query(
      `ALTER TABLE \`lead\` CHANGE \`tags\` \`tags\` text NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`sale\` CHANGE \`extraNumbers\` \`extraNumbers\` text NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`agent\` CHANGE \`skills\` \`skills\` text NOT NULL`,
    );
  }
  // ...
}
```

`CHANGE \`tags\` \`tags\``. Same name, same type, "changing" it to what it already was. TypeORM had decided these columns were out of sync with the entities, generated SQL to reconcile them, and — here's the part that took me a while to accept — running that SQL did not make the difference go away. Generate again, and the same three lines came back. A migration that regenerated itself.

## The wrong guess: a stale worktree

My first theory was environment drift. I do a lot of work in git worktrees, and I'd been bitten before by generating a migration against a worktree whose schema had fallen behind the real database. The CLI path is fiddly across worktrees, the `.env` doesn't always come along, and it's easy to end up diffing the entity against a database that's a few migrations stale. When that happens TypeORM "discovers" a pile of changes that are really just the gap between your local DB and `main`.

So I did the disciplined thing. Pulled `main`, made sure my data source pointed at the actual shared database (our `.env` targets a live RDS instance, not localhost), ran every pending migration so the schema was genuinely current, and confirmed `migration:show` listed nothing outstanding. Clean. Then I generated again.

The three columns came back.

That killed the drift theory, and honestly it was the more comforting theory, because drift you can fix by tidying your environment. This was something structural. The database was up to date, the entities were up to date, and TypeORM still believed they disagreed. When a diff tool insists two identical things are different, the disagreement is about something you can't see in the values — it's about metadata.

## Looking at what's actually on disk

The three columns had one thing in common, and I'd walked past it a dozen times. They were all `simple-array`:

```ts
@Column('simple-array', { default: '' })
tags: string[];
```

`simple-array` is TypeORM's little convenience type. You hand it `string[]`, it stores a comma-joined string in a single column, and on the way out it splits on commas back into an array. There's no array type in MySQL, so under the hood the column is plain `TEXT`. The `default: ''` was there so a brand-new row with no tags would come back as `[]` instead of choking on `null`. Reasonable. I'd copied that pattern across all three entities without thinking twice.

So I went to look at what MySQL actually stored for the column definition:

```sql
SHOW COLUMNS FROM `lead` LIKE 'tags';
```

```
Field | Type | Null | Key | Default | Extra
tags  | text | NO   |     | NULL    |
```

`Default: NULL`. Not empty string. I had declared `default: ''` in the entity, the migration that created the column emitted `DEFAULT ''`, and MySQL had quietly stored the default as `NULL` anyway. There was the mismatch, sitting in plain text. The entity metadata said the default should be `''`; the live column reported its default as nothing. Every time TypeORM compared the two it saw a difference and dutifully wrote a `CHANGE` to set it right — and every time, MySQL ignored the `DEFAULT` clause again, so the difference survived.

## Why MySQL does this

This isn't TypeORM being dumb. It's an old, specific MySQL rule: `BLOB`, `TEXT`, `GEOMETRY`, and `JSON` columns cannot have a literal `DEFAULT` value. Historically MySQL would silently drop the default clause on those types rather than error. On a stricter server you'll actually get:

```
ERROR 1101 (42000): BLOB, TEXT, GEOMETRY or JSON column 'tags'
can't have a default value
```

Either way the outcome is the same: the `DEFAULT ''` you asked for never lands. The column's real default stays `NULL`. (Newer MySQL lets you set a default on `TEXT` only with an expression in parentheses, e.g. `DEFAULT ('')`, which is a different thing and not what `simple-array` emits.)

So `simple-array` plus `default: ''` is a small trap. `simple-array` forces the storage type to `TEXT`. `TEXT` refuses a literal default. The entity insists there is one. TypeORM compares declared-vs-actual every single generate and can never close the gap, because the gap isn't in your control — it's a property of the column type. The migration it produces is genuinely correct SQL that genuinely does nothing, forever.

## The fix is to stop asking

The cure is one line. Drop the `default` from the column and handle the empty case in the entity instead:

```ts
// before — the source of the loop
@Column('simple-array', { default: '' })
tags: string[];

// after
@Column('simple-array')
tags: string[] = [];
```

Now the entity metadata agrees with what MySQL was always going to store: no column default. The property initializer `= []` gives you the empty array on a fresh in-memory instance, which is what the `default: ''` was really trying to buy you anyway — and it does it in TypeScript, where it actually works, instead of in DDL, where it doesn't. If you need new rows to be non-null at the database level, make the column `NOT NULL` and let the initializer guarantee you always insert a value (an empty `simple-array` writes as an empty string, not null).

I changed all three entities, then generated one more time:

```bash
npm run typeorm -- migration:generate src/migrations/DropTextSimpleArrayDefaults -d src/data-source.ts
```

```
No changes in database schema were found - cannot generate a migration.
```

That last line was the whole reward. The three phantom columns were gone. The next real migration I generated contained only the column I'd actually changed, and nothing rode along with it.

One caveat worth saying out loud, because it tripped me for a minute: removing `default: ''` from the entity does **not** by itself produce a schema change, since MySQL never stored that default in the first place. So you won't even get a clean "remove the default" migration out of it — there's nothing on the database side to remove. The fix is purely in the entity metadata, which is exactly why the loop stops. You're not changing the database; you're correcting the model's belief about the database so the two finally match.

## When this bites you

Any time the declared schema can't be physically represented, your migration tool will try to converge and fail, quietly, on every run. `simple-array` over `TEXT` with a literal default is the cleanest example I've hit, but the shape is general. Watch for it whenever a column's storage type has rules your ORM's column options don't know about:

- A literal `DEFAULT` on any `TEXT`, `BLOB`, `JSON`, or `GEOMETRY` column. MySQL drops it; your ORM keeps insisting on it.
- A `varchar` length or charset/collation in the entity that doesn't match the table's actual collation — same endless `CHANGE` for a column that looks identical.
- `simple-json` columns, which are also `TEXT` under the hood and carry the same default restriction.

The tell is always the same: `migration:generate` keeps emitting a "fix" for columns you never touched, and applying the fix doesn't stop it from coming back. When that happens, don't keep deleting the migration and don't go hunting for environment drift first. Go look at the column with `SHOW COLUMNS` and compare the *real* default and type against what the entity declares. The diff your ORM can see is between the metadata and the live column — so the answer is always sitting in `information_schema`, not in your TypeScript.

The lesson I took from it: an ORM's schema diff is only as honest as the database's willingness to store what you declared. When you write a default the engine can't keep, you don't get an error — you get a migration that runs forever and accomplishes nothing. Cheaper to know the engine's rules than to out-stubborn it.
