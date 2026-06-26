---
title: "Inventory that remembers: an assignment and request history subsystem"
description: "Tracking who held which unit, when, and why — and the indexes that keep the timeline queries fast."
date: "2026-06-06"
updated: "2026-06-06"
kind: "deepdive"
category: "Backend"
tags: ["typeorm", "audit", "inventory"]
month: "2026-06"
repo: "backend"
author: "Sachal Chandio"
---

A manager pinged me: "Who had unit TLZ-4471 in March? It came back with a cracked screen and nobody will own it."

I couldn't answer. The inventory table only knew the present. `inventory_units` had an `agentId`, an `isAssigned` flag, a `condition`, a `status` — all describing right now. Every reassignment just overwrote those columns. The unit had been handed to four people that quarter and the database remembered none of it. The only "history" was whatever the previous holder happened to type into the `assignmentDetails` text field before it got clobbered by the next assignment.

So the answer to "who had it in March" was a shrug. That's not acceptable for hardware that walks out the door on people's desks.

## The shape of the problem

The current-state model isn't wrong — you genuinely do want a cheap `WHERE agentId = ?` to find what someone holds today. The mistake was making that the *only* model. State and history are two different questions and I'd been answering both with one row.

What I actually needed was an append-only log. Every time a unit changed hands, changed condition, or changed status, write a row. Never update it, never delete it. The unit table stays the fast "now" view; the history table becomes the slow-but-complete "ever" view. Two tables, two jobs.

The events I had to capture turned out to be four kinds, which became an enum:

```ts
export enum InventoryHistoryAction {
  ASSIGNED = 'ASSIGNED',
  UNASSIGNED = 'UNASSIGNED',
  CONDITION_CHANGED = 'CONDITION_CHANGED',
  STATUS_CHANGED = 'STATUS_CHANGED',
}
```

A unit goes out (ASSIGNED), comes back (UNASSIGNED), gets reclassified as damaged without changing hands (CONDITION_CHANGED), or gets pulled from circulation entirely (STATUS_CHANGED). Each event needs to know two distinct people: who the unit went *to*, and who *did* the assigning. Those are not the same person and conflating them is how audit logs become useless.

## The entity

Here's the core of `InventoryAssignmentHistory`. I'm trimming the column-by-column noise, but the structural decisions are all here.

```ts
@Entity('inventory_assignment_history')
@ObjectType('InventoryAssignmentHistory')
@Index('IDX_inv_history_unit_ts', ['inventoryUnitId', 'timestamp'])
@Index('IDX_inv_history_assignedTo', ['assignedToId'])
@Index('IDX_inv_history_ts', ['timestamp'])
@Index('IDX_inv_history_action', ['action'])
export class InventoryAssignmentHistory extends BaseEntity {
  @Column({ type: 'enum', enum: InventoryHistoryAction })
  action: InventoryHistoryAction;

  @Column({ type: 'datetime' })
  timestamp: Date;

  @Column({ type: 'uuid' })
  inventoryUnitId: string;

  // who it went to (null for status/condition events)
  @Column({ type: 'uuid', nullable: true })
  assignedToId: string | null;

  // who pressed the button (the admin/manager)
  @Column({ type: 'uuid', nullable: true })
  performedById: string | null;

  @Column({ type: 'enum', enum: InventoryCondition, nullable: true })
  conditionAtAssignment: InventoryCondition | null;

  @Column({ type: 'enum', enum: InventoryCondition, nullable: true })
  conditionOnReturn: InventoryCondition | null;

  @Column({ type: 'enum', enum: UnitStatus, nullable: true })
  previousStatus: UnitStatus | null;

  @Column({ type: 'enum', enum: UnitStatus, nullable: true })
  newStatus: UnitStatus | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
```

A few things I want to defend.

Almost everything except `action`, `timestamp`, and `inventoryUnitId` is nullable. That bugged me at first — a wide table where half the columns are null on any given row looks sloppy. But the alternative is one table per action type, four-way joins to reconstruct a timeline, and a migration every time someone invents a fifth event. One flat append-only table that's mostly null on a per-row basis is the right tradeoff here. The nulls are cheap; the joins would not have been.

I store `previousStatus` and `newStatus` *both*, even though `previousStatus` of one row is technically derivable from the `newStatus` of the row before it. Storing the before-state on the same row means a single history row is self-describing. You can read "AVAILABLE → ASSIGNED" off one record without fetching its neighbor. When you're rendering a timeline that's worth a lot, and it costs me two enum columns.

`notes` is where the *why* lives, and it's not optional in practice. The service layer rejects an empty audit message before it ever reaches here:

```ts
const message = this.requireAuditMessage(params.message, 'assign a unit');
```

If you can't say why you reassigned a $400 router, you don't get to reassign it. That rule caught more sloppy assignments than any code review did.

## Writing it on the same transaction

This is the part I got wrong the first time, so it gets its own section.

The naive version logged history best-effort: do the unit update, then `try/catch` a history insert after, swallow any error. It "worked." It also meant that any time the history write failed — connection blip, deadlock, whatever — the unit's real state and its audit log silently diverged. You'd see a unit assigned to nobody in the history but assigned to someone in reality, or vice versa. An audit log you can't trust is worse than no audit log, because people *believe* it.

The fix was to thread an optional `EntityManager` through every recording helper and let the caller pass its transaction in:

```ts
private repo(manager?: EntityManager): Repository<InventoryAssignmentHistory> {
  return manager ? manager.getRepository(InventoryAssignmentHistory) : this.historyRepo;
}
```

