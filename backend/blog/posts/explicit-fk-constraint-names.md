---
title: "Why I gave every foreign key an explicit name"
description: "Auto-generated FK names like FK_a1b2 make migrations unreadable and fragile. A naming convention that pays for itself."
date: "2025-12-08"
updated: "2025-12-08"
kind: "deepdive"
category: "Databases"
tags: ["typeorm", "mysql", "migrations", "schema-governance"]
month: "2025-12"
repo: "backend"
author: "Sachal Chandio"
---

Here's a line from one of our older migrations:

```sql
ALTER TABLE `audit_form` ADD CONSTRAINT `FK_01f5c7423eb9c4ffbc3b56f0ff0`
  FOREIGN KEY (`saleId`) REFERENCES `xfinity_sale`(`id`)
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

Read `FK_01f5c7423eb9c4ffbc3b56f0ff0` out loud. You can't. You can't tell from it which table it's on, which column it constrains, or what it points at. You have to read the rest of the statement to recover all three, every single time. Now multiply that by a schema with around 60 entities, most of them carrying two or three of these, and picture yourself scanning a generated migration at 11pm trying to decide whether it's safe to run.

That hash is how TypeORM names foreign keys when you don't name them yourself. It's a hash of the table name, column names, and referenced columns. It's stable, it's unique, and it's completely useless to a human.

## Where it actually hurt

Two places, and neither was the place I expected.

The first was `migration:generate` diffs. We don't use `synchronize` anywhere near production — every schema change goes through a generated migration that a person reads before it runs. That review is the whole safety mechanism, and it only works if the diff is legible. When half the lines in a migration are `DROP FOREIGN KEY \`FK_98536f17ed2ac673beb23330513\`` followed by an `ADD CONSTRAINT` with a *different* hash, your eyes glaze. You stop reading constraint lines as content and start treating them as noise to scroll past. That is exactly the moment a real change sneaks through.

It got worse because the hashes weren't even stable across environments the way I assumed. Rename a column, change a referenced type, reorder something TypeORM considers part of the key, and the hash recomputes. So a generated migration would drop `FK_01f5c7...` and add `FK_a3e9b1...` for what was, semantically, the same relationship. The diff said "I replaced a foreign key." What actually happened was nothing — same table, same column, same target. Pure churn, dressed up as a change.

The second place was on-call. Production throws a constraint error and MySQL tells you the constraint name:

```
ER_NO_REFERENCED_ROW_2: Cannot add or update a child row:
a foreign key constraint fails (`telelinkz`.`atnt_sale`,
CONSTRAINT `FK_98536f17ed2ac673beb23330513`
FOREIGN KEY (`agentId`) REFERENCES `user` (`id`))
```

That's the good case — MySQL was kind enough to print the column and the referenced table. Plenty of errors, deadlock traces, and `information_schema` rows just give you the name. And when the name is a hash, the name tells you nothing. You go from "I know exactly what's wrong" to "let me go grep the codebase for this hash to find out which relationship MySQL is even talking about." At 2am that detour is the difference between a two-minute fix and a twenty-minute one.

## The rule I settled on

Every foreign key gets an explicit name, and the name follows one shape:

```
FK_<table>_<column>
```

Table name as it exists in MySQL, then the local FK column. `FK_inventory_unit_inventoryId`. `FK_atnt_sale_agentId`. `FK_audit_form_saleId`. No hash, no ambiguity. The name *is* the documentation — you can read the constraint off the error message and know precisely what it constrains and where to look, without opening a single file.

In TypeORM you set it on the `@JoinColumn`:

```ts
@ManyToOne(() => Inventory, (inventory) => inventory.units, { nullable: false })
@JoinColumn({
  name: 'inventoryId',
  foreignKeyConstraintName: 'FK_inventory_unit_inventoryId',
})
inventory: Inventory;

@Column({ length: 36, nullable: false })
inventoryId: string;
```

That `foreignKeyConstraintName` option is the whole trick. It's been on `@JoinColumn` for a while and almost nobody uses it, because the default works and the default is invisible until it isn't. Here's the same relationship before, when I was letting TypeORM pick:

```ts
// before
@ManyToOne(() => Inventory, (inventory) => inventory.units, { nullable: false })
@JoinColumn({ name: 'inventoryId' })
inventory: Inventory;
// produced: ALTER TABLE `inventory_unit`
//   ADD CONSTRAINT `FK_<some-hash>` FOREIGN KEY (`inventoryId`) ...
```

