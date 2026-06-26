---
title: "Audit trails that earn their keep"
description: "History tables answer ‘who changed this’ — but only some changes are worth the storage. Where I draw the line."
date: "2026-02-23"
updated: "2026-02-23"
kind: "deepdive"
category: "Backend"
tags: ["audit", "history", "typeorm"]
month: "2026-02"
repo: "backend"
author: "Sachal Chandio"
---

A manager pinged me on a Tuesday: a rep swore a lead had been marked *Sale* on Friday, the dashboard said *Callback*, and money was attached to the difference. Without a history table that's a he-said-she-said and I'm grepping application logs hoping someone left a breadcrumb. With one it's a single query, sorted by timestamp, and the argument is over in thirty seconds. That's the whole pitch for audit trails, and it's a good pitch.

The bad version of the pitch is "so let's log everything." A history table on every entity is just a second database that grows faster than the first one and never gets read. I've built four of these on Telelinkz that pull their weight — task assignments, inventory unit lifecycle, package versions, and call disposition changes — and the thing they have in common isn't the schema. It's that someone was going to ask a question the live row couldn't answer.

## The shape: who, what, when, old, new

Every history row I keep answers five questions. Who did it, what changed, when, the old value, the new value. Miss one and the table stops settling disputes. The disposition history is the cleanest example because it exists purely to answer "why did this lead's outcome change":

```ts
@ObjectType()
@Entity()
export class CallDispositionHistory extends BaseEntity {
  @Column({ type: 'enum', enum: CallDisposition })
  previousDisposition: CallDisposition;   // old

  @Column({ type: 'enum', enum: CallDisposition })
  updatedDisposition: CallDisposition;    // new

  @Column({ type: 'text' })
  comment: string;                        // what/why — required, not nullable

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'updatedById' })
  updatedBy: User;                        // who

  @ManyToOne(() => InterestedCustomer, (c) => c.callDispositionHistories)
  customer: InterestedCustomer;
}
```

Two decisions there I'd defend to anyone. The `comment` is `text` and not nullable — if you change a disposition you tell us why, no empty audit rows. And `previousDisposition`/`updatedDisposition` are stored explicitly rather than reconstructed by diffing the previous history row, because reconstruction breaks the moment a row gets backfilled or deleted, and audit data is exactly the data you can't trust to stay tidy.

This one earned an extra column most history tables don't need: `approvalStatus`. A disposition change to *Sale* is a financial event, so the row starts `PENDING`, and a manager flips it to `APPROVED` or `REJECTED` with a `rejectionMessage`. The history table doubles as a workflow queue. That's not scope creep — it's the same insight, that this particular change is worth pausing on, expressed as a column.

## When "who" is two people

The inventory history taught me that "who" is sometimes two separate people. When an admin assigns a router to a field rep, the person the unit went *to* and the person who *did the assigning* are different humans, and you want both. So the table carries `assignedToId` and `performedById` side by side:

```ts
@Entity('inventory_assignment_history')
@Index('IDX_inv_history_unit_ts', ['inventoryUnitId', 'timestamp'])
@Index('IDX_inv_history_assignedTo', ['assignedToId'])
@Index('IDX_inv_history_action', ['action'])
export class InventoryAssignmentHistory extends BaseEntity {
  @Column({ type: 'enum', enum: InventoryHistoryAction })
  action: InventoryHistoryAction;          // ASSIGNED / UNASSIGNED / CONDITION_CHANGE / ...

  @Column({ type: 'uuid', nullable: true })
  assignedToId: string | null;             // who has it now

  @Column({ type: 'uuid', nullable: true })
  performedById: string | null;            // who pushed the button

  @Column({ type: 'enum', enum: InventoryCondition, nullable: true })
  conditionAtAssignment: InventoryCondition | null;

  @Column({ type: 'enum', enum: InventoryCondition, nullable: true })
  conditionOnReturn: InventoryCondition | null;

  @Column({ type: 'enum', enum: UnitStatus, nullable: true })
  previousStatus: UnitStatus | null;
  @Column({ type: 'enum', enum: UnitStatus, nullable: true })
  newStatus: UnitStatus | null;
}
```

I wrote a comment at the top of that file that I now treat as a rule: *append-only, no UPDATE or DELETE in normal operation.* A history table you edit isn't a history table. The day you `UPDATE` a row to "fix" it is the day the table stops being evidence, and the entire reason it exists is to be evidence. If a row is wrong, you write a corrective row. You don't rewrite the past.

## The wide diff: store the change set as JSON

Tasks and packages have a lot of editable fields, and I did not want a column per field on the history table. A task can change its name, status, priority, assignee, due date, description, group, client, workspace — eighteen-ish things. A column-per-field history table for that is grotesque and mostly NULL. So for the wide entities the "what changed" is a single JSON column holding only the fields that actually moved:

