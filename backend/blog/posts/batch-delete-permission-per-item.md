---
title: "Bulk delete that checks permission per item"
description: "A single authorization check on a bulk op is a bug waiting to happen. Per-item checks with a partial-success result."
date: "2026-05-02"
updated: "2026-05-02"
kind: "deepdive"
category: "Security"
tags: ["authz", "batch", "graphql"]
month: "2026-05"
repo: "backend"
author: "Sachal Chandio"
---

A team lead messaged me a screenshot. One of his agents had selected a handful of files in the file manager, hit delete, and a folder belonging to a *different* agent vanished along with the rest. Not the lead's folder — somebody else's, on the other side of the org. The agent swore he only selected his own. The lead, who could see across the team, swore he saw the count drop on a file that was never the agent's to touch.

My first guess was the frontend. Multi-select grids drag in stray rows all the time — a shift-click that grabbed one row too many, a stale selection that survived a filter change. So I went looking at the Angular side, expecting to find the selection set carrying an id it shouldn't. It wasn't there. The selection was exactly the four ids the agent intended. The mutation fired with four ids. Four files got deleted. The problem was that one of those four wasn't his, and the backend deleted it anyway.

That moved the blame squarely onto the server, which is where it belonged.

## Where the check actually was

The bulk delete went through `deleteNodes(ids: [ID!])`. The first version — the one I'd written, so I get to be honest about it — checked permission *once*, up front, and then deleted the lot. The shape was something like this:

```ts
async deleteNodes(currentUser: User, ids: string[]): Promise<BatchOperationResult> {
  // pull the caller's accessible root once
  await this.assertCanWriteInScope(currentUser);

  // ...then just delete everything in the list
  await this.fileItemRepo.delete({ id: In(ids) });

  return { items: [], successCount: ids.length, failCount: 0 };
}
```

`assertCanWriteInScope` answered a coarse question: does this user have write access to the area they're operating in? For an agent operating in the shared team space, the answer is yes. They can create files there, delete *their own* files there. The gate opened. And then the `delete({ id: In(ids) })` ran against the whole list with no further questions asked.

That's the bug, in one sentence: the authorization check verified the *actor*, not the *objects*. It confirmed "this user is allowed to delete things here" and then treated that as license to delete *these specific things*, which is a different claim entirely. Owning one file in a folder doesn't grant you the other forty. But the single up-front check couldn't tell the difference, because by the time the `In(ids)` query ran, the ids were just a flat list — no ownership attached, no per-row gate left to fail.

The single-file delete never had this hole. `deleteNode(id)` loaded the row, ran `getByIdOrThrow`, and then checked ownership against `item.ownerId`:

```ts
if (!this.isAdmin(currentUser) && item.ownerId !== currentUser.id) {
  throw new ForbiddenException('You can only delete your own files');
}
```

So the single path was safe and the bulk path was wide open, and they'd drifted apart precisely because bulk "felt like" an optimization — one check, one query, fast. The optimization was the vulnerability. A user with one legitimately-owned file in a selection could append any other id to the list and the server would delete it, because the only thing standing between the request and the row was a scope check that had already passed.

This is the classic shape of an IDOR — insecure direct object reference — except it hides better in a batch endpoint, because the endpoint *looks* like it's doing the right thing for the common case. Select your own files, delete your own files, works every time. The hole only opens when the list is heterogeneous, and nobody tests the heterogeneous case until somebody hits it in production.

## Moving the check inside the loop

The fix is structural, not a patch. The permission decision has to happen once per object, not once per request. That means iterating, and it means accepting that a bulk operation can *partially* succeed — some ids go through, some get rejected, and the client needs to know exactly which.

I already had the right result shape sitting in the file-manager models, used by other batch mutations:

```ts
@ObjectType()
export class BatchOperationResult {
  @Field(() => [FileItem])
  items!: FileItem[];

  @Field(() => Int)
  successCount!: number;

  @Field(() => Int)
  failCount!: number;

  @Field(() => [ID], { nullable: true })
  failedIds?: string[];

  @Field(() => [String], { nullable: true })
  errors?: string[];
}
```

`items` is what actually went through, `failedIds` is what didn't, and `errors` carries a per-id message so the UI can say *why*. The whole point of returning all four is that the client never has to guess. It can re-render the grid with the deleted rows gone, leave the rejected rows in place, and pop a toast that names them.

