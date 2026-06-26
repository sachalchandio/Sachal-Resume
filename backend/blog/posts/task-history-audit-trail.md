---
title: "An audit trail for every task change (and how to revert one)"
description: "Who changed the due date? History tables that answer the question and let an admin undo."
date: "2025-02-04"
updated: "2025-02-04"
kind: "deepdive"
category: "Backend"
tags: ["audit", "typeorm", "history"]
month: "2025-02"
repo: "backend"
author: "Sachal Chandio"
---

A team lead pinged me on a Tuesday: "The follow-up date on this task moved from Friday to next month. Who did that?" I had no answer. The task row had a `dueDate` of next month and an `updatedAt` of yesterday afternoon, and that was the entire story the database could tell. No before-value, no actor, nothing. The change had overwritten its own evidence.

That's the problem with mutable rows. Every `UPDATE` is a tiny act of forgetting. You see the present state and the timestamp of the last edit, and everything that came before is gone unless you went out of your way to keep it. For most columns nobody cares. For a sales CRM where a task's due date is the difference between a closed deal and a forgotten lead, somebody cares a lot.

## What I actually needed

Not full event sourcing. I want to be clear about that up front, because the temptation when you get burned by lost history is to overcorrect and rebuild the whole task module as an append-only event log. I didn't need to reconstruct a task from its events. I needed to answer three concrete questions:

- Who changed this field, and when?
- What was the value before they changed it?
- Can an admin put it back?

That's a per-field change log, not an event store. The distinction matters because it told me the shape of the table. One row per field that changed, per update. If someone edits a task and moves the `dueDate` and the `assigneeId` in the same save, that's two history rows, not one blob.

## The entity

I went with a separate `task_history` table rather than stuffing a JSON column onto `task` itself. The JSON-blob approach is tempting because it's one fewer table, but querying "every change to the due date across all tasks this month" against a JSON column in MySQL is miserable, and I knew that report request was coming. A real table with real columns it is.

```ts
@Entity('task_history')
export class TaskHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  taskId: string;

  @ManyToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'taskId' })
  task: Task;

  // The field that changed, e.g. 'dueDate', 'assigneeId', 'status'
  @Column()
  field: string;

  // Stored as text. The value could be a date, an id, an enum — text holds all of it.
  @Column({ type: 'text', nullable: true })
  oldValue: string | null;

  @Column({ type: 'text', nullable: true })
  newValue: string | null;

  @Column()
  changedById: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'changedById' })
  changedBy: User;

  @CreateDateColumn()
  changedAt: Date;
}
```

The decision I want to defend is `oldValue` and `newValue` as `text`. Strong typing would be nicer — a real `date` column for date changes — but a single history table tracks fields of different types, so the storage has to be the lowest common denominator. I serialize to string on the way in and let the read side interpret based on `field`. A date becomes its ISO string, an id stays an id, an enum stays its string member. The cost is that you can't do arithmetic on the column in SQL, but I never wanted to; I wanted to read it back, not aggregate it.

## Recording changes

The naive version I shipped first compared every column on the entity and wrote a history row for anything that differed. It worked and it was wrong. It logged `updatedAt` changing on every save — of course it changed, I'd just saved it — and it logged internal bookkeeping columns nobody asked about. The history table filled with noise. Within a day, half the rows were `field: 'updatedAt'`.

So I made the set of audited fields explicit. A whitelist, not a diff of the whole row.

```ts
const AUDITED_FIELDS: (keyof Task)[] = [
  'title',
  'description',
  'dueDate',
  'status',
  'priority',
  'assigneeId',
];

private buildHistoryRows(
  taskId: string,
  before: Task,
  after: Partial<Task>,
  changedById: string,
): TaskHistory[] {
  const rows: TaskHistory[] = [];

  for (const field of AUDITED_FIELDS) {
    if (after[field] === undefined) continue; // field wasn't part of this update

    const oldVal = this.serialize(before[field]);
    const newVal = this.serialize(after[field]);
    if (oldVal === newVal) continue; // no actual change

    rows.push(
      this.historyRepo.create({
        taskId,
        field,
        oldValue: oldVal,
        newValue: newVal,
        changedById,
      }),
    );
  }

  return rows;
}

private serialize(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
```

The `after[field] === undefined` check is doing more work than it looks. The update DTO is a `Partial<Task>`, so if a caller only sends `{ dueDate }`, I don't want to read `assigneeId` off the partial, get `undefined`, and log that the assignee was cleared. Undefined means "not part of this update." Null means "explicitly cleared." Conflating those two is the bug that turns an audit log into a liar.

The write happens in the same transaction as the task update. This is the part people skip and regret. If the task `UPDATE` commits but the history `INSERT` fails, you've got a changed task with no record of who changed it — which is the exact situation the table exists to prevent.