```ts
// package_audit_log
export interface PackageAuditFieldChange { from: unknown; to: unknown; }
export type PackageAuditChangedFields = Record<string, PackageAuditFieldChange>;

@Column({ type: 'json' })
changedFields: PackageAuditChangedFields;

@Column({ type: 'text' })
changeSummary: string;        // human-readable, for the UI

@Column({ type: 'varchar', length: 500, nullable: true })
changeReason?: string;
```

A row that bumps a commission looks like `{ "commission": { "from": 45.00, "to": 50.00 } }` and nothing else. The task table does the same with a typed `TaskChanges` shape where every field is an optional `ChangeEntry { from, to, changedAt }`. The win is that an unchanged field never appears, so the row's size tracks the size of the edit, not the width of the entity.

The cost, and it's real: you cannot index into a MySQL JSON column the way you'd index a real column, so "show me every package whose commission ever dropped" is not a cheap query. I accepted that because nobody asks that question on a dashboard — they ask it once, in an investigation, and a slow query in an investigation is fine. The day someone *does* want commission-drop on a live screen, that field graduates out of JSON into its own column. Until then it stays cheap to write.

Packages also keep a parallel, heavier record: a real `package_version` row per version, with `isCurrent`, `validFrom`/`validTo`, and a unique index on `(packageId, version)`. That's not redundant with the audit log. The audit log says *who changed the commission and why*; the version table is the actual historical commission a sale closed on, so a commission report run today still reconstructs what a rep earned six months ago against the rate that was live then. Two tables, two jobs — one is the paper trail, one is the time machine.

## Indexing: you write often, you read by entity and by time

The trap with history tables is that they're write-heavy and you index them like read tables. The reads, when they come, are almost always "everything for this one entity, newest first" or "everything in this time window." So the index that matters is the composite on `(entityId, timestamp)`:

```ts
@Index('IDX_inv_history_unit_ts', ['inventoryUnitId', 'timestamp'])
@Index('IDX_package_audit_log_packageId_createdAt', ['packageId', 'createdAt'])
```

Leading column is the entity id so the per-entity timeline is a range scan, not a filesort. I add a `changedById`/`createdAt` index too because "what did this user touch this week" is a real compliance question, and an `action`/`createdAt` index when the action enum is something people filter on. What I *don't* do is index every column just because it's there. Each index is a tax on every insert, and this table's hot path is inserts. Three or four deliberate composite indexes, chosen from the questions people actually ask, beats eight hopeful single-column ones.

## The test: would anyone ever ask?

Here's the line I draw, and it has nothing to do with how easy the table is to add. Before I create a history table I ask one question: *will a human, or money, ever need this answered after the fact?*

- A disposition flips a lead to *Sale* with commission attached → yes, money. Keep it.
- A router moves from the warehouse to a rep and comes back damaged → yes, someone eats the cost. Keep it.
- A package's commission rate changes → yes, every sale closed under the old rate depends on it. Keep it.
- A task's `description` gets a typo fixed → no. Nobody will ever litigate a typo.

That last one is the tell. The task history *can* record a description change, and the JSON shape makes it nearly free to do so, but "nearly free to write" is the trap. Free to write is not free to store, and it's definitely not free to read past — every junk row is noise the next investigator scrolls through to find the row that mattered. The disposition table is useful precisely because every row in it is a decision someone might have to defend. Dilute that with cosmetic edits and you've rebuilt the application log, except slower and in your primary database.

I got this wrong early. The first task history I shipped logged every field change indiscriminately, and within a month the timeline UI was a wall of "due date moved by an hour" rows that nobody read. The fix wasn't schema. It was deciding which fields were *events* (status, assignee, priority — things with consequences) and which were *edits* (notes, description — things you just fix), and only treating events as worth a prominent history entry.

## What I'd tell myself before building the next one

Append-only or it's not an audit trail — if you ever `UPDATE` a history row, delete the table and stop pretending. Store old and new explicitly, never reconstruct by diffing neighbors, because audit data outlives the assumptions you'd reconstruct under. Put the "why" next to the "what" and make it required for changes that touch money; an audit row with no reason is half a row. Index for the two questions people actually ask — this entity's timeline, and this window of time — and resist indexing the rest. And run the test before you reach for the generator: not *can I log this* but *will anyone ever ask*. Almost everything fails that test, which is exactly why the tables that pass it are worth their weight.

The bill comes due when you skip the test. A history table on everything doesn't fail loudly — it fails as a slow creep of write latency and a timeline nobody trusts because the signal drowned in cosmetic noise. The four tables I keep are the four where someone, eventually, asked. That's the only justification a history table ever needs, and it's the only one I'd accept.