And after, the generated migration reads like a sentence:

```sql
ALTER TABLE `inventory_unit` ADD CONSTRAINT `FK_inventory_unit_inventoryId`
  FOREIGN KEY (`inventoryId`) REFERENCES `inventory`(`id`)
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

You don't have to decode anything. `inventory_unit` has a foreign key on `inventoryId`. Done.

## Things I considered and didn't do

I thought about `fk_inventory_unit_inventory` — naming it after the *target table* instead of the local column. It reads a little more naturally in English ("this unit points at an inventory"). I dropped it because it collides the moment you have two FKs to the same table. `inventory_unit` already has `agentId` and could easily gain a second user reference like `assignedById`; both point at `user`. Name by target and you get `FK_inventory_unit_user` twice, which MySQL rejects outright because constraint names are unique per schema. Name by column and `FK_inventory_unit_agentId` versus `FK_inventory_unit_assignedById` can never clash, because column names are already unique within a table. The column is the thing that's guaranteed distinct, so the column is what goes in the name.

I also thought about a global prefix — `fk` lowercase, to sort apart from indexes — and about cramming the referenced table in too, like `FK_inventory_unit_inventoryId_inventory`. Both lost to "shortest name that's unambiguous." The referenced table is one join away in any tool you'd be using; you don't need it baked into a 60-character identifier you'll be reading on a phone during an incident. MySQL caps identifiers at 64 characters anyway, and a couple of our longer table-plus-column combos were already brushing against that ceiling. Adding the target table would have pushed some over.

The honest tradeoff: the name is now redundant with the column it sits next to. `FK_inventory_unit_inventoryId` on a column called `inventoryId` repeats itself. I decided redundancy that a human can read beats compression a human can't. The constraint name shows up in contexts where the column name isn't right there — error strings, `SHOW CREATE TABLE` output way down the page, `information_schema.TABLE_CONSTRAINTS`. In all of those, the self-describing name carries its own context.

## Rolling it out without rewriting history

I wasn't about to hand-edit dozens of old migrations — the past is the past, and those hashes are what's actually deployed on the live database. Touching historical migrations to "fix" names would just create drift between the migration history and reality, which is its own special hell.

So the rule applied forward only. New entities and any FK I touched for another reason got the explicit name. When I added the agent relationship to `inventory_unit`, the migration came out clean from the start:

```sql
ALTER TABLE `inventory_unit` ADD CONSTRAINT `FK_inventory_unit_agentId`
  FOREIGN KEY (`agentId`) REFERENCES `user`(`id`)
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

For the legacy hash-named constraints, I left them. A constraint named `FK_98536f17ed2ac673beb23330513` is ugly but correct, and a one-line rename in MySQL doesn't exist — you drop and re-add, which on a big table takes a metadata lock you don't want during business hours for a purely cosmetic win. The ones that already had explicit names from a recent rework, like the entire dynamic-sale form system, were the proof it was worth it: every FK in `provider_form_field`, `provider_form_version`, and friends reads cleanly because they were born with names.

```ts
@ManyToOne(() => ProviderFormVersion, (version) => version.fields, {
  onDelete: 'CASCADE',
})
@JoinColumn({
  name: 'formVersionId',
  foreignKeyConstraintName: 'FK_provider_form_field_formVersionId',
})
formVersion: ProviderFormVersion;
```

To keep new code honest I lean on review more than tooling — a `@JoinColumn` without `foreignKeyConstraintName` is a comment in the PR. You could enforce it with a custom ESLint rule that flags a bare `@JoinColumn`, and I've been tempted, but for a team this size a known convention plus a reviewer who's been burned is enough.

## When this bites you, and when it doesn't

The payoff isn't visible on a good day. On a good day no foreign key fails and no migration touches a constraint, and the explicit names just sit there being slightly verbose. The whole value is loaded into the bad day — the incident where MySQL hands you a constraint name and you need to know what it means *now*, or the migration review where a real `ALTER` is hiding among the churn and you need the constraint lines to be readable enough that you'd notice.

If I were starting the schema today I'd put `foreignKeyConstraintName` on the very first `@JoinColumn` and never think about it again. Retrofitting is the annoying part — you can do it forward-only like I did and accept a schema with two naming styles for a while, or you can take the locks and unify everything in one maintenance window. I took the slow path. The mixed state is mildly embarrassing in `SHOW CREATE TABLE`, but every name I can read is one I added on purpose, and not one of them is a hash I have to go look up while something is on fire.
