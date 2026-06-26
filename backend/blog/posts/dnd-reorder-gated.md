---
title: "Drag-and-drop reordering, gated to the right users"
description: "Subtasks rendered across pagination and a drag handle that only privileged users get."
date: "2026-02-25"
updated: "2026-02-25"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "cdk", "dnd"]
month: "2026-02"
repo: "frontend"
author: "Sachal Chandio"
---

The task board worked, technically. You could create a task, add subtasks under it, assign people, drop a file on it. But it didn't *feel* like a tool you'd reach for first thing in the morning. Two things gave it away. Subtasks vanished the moment a parent's children spilled past the 10-row page, so half a checklist would just not be there. And the order was whatever the database handed back — `ORDER BY id`, effectively creation order — with no way to say "do this one first." A sales lead asked me, more or less, "can I just drag these into the order I want?" and that one sentence turned into a week.

This is the story of making reordering real: rendering subtasks regardless of pagination, wiring up the CDK drag-drop, and making sure a regular agent can't quietly reshuffle the team's queue while a manager isn't looking.

## Subtasks were getting eaten by the page limit

The list is paginated server-side at 10 items. That's fine for top-level tasks. The bug was that subtasks were being fed through the *same* pagination. A parent task at the bottom of page one would have three of its five subtasks on page one and the other two stranded on page two, where they rendered as orphans with no parent in sight. Visually, the checklist just looked incomplete.

The wrong fix is to bump the page size. The right fix is to stop treating subtasks as page-able rows at all. They're not independent items; they belong to a parent. So I changed the query to page only over *parent* tasks, and to hydrate each parent's full set of children regardless of count.

On the backend that meant the GraphQL `tasks` query paginates the parents, and `subtasks` is a field resolver that loads all children for each returned parent in one batched call:

```ts
@ResolveField(() => [Task])
async subtasks(@Parent() task: Task): Promise<Task[]> {
  // batched per request so 10 parents = 1 query, not 10
  return this.subtaskLoader.load(task.id);
}
```

The frontend stopped flattening the list. Each parent row owns its children, and the children render inside the parent's expanded panel as a complete set, sorted by a new `position` column rather than `id`. The page limit now only ever counts parents. A parent with twelve subtasks shows twelve subtasks; it just counts as one row toward the ten.

That `position` column is the quiet hero of the whole feature. It's an `int`, default `0`, and it's what every other piece here leans on. Without an explicit order field you have nothing to reorder — you'd be fighting the database's idea of order forever.

## Why the CDK and not a library

For the drag itself I used Angular's CDK drag-drop (`@angular/cdk/drag-drop`), not one of the standalone DnD libraries. Two reasons. We already pull the CDK in for overlays and the virtual scroll elsewhere, so it's zero new dependency weight. And `cdkDropList` does the one thing I actually needed without ceremony: it gives you a `cdkDropListDropped` event with `previousIndex` and `currentIndex`, and a `moveItemInArray` helper that mutates your array to match. That's 90% of reordering right there.

The markup is a list that's also a drop zone, with each row a drag item:

```html
<div cdkDropList (cdkDropListDropped)="onDrop($event)">
  @for (sub of subtasks(); track sub.id) {
    <div cdkDrag [cdkDragDisabled]="!canReorder()" class="subtask-row">
      <span class="drag-handle" cdkDragHandle>
        <mat-icon>drag_indicator</mat-icon>
      </span>
      <span class="subtask-title">{{ sub.title }}</span>
    </div>
  }
</div>
```

Two things in there are deliberate. `cdkDragHandle` restricts the grab to the little six-dot icon — without it, the whole row is draggable and you can't select text or click into the title without accidentally picking the row up. And `[cdkDragDisabled]="!canReorder()"` is the gate, which I'll get to. When disabled, the CDK leaves the row completely inert: no drag, no placeholder, no cursor change. That's exactly what I want for a user who isn't allowed to touch the order.

The drop handler does the optimistic local move first, then persists:

```ts
onDrop(event: CdkDragDrop<Subtask[]>) {
  if (event.previousIndex === event.currentIndex) return;

  const list = [...this.subtasks()];
  moveItemInArray(list, event.previousIndex, event.currentIndex);
  this.subtasks.set(list); // optimistic — UI snaps immediately

  const ordered = list.map((s, i) => ({ id: s.id, position: i }));
  this.reorder.mutate({ taskId: this.parentId, ordered })
    .subscribe({ error: () => this.subtasks.set(this.previous()) });
}
```

I send the *whole* reordered list of `{ id, position }` pairs, not just "this id moved to index 4." Sending the full ordering is dumber and it's correct: the server doesn't have to reason about how a single move ripples through everyone else's index, it just writes what I tell it. Twelve rows is nothing. If these were thousands I'd reconsider, but subtask lists are short by nature and the clarity is worth more than the bytes.

The optimistic `set` makes the drag feel instant — the row lands where you dropped it before the network even hears about it — and on error I roll back to the snapshot I took before the move. A failed reorder shouldn't leave the UI in a state the database disagrees with.

## The gate: not everyone gets to drag