```ts
async update(id: string, dto: UpdateTaskInput, actor: User): Promise<Task> {
  return this.dataSource.transaction(async (manager) => {
    const before = await manager.findOneOrFail(Task, { where: { id } });

    const historyRows = this.buildHistoryRows(id, before, dto, actor.id);

    await manager.update(Task, id, dto);
    if (historyRows.length) {
      await manager.save(TaskHistory, historyRows);
    }

    return manager.findOneOrFail(Task, { where: { id } });
  });
}
```

I read `before` inside the transaction so I'm diffing against the row as it exists at update time, not against a stale copy the caller handed me.

## Reading it back

The GraphQL side is the easy part. A `getTaskHistory` query, ordered newest-first, with the actor resolved so the UI shows a name instead of a UUID.

```ts
@Query(() => [TaskHistory])
async getTaskHistory(
  @Args('taskId') taskId: string,
): Promise<TaskHistory[]> {
  return this.historyRepo.find({
    where: { taskId },
    relations: { changedBy: true },
    order: { changedAt: 'DESC' },
  });
}
```

On the Angular side this renders as a timeline: "Sachal changed Due date from Feb 7 to Mar 3, 14 days ago." The `field` and the two values are enough to render a human sentence, which is the whole point. Nobody wants to read a row of a database table; they want to read a sentence.

## The revert

This is where it stopped being a logging exercise and started being interesting. A revert isn't a delete of the history row — that would itself be an unaudited change, which defeats the purpose. A revert is a *new* update that happens to restore a prior value, and it gets logged like any other update.

```ts
async revert(historyId: string, actor: User): Promise<Task> {
  const entry = await this.historyRepo.findOneOrFail({
    where: { id: historyId },
  });

  const value = this.deserialize(entry.field, entry.oldValue);

  // Reuse the normal update path so this revert is itself audited.
  return this.update(entry.taskId, { [entry.field]: value }, actor);
}
```

The nice property here is that reverting through the normal `update` path means the revert writes its own history row: `field: 'dueDate', oldValue: 'Mar 3', newValue: 'Feb 7', changedBy: admin`. You can revert a revert. The log never lies about who did what, including the undo.

`deserialize` is the asymmetry I had to handle carefully. On the way in everything became a string; on the way out I have to turn it back into the type the column expects, and the only thing that tells me the type is the field name.

```ts
private deserialize(field: string, raw: string | null): unknown {
  if (raw === null) return null;
  if (field === 'dueDate') return new Date(raw);
  if (field === 'priority' || field === 'assigneeId') return raw;
  return raw;
}
```

It's a small `switch`-shaped function and it's a little ugly, but it's honest about the fact that a `text` column doesn't know what it's holding. If I added more typed fields I'd lean on the column metadata TypeORM already has rather than growing this by hand — `getMetadata(Task).findColumnWithPropertyName(field)` knows the real type. I didn't need it yet for six fields.

## The sharp edges

The first one bit immediately: I logged `dto` directly as `newValue` before realizing a `Date` object stringifies to something useless if you let JavaScript do it implicitly. `String(new Date())` gives you `"Wed Feb 04 2025 ..."` in local time, which is unparseable garbage to deserialize. That's why `serialize` checks for `Date` explicitly and forces `.toISOString()`. Round-tripping a value through the table only works if the serialize and deserialize agree on format, and the default `toString()` does not agree with `new Date(str)`.

The second: cascade. I set `onDelete: 'CASCADE'` on the task relation so deleting a task takes its history with it. For a while I second-guessed that — isn't the audit trail exactly the thing you want to *survive* a delete? In practice our tasks soft-delete (a `deletedAt` column), so a real hard delete only happens in cleanup, and keeping orphaned history rows pointing at a task that no longer exists was more confusing than useful. If your deletes are hard and meaningful, keep the history and accept the orphans.

The third was volume, and this is the honest tradeoff. A task that gets edited ten times a day across a few thousand active tasks generates history fast. I added the index on `taskId` from the start because every read filters on it, and I have a quiet plan to age out rows older than a year into cold storage if it ever matters. It hasn't yet. The table is a few hundred thousand rows and MySQL doesn't care.

## When this is overkill

I'd push back on adding a history table reflexively. It earns its storage when three things are true: the data is mutable, the *previous* value has business meaning, and a human will actually ask "who changed this." Task due dates and assignees hit all three. A user's last-login timestamp hits none — it's mutable but nobody disputes it, and you'd just be paying to log noise.

The signal I'd watch for is a support ticket that starts with "this used to be X and now it's Y and I don't know why." The first time you can't answer it, you needed the table yesterday. The mistake is the opposite reflex — auditing everything because auditing one thing felt good. A whitelist of six fields gave me every answer I've been asked for since, and the rows I *don't* write are as much of the design as the ones I do.
