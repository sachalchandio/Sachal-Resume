---
title: "Soft deletes done right: deletedAt, default filters, and a restore path"
description: "Hard-deleting inventory lost data and audit trail. Adding deletedAt without breaking every existing query."
date: "2026-06-20"
updated: "2026-06-20"
kind: "deepdive"
category: "Databases"
tags: ["typeorm", "soft-delete", "audit"]
month: "2026-06"
repo: "backend"
author: "Sachal Chandio"
---

A manager pinged me on a Tuesday: an agent had deleted an inventory unit that shouldn't have been deleted, and could I get it back. I couldn't. The mutation behind that button ran `repository.delete(id)`, which compiles down to `DELETE FROM inventory_unit WHERE id = ?`. The row was gone. Not soft-gone, not flagged, gone — and with it the serial number, the assignment history, every join that pointed at it. MySQL doesn't keep a copy for you. The honest answer was "restore from the nightly backup and lose everything since 2am," which is the kind of answer that makes you go fix the actual problem.

The actual problem is that "delete" in a CRM almost never means *delete*. It means "make this disappear from the lists." Those are different operations and I'd been shipping the destructive one.

## Why hard delete was wrong here, specifically

Inventory units in Telelinkz aren't standalone. A unit gets assigned to an agent, shows up in stock counts, gets referenced when a sale ships hardware. Hard-deleting one of those rows does two bad things at once. It destroys the audit trail — there's no longer any record that the unit existed, who had it, when it was retired. And it leaves dangling references in any table that held the id without a strict FK, which on a few of our older tables it did.

The fix everyone reaches for is the right one: don't remove the row, mark it. Add a `deletedAt` timestamp, treat `NULL` as "alive" and any timestamp as "deleted at this moment." TypeORM even has first-class support for it. The catch — and this is the whole reason this post exists — is that flipping on soft delete changes the meaning of every single read query you've already written. Forget that and you ship a feature where deleted units keep showing up everywhere, which is worse than not having the feature.

## The column and the entity

TypeORM gives you `@DeleteDateColumn()`. It's a sibling to `@CreateDateColumn()` and `@UpdateDateColumn()`, and the moment it's on the entity, the repository's `softDelete`, `softRemove`, and `restore` methods start working, and `find()` starts excluding deleted rows automatically.

```ts
@Entity()
export class InventoryUnit {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  serialNumber: string;

  // ...the rest of the columns...

  @DeleteDateColumn({ type: 'datetime', nullable: true })
  deletedAt: Date | null;
}
```

The migration is boring, which is the point:

```sql
ALTER TABLE `inventory_unit`
  ADD `deletedAt` datetime NULL;
```

I generated it through the CLI rather than hand-writing it, checked the diff, ran it. One nullable column, no default, no backfill needed — every existing row is `NULL`, which correctly means "not deleted." So far so easy. The easy part is always the column.

## "Filters by default" is doing a lot of work

Here's the thing nobody tells you up front. TypeORM's repository `find` family respects soft delete automatically — `repository.find()` adds `WHERE deletedAt IS NULL` for you. But the moment you reach for the query builder, that magic stops. The query builder does **not** apply the soft-delete condition unless you ask it to. And in a CRM of any size, the interesting reads are all query builder: filtered stock lists, joins across assignment, paginated grids with a dozen optional `WHERE`s.

So my first pass — flip on `@DeleteDateColumn`, redeploy — half-worked. The simple `findOne` lookups quietly started hiding deleted units. The big inventory grid, built on a query builder, kept showing them. That's the worst possible state: it *looks* like it works until you hit the screen that matters.

The query-builder fix is one call, but you have to remember it on every single builder:

```ts
const qb = this.repo
  .createQueryBuilder('unit')
  .leftJoinAndSelect('unit.assignedAgent', 'agent')
  .where('unit.warehouseId = :warehouseId', { warehouseId });

// Without this line, deleted units come back.
// TypeORM only auto-filters find(), never the query builder.
// (default is true; spelled out here so the next person sees it)
qb.where('unit.deletedAt IS NULL'); // or: qb.withDeleted() to include them
```

The discipline this forces is the actual subject of the feature. Every read you write from now on has to answer one question: alive-only, or all? There's no safe default the framework can pick for you on a raw builder, because it can't know whether you're rendering a user-facing list (alive only) or an admin recovery screen (include deleted). I went through every query builder that touched `inventory_unit` and tagged each one. Most got the `IS NULL` filter. A small number — the recovery query, a couple of internal reports — got `.withDeleted()`.

If I were starting over I'd centralize this instead of sprinkling it. A small base method that every inventory read goes through, taking an explicit `includeDeleted` flag, so the decision is made once per call site and is impossible to forget:

```ts
private baseQuery(opts: { includeDeleted?: boolean } = {}) {
  const qb = this.repo.createQueryBuilder('unit');
  if (!opts.includeDeleted) {
    qb.where('unit.deletedAt IS NULL');
  }
  return qb;
}
```

The point isn't the helper, it's that `includeDeleted` is a required thought, not an accident.

## The mutations: soft delete and restore

The destructive `delete(id)` became `softDelete(id)`, which sets `deletedAt = NOW()` and leaves the row in place. Restore is its mirror — it nulls `deletedAt` back out.

```ts
@Mutation(() => Boolean)
async softDeleteInventoryUnit(@Args('id', { type: () => Int }) id: number) {
  const result = await this.repo.softDelete(id);
  // affected === 0 means it was already deleted or never existed
  return (result.affected ?? 0) > 0;
}

@Mutation(() => Boolean)
async restoreInventoryUnit(@Args('id', { type: () => Int }) id: number) {
  const result = await this.repo.restore(id);
  return (result.affected ?? 0) > 0;
}
```

One sharp edge with `restore`: it sets `deletedAt` to `NULL` and that's all it does. It does not re-validate anything. If the unit's serial number collided with one created after it was deleted, restore will happily bring back the duplicate, because the unique constraint — if you have one — only checks live rows when you've built it as a partial index, which MySQL doesn't support the way Postgres does. On MySQL a normal `UNIQUE` index counts the deleted row too, so you can hit a constraint violation on *create* for a serial that's only "taken" by a soft-deleted unit. I'll come back to that; it's the trap that cost me the most time.

## The admin surface: deletedInventoryUnits and includeDeleted

Recovery needs two things on the read side. A dedicated query that returns *only* deleted units — that's the "trash can" screen a manager opens to find the thing they want back. And an `includeDeleted` flag on the normal listing for the rare case where you want everything in one view.

```ts
@Query(() => [InventoryUnit])
async deletedInventoryUnits(): Promise<InventoryUnit[]> {
  return this.repo.find({
    withDeleted: true,
    where: { deletedAt: Not(IsNull()) },
  });
}
```

`withDeleted: true` lifts the automatic filter so deleted rows are visible at all; the `Not(IsNull())` then narrows it to *only* the deleted ones. You need both — `withDeleted` alone gives you everything, alive and dead together. I gated this query behind an admin role, because the trash can is exactly the place you don't want a regular agent rummaging through.

The `includeDeleted` flag on the main list is just the builder choice from earlier, exposed as an argument and defaulted to `false` so the safe behavior is what you get when nobody opts in.

## The edge that actually drew blood

The serial-number uniqueness story. We had a `UNIQUE` index on `serialNumber`. Worked fine under hard delete — the row was gone, the serial was free. Under soft delete the deleted row sticks around, the index still sees it, and re-registering that same serial number throws `ER_DUP_ENTRY`. From the agent's chair it looks like "this serial already exists" for a unit they can't find anywhere, because it's been soft-deleted out of every list they can see.

On Postgres you'd reach for a partial unique index: `UNIQUE (serial_number) WHERE deleted_at IS NULL`. MySQL doesn't have partial indexes. The options that actually work on MySQL are uglier: drop the DB-level unique constraint and enforce uniqueness-among-live-rows in application code, or build a composite unique on `(serialNumber, deletedAt)` — which lets one live row and many deleted rows coexist, since each delete gets a distinct timestamp, but two simultaneous deletes of the same serial in the same second can still collide. I went with application-level enforcement: a check in the create path that queries live rows only. Slower, but it matches the actual rule, which is "no two *active* units share a serial." The constraint was never really about the dead rows.

The lesson stuck: turning on soft delete silently changes what your unique constraints mean. Anything that was unique because deletion freed it up is no longer unique the way you think.

## What I'd do differently

I'd write the query audit *first*, before touching the entity. The column is trivial; the risk is entirely in the reads, and I found that out by shipping a half-filtered feature and watching deleted units show up on the one screen that mattered. A grep for `createQueryBuilder` across the inventory module up front would have handed me the exact list of places that needed a decision.

I'd also decide the constraint story before flipping the switch, not after the first `ER_DUP_ENTRY`. Soft delete and unique-on-create are in tension on MySQL, full stop, and pretending otherwise just moves the surprise to production.

Here's when this bites you: any time "delete" in your domain means "hide," and you've got either a unique constraint that assumed deletion frees the value, or a pile of query-builder reads that won't filter themselves. The `deletedAt` column takes five minutes. The discipline of asking *alive-only or all?* on every read you write afterward is the part you're actually signing up for — and it never turns itself off.
