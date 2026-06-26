---
title: "Soft deletes: the tax nobody warns you about"
description: "deletedAt is one column and a hundred obligations. What it really costs and when to just hard-delete."
date: "2026-06-12"
updated: "2026-06-12"
kind: "deepdive"
category: "Databases"
tags: ["soft-delete", "databases", "design"]
month: "2026-06"
repo: "both"
author: "Sachal Chandio"
---

A soft delete is a loan with no posted interest rate. You add one nullable column, stop running `DELETE`, and the demo works. The bill arrives later, spread across every query, every unique index, and every join you write for the rest of the project's life. On Telelinkz I added `deletedAt` to exactly one table — `inventory_unit` — and it took me weeks to notice how much of the codebase had quietly signed up to remember that dead rows exist.

This is the part nobody puts in the design doc. So let me lay out the actual tax, with the actual code, and then the cases where I'd skip soft delete entirely and reach for a hard delete plus an audit row instead.

## The column that looked free

Here's the whole feature, as a migration:

```ts
public async up(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`ALTER TABLE \`inventory_unit\` ADD \`deletedAt\` timestamp NULL`);
}
```

One `ALTER TABLE`. No new tables, no triggers. And on the entity, one column:

```ts
@Column({ type: 'timestamp', nullable: true })
@Field(() => Date, { nullable: true, description: 'Soft delete timestamp - unit is deleted if set' })
deletedAt?: Date;
```

Worth noting what I did *not* do: I didn't use TypeORM's `@DeleteDateColumn`. Our `BaseEntity` only has `@CreateDateColumn` and `@UpdateDateColumn`. So none of the framework's soft-delete machinery — `softDelete()`, `softRemove()`, the automatic `deletedAt IS NULL` injected into every query — was wired up. I bolted `deletedAt` onto a single entity by hand.

That decision is the whole post. With `@DeleteDateColumn`, TypeORM remembers the dead rows for you on every `find`. Without it, *I* have to remember, by hand, at every single call site. I picked the manual route because I only wanted soft delete on one table and didn't want to opt every other entity into a behavior change. Reasonable. Also: I now owe a `deletedAt IS NULL` to every query that touches this table, forever, and the compiler will never once remind me.

## Tax #1: every read has to opt out of the dead

Count the call sites. In `inventory.service.ts`, the string `deletedAt: null` (or `unit.deletedAt IS NULL` in query-builder form) appears in roughly thirty places. Single-unit lookups:

```ts
const unit = await unitRepo.findOne({ where: { id: params.unitId, deletedAt: null } });
```

Stat counts:

```ts
const totalUnits = await this.inventoryUnitRepository.count({ where: { deletedAt: null } });
const availableUnits = await this.inventoryUnitRepository.count({
  where: { status: UnitStatus.AVAILABLE, deletedAt: null },
});
```

The big paginated list query:

```ts
qb.leftJoinAndSelect('unit.inventory', 'inventory')
  .innerJoinAndSelect('inventory.category', 'category')
  .where('(unit.status = :assignedStatus OR unit.isAssigned = :isAssigned)')
  .andWhere('unit.deletedAt IS NULL');
