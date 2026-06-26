---
title: "Schema governance: name your constraints or pay later"
description: "Why every FK and index on a large schema deserves an explicit, conventional name."
date: "2025-12-17"
updated: "2025-12-17"
kind: "deepdive"
category: "Databases"
tags: ["migrations", "governance", "typeorm"]
month: "2025-12"
repo: "backend"
author: "Sachal Chandio"
---

"Schema governance" sounds like a slide deck. In practice it's one boring rule: nothing in the database is allowed to have a name a human can't read. No foreign key called `FK_72cc8762ab7d48ea492eee02703`, no index called `IDX_2adc36cea150666e6aeadf71a9`. Both of those are real, both are in the Telelinkz database right now, and I put them there by doing nothing — which is the entire point. The default is a hash, and the default is what you ship when you don't decide.

I want to make the case for the rule as a *category* of decision, not the FK case or the index case in isolation. The interesting thing isn't that explicit names are nicer. It's that the cost of skipping them is deferred, invisible, and lands on whoever is reading a migration diff or a `SHOW CREATE TABLE` at the worst possible moment — usually not the person who skipped it. That asymmetry is the whole reason "we'll name them later" loses every time.

## The number that flips the math

Telelinkz has somewhere around sixty entities. Sales tables for every provider — `xfinity_sale`, `atnt_sale`, `spectrum_sale`, two dozen more — plus the HR, inventory, chat, QA, and analytics modules layered on top. Most entities carry two or three constraints: a foreign key or two, a couple of indexes, sometimes a unique. Call it a hundred and fifty named objects in the schema.

At ten entities, auto-generated hash names are genuinely fine. You can hold the whole schema in your head. When `migration:generate` spits out a `DROP FOREIGN KEY \`FK_98536f...\``, you know which one it means because there are only three foreign keys and you wrote them last week.

The thing nobody tells you is that the failure isn't linear. It's not that a hundred and fifty hashes are fifteen times more annoying than ten. It's that past some threshold — for me it was around the point where I stopped being able to recognize tables by their constraint hashes — the migration diff stops being something you *read* and becomes something you *scroll*. And a migration diff you scroll instead of read is a safety mechanism you've quietly turned off.

That's the real claim. We don't run `synchronize` anywhere near production. Every schema change is a generated migration that a person reviews before it touches the live RDS. The review is the only thing standing between a careless entity edit and a destructive `ALTER` on a shared database. It works exactly as well as the diff is legible, and not one bit better.

## What an unreadable diff actually looks like

Here's a slice of a generated migration from before the convention, the inventory system going in:

```sql
ALTER TABLE `inventory_unit` ADD CONSTRAINT `FK_72cc8762ab7d48ea492eee02703`
  FOREIGN KEY (`inventoryId`) REFERENCES `inventory`(`id`)
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE `inventory` ADD CONSTRAINT `FK_4156c96b439e425420e79a78edb`
  FOREIGN KEY (`categoryId`) REFERENCES `inventory_categories`(`id`)
  ON DELETE RESTRICT ON UPDATE NO ACTION;
```

Two foreign keys, two hashes. To know what either one *is*, you read the rest of the line. The name carries zero information, so it's pure visual noise sitting at the front of every constraint statement. Now picture forty of these in one migration, half of them `DROP` paired with an `ADD` of a *different* hash for what is semantically the same relationship, and you'll understand why eyes glaze. The `AddIndexesToSales` migration was the worst of it — a hundred-plus `CREATE INDEX` lines like:

```sql
CREATE INDEX `IDX_2adc36cea150666e6aeadf71a9` ON `xfinity_sale` (`cx_firstName`);
CREATE INDEX `IDX_526670b2ca65ec17e3deac8a74` ON `xfinity_sale` (`phoneNumber`);
```

Twenty-six providers, four columns each, every name a hash. Reviewing that file, you are not reading constraint names. You're pattern-matching table-and-column pairs and praying nothing slipped a `DROP TABLE` in among them. That migration's `down()` actually *did* hide something — a couple of unrelated `ALTER TABLE notifications DROP COLUMN` statements buried near the bottom, the kind of thing you'd want a reviewer to catch and would absolutely miss in a wall of hashes.

## The conventions, stated once

I won't re-derive each one — I've written separately about why foreign keys get `FK_<table>_<column>` and why indexes get `IDX_<entity>_<fields>`. The governance point is that they're the *same decision* applied three ways, and stating them as a set is what makes them mechanical:

- `FK_<table>_<column>` — `FK_inventory_unit_inventoryId`, `FK_time_off_request_employeeId`
- `IDX_<entity>_<fields>` — `IDX_time_off_request_employeeId_status`, columns in index order
- `UQ_<entity>_<fields>` — `UQ_broadcast_channel_member_channelId_userId`