Then I pulled the loop into one small helper that every batch mutation runs through. It takes a per-item handler and is the only place that decides what "partial success" looks like:

```ts
private async executeBatchOperation(
  ids: string[],
  handler: (id: string) => Promise<FileItem>,
): Promise<BatchOperationResult> {
  const items: FileItem[] = [];
  const failedIds: string[] = [];
  const errors: string[] = [];

  for (const id of ids) {
    try {
      const item = await handler(id);   // handler does its own authz, per id
      items.push(item);
    } catch (error) {
      failedIds.push(id);
      const message = error instanceof Error ? error.message : 'Operation failed';
      errors.push(`${id}: ${message}`);
    }
  }

  return {
    items,
    successCount: items.length,
    failCount: failedIds.length,
    failedIds,
    errors,
  };
}
```

And `deleteNodes` becomes the handler that loads each row and checks *that row's* ownership before deleting it:

```ts
async deleteNodes(currentUser: User, ids: string[]): Promise<BatchOperationResult> {
  return this.executeBatchOperation(ids, async (id) => {
    const item = await this.getByIdOrThrow(id);

    // the exact check the single-file path already had — now per id
    if (!this.isAdmin(currentUser) && item.ownerId !== currentUser.id) {
      throw new ForbiddenException('You can only delete your own files');
    }

    await this.softDelete(currentUser, id);
    return item;
  });
}
```

The shift is small in lines and large in meaning. The authorization now lives next to the load, runs against the actual row, and reuses the *same* ownership rule the single-file delete uses. The bulk and single paths can no longer drift, because the bulk path is now the single path in a loop. A `ForbiddenException` on someone else's file no longer aborts the whole operation — it lands the id in `failedIds` with a message, the loop continues, and the user's own files still get deleted.

## What the client does with it

The Angular side stopped treating delete as all-or-nothing. It reads `failedIds`, leaves those rows in the grid, and surfaces `errors`:

```ts
const res = result.data.deleteNodes;
this.removeFromGrid(res.items.map((i) => i.id));   // these are gone
if (res.failCount > 0) {
  this.toast.warn(`${res.failCount} item(s) couldn't be deleted`, res.errors);
}
```

Before, a partial failure either deleted too much (the bug) or, if I'd naively thrown on the first rejection, deleted nothing and showed a bare "Error." Neither is what the user wants. The user wants their three files gone and a clear note that the fourth wasn't theirs to delete.

## The transaction tradeoff I argued myself out of

There's a real tension here I want to be straight about. The loop deletes one at a time and commits as it goes, so a batch of forty that fails on item thirty leaves twenty-nine deleted. For *file deletes* that's fine — they're independent, soft-deleted, and recoverable from trash. There's no invariant that says "these forty must all die together or none."

I almost wrapped the loop in a transaction anyway, out of reflex. But all-or-nothing is the wrong default for housekeeping. If two files in a forty-file selection are locked or not yours, rolling back the other thirty-eight punishes the user for the server's pickiness. All-or-nothing is the right default when the items form a unit — moving money, a multi-step state change where a half-applied result is corrupt. It's the wrong default for "delete the things I selected." So the per-item commit stays, and the result object is how the client learns what didn't make it. If I were doing something with a real cross-item invariant I'd flip that — transaction around the loop, and the whole batch fails as one. The shape of the result wouldn't change; only where the boundary sits.

## The lesson, and when it bites

A single authorization check in front of a bulk operation is almost always a bug, and it's an easy one to write because the happy path hides it perfectly. The check that asks "can this user operate here?" is not the check that asks "can this user touch *this object*?" The first is about the actor and their scope. The second is about each object and its owner. Bulk endpoints love to collapse the two, because checking once is faster and the demo only ever deletes your own stuff.

It bites the moment a list is heterogeneous — mixed owners, mixed permissions, mixed states — and somebody, by accident or on purpose, puts an id in the list that the coarse check would have caught individually but the batch check waved through. The rule I hold to now: **authorization is a property of (actor, object), so it belongs wherever you touch the object — which in a batch means inside the loop, every iteration, no exceptions for the ones that look like yours.** And once the check is per-item, you've signed up for partial success, so give the client a result that names exactly what went through and what didn't. Anything less and the user is back to guessing why the count was wrong — which is how I found out about this one in the first place.