```

Every one of these is a place I had to *remember*. The failure mode isn't an exception — it's worse. Forget the clause and the query still runs, still returns rows, and quietly includes things a user deleted last month. Your dashboard count is off by three and nobody can explain why. There's no red squiggle for "you forgot the dead rows." The forgetting is invisible until a number in production is wrong and someone screenshots it in Slack.

This is the real reason `@DeleteDateColumn` exists, and the real reason I'd think twice before going manual again. The framework's job is to make the safe path the default. The moment I hand-rolled the column, I made the *un*safe path the default — every new query starts out wrong and I have to add the safety back.

## Tax #2: unique constraints don't care that a row is "deleted"

This one cost me an afternoon and a confused user. `serialNumber` on `inventory_unit` is a unique column:

```ts
@Column({ length: 100, unique: true, nullable: true })
serialNumber: string | null;
```

A soft-deleted row is, from MySQL's point of view, a perfectly normal present row. It still occupies its slot in the unique index. So when a real device gets retired (soft delete) and a replacement comes in with the *same* manufacturer serial — which happens with refurbs and RMA swaps — assigning that serial blows up. The database is correctly enforcing uniqueness across a row the user believes is gone.

My pre-check made it more confusing, not less. Here's `assignSerialNumber`:

```ts
const unit = await unitRepo.findOne({ where: { id: params.unitId, deletedAt: null } });
// ...
const clash = await unitRepo.findOne({ where: { serialNumber: serial } });
if (clash && clash.id !== unit.id) {
  throw new BadRequestException(
    `Serial number "${serial}" is already in use by another unit.`,
  );
}
```

Look at the asymmetry. The unit I'm editing is fetched `deletedAt: null` — live rows only. But the clash lookup has *no* `deletedAt` filter, so it happily matches a soft-deleted unit. The user sees "Serial number 'MB123456001' is already in use by another unit" and goes looking for that unit in the list. It isn't there. It's deleted. They cannot find the thing the error is pointing at, because the UI hides exactly the row the constraint is tripping on.

There's no clean fix that's also free, and that's the point. Your options:

- Scope the clash check (and the index) to live rows — a partial unique index. MySQL doesn't have those; Postgres does (`WHERE deletedAt IS NULL`). On MySQL you fake it with a generated column or by nulling the serial on delete, which means you've now mutated data on the way out, which defeats half the reason you soft-deleted.
- Drop uniqueness and dedupe in application code. Now uniqueness is a suggestion, not a guarantee, and every reader inherits the dedupe.
- Hard-delete instead and let the index stay honest.

I left it as-is and made the error message tell the truth: if the clash is a deleted unit, say so and offer to restore it. But the lesson stuck. **A unique constraint plus a soft delete is a contradiction you have to actively resolve.** The column says "this value can exist at most once"; the soft delete says "but also keep the old one." Those can't both be true unless someone writes the code that makes them.

## Tax #3: derived counts drift, and now you have two ways to delete

`inventory.stock` is a denormalized count of live units under an item. So delete has to decrement it, and restore has to add it back. Two operations now, both load-bearing:

```ts
// softDeleteInventoryUnit
unit.deletedAt = new Date();
await manager.save(InventoryUnit, unit);
if (parent) {
  parent.stock = Math.max(0, (parent.stock ?? 0) - 1);
  await manager.save(Inventory, parent);
}
```

```ts
// restoreInventoryUnit
unit.deletedAt = null;
const saved = await this.inventoryUnitRepository.save(unit);
if (parent) {
  parent.stock = (parent.stock ?? 0) + 1;
  await this.inventoryRepository.save(parent);
}
```

Restore is the operation soft delete is supposed to buy you, and it's the one that exposes how shallow the metaphor is. Restoring isn't "un-deleting a row" — the row never left. It's replaying every side effect the delete fired: bump the stock back, but *not* re-fire the audit history, *not* clobber a serial that got reassigned in the meantime, *not* restore an assignment if the unit was handed to someone else while it sat in the deleted bin. My restore handles the stock count and nothing else, which is fine today because units can't be reassigned while deleted. The day that assumption changes, restore becomes a bug.

And notice I now have *both* `deleteInventoryUnit` (a real `manager.remove`) and `softDeleteInventoryUnit` (the timestamp) living in the same service:

```ts
async deleteInventoryUnit(id: string): Promise<boolean> {
  // ...
  await manager.remove(InventoryUnit, unit);
  // decrement parent.stock
}
```

Two deletes, decided by the caller. That's a tax of its own — every resolver, every frontend button, has to know which kind of delete it wants, and a wrong guess is either an irreversible loss or a row that lingers forever. The soft delete didn't simplify the deletion story. It doubled it.

## So when do you just hard-delete?

Soft delete earns its keep when **the deleted thing has downstream references you can't orphan, and a human will plausibly want it back.** An inventory unit qualifies: it's referenced by assignment history and status-change records, and "oops, un-retire that laptop" is a real request. Keeping the row keeps those foreign keys valid for free.

It does *not* earn its keep when:

- **The row is referenced by nothing.** A join table, a draft, an unsubmitted form. There's no orphan to protect, so the only thing `deletedAt` buys you is a tax on every future query for no payoff. Drop the row.
- **You actually have to delete it.** "Right to be forgotten," PII you're legally required to purge. A soft delete is the opposite of a delete here — the data is still right there. I've seen teams discover during an audit that their "deleted" user data was fully intact and fully discoverable. Awkward.
- **You only need to know it happened, not get it back.** This is the big one, and it's where I'd push back on a reflexive `deletedAt`. If the requirement is "we must be able to see that unit X was removed, by whom, and when" — that's not a soft delete, that's an **audit log**. Hard-delete the row, write an immutable record into a `*_history` table (Telelinkz already has these for status changes), and you get a clean live table with no `deletedAt IS NULL` everywhere, plus a tamper-evident trail that a soft delete can't give you anyway. A soft-deleted row can be silently un-deleted; an append-only audit row can't.

That last trade is the one I'd defend hardest. A `deletedAt` column tells you the *current* state of a row — deleted or not. An audit table tells you the *history* of what happened to it. People reach for soft delete when what they actually wanted was history, and then they're surprised it can't answer "who deleted this, and was it ever restored?"

## Rules I'd hand my past self

Soft-delete with `@DeleteDateColumn`, not a hand-rolled column, unless you have a specific reason to opt out one table. Let the framework remember the dead rows so you can't forget.

If you go manual, write one repository wrapper that injects `deletedAt IS NULL` and route every read through it. Thirty hand-typed copies of the same clause is thirty chances to miss one, and you will miss one.

A unique constraint and a soft delete cannot coexist quietly. Decide up front: partial index (if your DB has them — MySQL doesn't), null the value on delete, or accept the clash and write an honest error. Don't discover it from a confused user pointing at a constraint on a row they can't see.

Restore is not "set `deletedAt` to null." It's "replay the inverse of every side effect delete fired, given a world that moved on." Write down those side effects when you write the delete, because that's the only moment you'll remember them all.

And before any of it: ask whether you want the row back, or just the fact that it left. If it's the fact — hard-delete and write the audit row. You'll keep a clean table and a better answer to the question someone will eventually ask.