Here's the part the lead actually cared about, even if she didn't phrase it this way. If anyone can reorder, then "first in the queue" means nothing, because the last person to drag wins. Order is a shared signal about priority, and a shared signal needs an owner. So reordering is a privileged action: admins and managers can drag, a plain agent cannot.

The naive version is one line — hide the handle for non-privileged users — and I shipped exactly that first:

```html
@if (canReorder()) {
  <span class="drag-handle" cdkDragHandle>...</span>
}
```

It's not wrong, but it's not enough, and the reason is the same reason the restricted-nav-link work taught me earlier: the frontend check is an affordance, not an enforcement. `cdkDragDisabled` and a hidden handle make the UI honest for honest users. They do nothing against someone who opens the network tab, watches the `reorderSubtasks` mutation fire once, and replays it with a tweaked payload. The real gate has to live on the server.

So the mutation is guarded by user type, the same way the route guards work:

```ts
@Mutation(() => Boolean)
@UseGuards(GqlAuthGuard)
async reorderSubtasks(
  @Args('taskId', { type: () => Int }) taskId: number,
  @Args('ordered', { type: () => [SubtaskOrderInput] }) ordered: SubtaskOrderInput[],
  @CurrentUser() user: AuthUser,
): Promise<boolean> {
  if (!canReorderTasks(user.userType)) {
    throw new ForbiddenException('You are not allowed to reorder tasks');
  }
  await this.tasks.applyOrder(taskId, ordered);
  return true;
}
```

`canReorderTasks` is one helper, called in two places. The resolver calls it to actually block the write. The frontend calls the same logic — via the user type already in the auth signal — to decide whether to render the handle and whether to set `cdkDragDisabled`. Same rule, two layers, and only the server layer is load-bearing. The client layer just keeps the UI from offering something it'll refuse to honor.

I deliberately did *not* hide the subtasks themselves from agents. They can see the order, they can check items off, they just can't change the sequence. Read the queue, work the queue, don't reshuffle the queue. That's the right amount of permission for the role.

## Presigned uploads sitting underneath

One thing the board leans on that's easy to miss: dropping a file onto a task doesn't push bytes through our API. The attachment row you drag around carries a reference to an S3 object that the browser uploaded directly, using a presigned POST URL we mint per upload. I wrote that part up separately, but it matters here because the reorder feature and the upload feature share the same task rows — when you drag a subtask that has a 30MB spec sheet attached, you're moving a `position` integer, not the file. The file never moved and never needed to. Keeping the heavy thing (the upload) off the API and the light thing (the order) on a tiny mutation is the same instinct applied twice: only send what has to be sent.

## The sharp edges

**The drop list and the page scroll fought each other.** The subtask list lives inside a scrollable panel, and the CDK's auto-scroll-while-dragging kicked in against the *wrong* scroll container the first time. Dragging toward the bottom of a long list scrolled the whole page instead of the panel, and the placeholder would lag behind the cursor. The fix was making the panel the explicit boundary with `cdkDropListAutoScrollDisabled` off but constraining the drag with `cdkDragBoundary` to the panel element, so the row can't be dragged outside its own list and the auto-scroll targets the right thing.

**`track` matters more than usual here.** With the new control flow I had `@for (sub of subtasks(); track sub.id)`. Early on I'd lazily written `track $index`, and reordering with index-based tracking is a special kind of broken — Angular thinks every item changed because every index now points at a different object, so it tears down and rebuilds the whole list mid-drag, and the CDK loses the row it was holding. Track by the stable `id`. With the move animation this is the difference between a smooth slide and a flicker.

**Position collisions on concurrent edits.** Two managers reordering the same parent's subtasks within a second of each other can both compute positions from the same starting list and write conflicting `position` values. I don't lock anything; I just make the write a full rewrite of the ordering inside a transaction, last-writer-wins, and the loser's tab gets a fresh list on its next poll. For a subtask checklist that's acceptable. For something where the order is contractual I'd want optimistic-concurrency with a version column, but that would have been solving a problem two managers have never actually hit.

## What I'd do differently

The duplicated rule — `canReorderTasks` on the server and the mirrored check on the client — is the same shape of debt I keep accruing in this app. It's two copies of one fact, and nothing fails if they drift. If I tightened the server rule and forgot the client, an agent would see a drag handle that throws a `ForbiddenException` the instant they use it, which is a worse experience than no handle at all. The honest fix is to ship the permission down once — fold it into the user's capabilities payload at login so the client reads a flag instead of re-deriving the rule — and let the server stay the only place the rule is *defined*. I didn't, because the helper was four lines and the capabilities plumbing was a half-day, and the four lines shipped on a Friday.

The other thing: `position` as a dense integer means every reorder rewrites every row's position. Fine at twelve rows. The trick people reach for is fractional or gap-based ordering — leave space between positions (10, 20, 30) so inserting between two rows only writes one value, no full rewrite. I know it; I didn't need it; subtask lists are short and the full rewrite is one cheap transaction. But if you're building this for a list that's actually long, don't pack the integers tight. Leave yourself room to slide one in.

If there's a single lesson here it's the one the gate taught me: a drag handle you hide on the client is a courtesy, not a control. The order of a shared queue is a permission, and permissions live on the server or they don't exist. The CSS just keeps honest people from being offered something the server is going to take away.