The test for a good convention is whether two engineers, handed the same columns, independently produce the same name. No judgment calls, no "well, it depends." Name by the local column for FKs because columns are already unique within a table. Encode index column order because order *is* the index. That's it.

The newer parts of the schema were born with these names. Here's the time-off request entity, which I wrote after the convention was in place:

```ts
@Entity('time_off_request')
@Index('IDX_time_off_request_employeeId_status', ['employeeId', 'status'])
@Index('IDX_time_off_request_employeeId_dates', ['employeeId', 'startDate', 'endDate'])
@Index('IDX_time_off_request_status_createdAt', ['status', 'createdAt'])
export class TimeOffRequest extends BaseEntity {
  @Column({ length: 36 })
  @Index('IDX_time_off_request_employeeId')
  employeeId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'employeeId',
    foreignKeyConstraintName: 'FK_time_off_request_employeeId',
  })
  employee?: User;
  // ...managerId, processedById, coveringEmployeeId — all four FKs to `user`, all named
}
```

Four foreign keys on this one entity, all pointing at `user`. Name them by target table and you get `FK_time_off_request_user` four times — MySQL rejects that, constraint names are unique per schema. Name them by column and `FK_time_off_request_employeeId`, `FK_time_off_request_managerId`, `FK_time_off_request_processedById`, `FK_time_off_request_coveringEmployeeId` can never collide. The convention isn't just readable; it's the version that's structurally impossible to get wrong.

Drop `migration:generate` on that entity and the output reads like a sentence instead of a hash dump. That's the payoff at write time — and it cost nothing, because I typed the name once instead of letting TypeORM compute one.

## Where the advice is wrong

I'm suspicious of any rule sold as universal, so here's where I don't follow my own.

**Don't retrofit the legacy hashes.** The two migrations I quoted above — the inventory FKs, the sales indexes — still have their hash names in production, and I left them there on purpose. MySQL has no cheap in-place rename for a foreign key; you drop and re-add, which on a large table takes a metadata lock you do not want during business hours for a purely cosmetic win. A constraint named `FK_72cc8762...` is ugly but *correct*. Rewriting history to "fix" it would create drift between the migration log and the deployed schema, which is a worse problem than an ugly name. The rule is forward-only: new constraints get names, old ones get left alone, and you live with a schema that has two styles for a while. That mixed state is mildly embarrassing in `SHOW CREATE TABLE` and I've made my peace with it.

**Don't rename an already-explicit name just to match casing.** There are a couple of older indexes named `idx_comment_sale` — lowercase, off-pattern, written before the convention. They're explicit. They already tell you what they cover. Renaming them buys a migration for zero observability gain. The goal was self-documenting names, not satisfying a linter, and that distinction is the difference between governance and bureaucracy.

**At ten entities, don't bother.** If your whole schema fits on one screen and you can name every foreign key from memory, the convention is overhead with no payoff yet. The discipline earns its keep at scale and only at scale. I'd still *start* with it on a greenfield project, because typing the name up front is free and retrofitting later isn't — but I wouldn't lecture a five-table side project about it.

**The name is redundant, and that's fine.** `FK_inventory_unit_inventoryId` sits on a column called `inventoryId` and repeats it. Yes. The constraint name shows up in places the column name isn't — error strings, `information_schema.TABLE_CONSTRAINTS`, a deadlock trace at 2am. In all of those the self-describing name carries its own context, and I'll take redundancy a human can read over compression a human can't, every time.

## The discipline is the cheap part

The upfront cost is one string per constraint at the moment you write the entity. That's the whole investment. You're already typing the `@JoinColumn`, already typing the `@Index` — adding `foreignKeyConstraintName: 'FK_...'` or a name argument is seconds, and you do it once.

What I haven't fully solved is enforcement. Right now a bare `@JoinColumn` with no `foreignKeyConstraintName` is a comment I leave in code review, and that holds for a team this size because the reviewer has been burned. The honest next step is a CI lint — a rule that walks the entity metadata and fails the build on any unnamed constraint. I keep almost building it and then not, because manual review has caught every case so far. The day it doesn't is the day I'll wish I'd written the lint, and that's a fair description of every governance task that slips: the cost of skipping it is real, deferred, and lands on the version of you that's already having a bad day.

Here's the rule of thumb I'd actually hand someone. Name a constraint when you create it, never plan to name it later — "later" is a migration, a lock, and a drift risk, where "now" is a string. Retrofit forward-only and refuse to touch the deployed past. And measure the convention by one question: can the on-call engineer read this name off an error message and know what broke, without opening a file? If yes, the governance is doing its job. If it's a hash, you've already lost the two minutes you'll spend grepping for it while production waits.