Now the assignment flow wraps the unit mutation and the history insert in one transaction, so they commit or roll back together:

```ts
return this.inventoryRepository.manager.transaction(async (manager) => {
  const unitRepo = manager.getRepository(InventoryUnit);
  const unit = await unitRepo.findOne({ where: { id: params.unitId, deletedAt: null } });
  if (unit.isAssigned) {
    throw new BadRequestException(
      `Unit ${unit.id} is already assigned. Return it to inventory before reassigning.`,
    );
  }

  const previousStatus = unit.status;
  const conditionSnapshot = unit.condition; // snapshot BEFORE we mutate

  unit.isAssigned = true;
  unit.agentId = params.employeeId;
  unit.status = UnitStatus.ASSIGNED;
  const saved = await unitRepo.save(unit);

  await this.historyService.recordAssignment(
    {
      inventoryUnitId: unit.id,
      assignedToId: params.employeeId,
      performedById: params.performedById ?? null,
      conditionAtAssignment: conditionSnapshot,
      previousStatus,
      assignmentType: params.assignmentType,
      notes: message,
    },
    manager, // <- same transaction as the unit write
  );

  return saved;
});
```

Note the `conditionSnapshot` taken before the mutation. The history row has to reflect the world *as it was at the moment of the event*, not as it ends up after. I snapshot `previousStatus` and the prior condition first, mutate, then record. For the bulk return path it's the same idea, just mapped over an array before the loop touches anything — snapshot every unit's prior state up front, then mutate them all, then a single multi-row INSERT.

I kept the old best-effort signature working by making `manager` optional. Legacy callers that don't pass one fall back to the injected repository and behave exactly as before. New audited flows pass the transaction. That let me migrate call sites one at a time instead of in a scary big-bang PR.

## The indexes are the whole point

A history table is write-once, read-many, and it grows forever. Without the right indexes the timeline view degrades from "instant" to "spinner" somewhere around the first hundred thousand rows, and nobody notices until a customer does.

The one that matters most is the composite:

```ts
@Index('IDX_inv_history_unit_ts', ['inventoryUnitId', 'timestamp'])
```

Every per-unit timeline query is `WHERE inventoryUnitId = ? ORDER BY timestamp DESC`. With `(inventoryUnitId, timestamp)` indexed together, MySQL seeks straight to that unit's rows and walks them in timestamp order off the index — no filesort, no scanning the whole table to sort. Column order matters: equality predicate first (`inventoryUnitId`), range/sort column second (`timestamp`). Flip them and the index is useless for this query.

There's a nice second-order effect when you look a unit up by serial number instead of id. `inventory_units.serialNumber` is uniquely indexed, so the join resolves serial → unit id cheaply, and then the composite drives the actual history scan:

```ts
if (filter.serialNumber) {
  qb.andWhere('unit.serialNumber = :serial', { serial: filter.serialNumber });
}
```

A warehouse person literally scans a barcode and gets that unit's life story back, fast, even with millions of history rows behind it.

The `assignedToId` index answers "what has this person ever been handed," and the bare `timestamp` index drives time-range analytics — "everything that happened in March," which was the question that started this whole thing.

For the dashboard counters I leaned on SQL aggregation instead of pulling rows into Node and counting them:

```ts
const raw = await this.historyRepo
  .createQueryBuilder('h')
  .select('COUNT(CASE WHEN h.action = :assigned THEN 1 END)', 'totalAssignments')
  .addSelect(
    'COUNT(DISTINCT CASE WHEN h.action = :assigned THEN h.assignedToId END)',
    'uniqueAssignees',
  )
  .addSelect(
    "COUNT(CASE WHEN h.action = :unassigned AND h.conditionOnReturn = 'DAMAGED' THEN 1 END)",
    'damagedReturnCount',
  )
  .where('h.inventoryUnitId = :unitId', { unitId })
  .getRawOne();
```

One round trip, the database does the counting, and "how many people have held this unit and how many times did it come back broken" is one query instead of a `.length` over a hydrated array.

## The request side

Assignments were half the story. The other half is requests — an agent asks for a unit, a manager approves or rejects. That lives in `inventory_requests`, with a status enum that moves PENDING → APPROVED / REJECTED, a `requestedById`, a `message`, and a `rejectionReason` so a denial is never a mystery. The same discipline applies: a status transition is an event, and an event needs an actor and a reason. The rejection reason being a first-class column rather than buried in free text means "why was this denied" is queryable, not archaeological.

## What I'd do differently

I'd reach for a single polymorphic `inventory_event` table from the start instead of growing toward it. Right now assignment history and request status changes live in separate places, and there's a real itch to unify them into one event stream you can replay as a single timeline. I didn't, because shipping the assignment log answered the urgent question, and premature unification is its own trap. But I can feel where it bites later.

The other thing: I store `performedById` as a nullable FK to `users`, which is honest but optimistic. People leave. When that user row gets soft-deleted, the history still points at it, which is what you want — you don't rewrite history because someone quit. But it means the join has to tolerate deleted actors, and any "performed by" display needs to handle the tombstoned case gracefully instead of showing a blank. I'd bake that into the read model earlier next time rather than discovering it when an ex-employee's name rendered as empty in the audit view.

Here's the thing nobody tells you about audit logs: the day you need one, you needed it three months ago. The whole value is retroactive. You can't go back and capture March's assignments after the fact — you can only start writing them down now and hope the question waits until you have data. So when in doubt, log the event. Storage is cheap. The shrug is expensive.
