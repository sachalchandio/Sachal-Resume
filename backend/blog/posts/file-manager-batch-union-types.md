---
title: "Batch file operations and GraphQL union results for clean error handling"
description: "Single-file ops don't scale to a real file manager. Batch mutations, a download queue, and union types for name collisions."
date: "2026-03-21"
updated: "2026-03-21"
kind: "deepdive"
category: "Backend"
tags: ["graphql", "unions", "bull", "files"]
month: "2026-03"
repo: "backend"
author: "Sachal Chandio"
---

The file manager shipped with exactly one shape of mutation: do something to one node. `deleteNode(id)`, `moveNode(id, parentId)`, `renameNode(id, name)`. It worked fine in the demo because in the demo you delete one file. Then a sales manager selected forty call recordings, hit delete, and the Angular client fired forty mutations in a `forkJoin`. The API survived it. The audit log did not — forty rows, no grouping, no way to say "this person bulk-deleted a campaign folder at 2pm." And the UX was worse than the backend: partial failures left half the selection gone and half still there, with a toast that just said "Error."

So I went back and rebuilt the operations around the unit people actually work in, which is a *set* of nodes, not one. Two things came out of that work that are worth writing down: batch mutations that report per-item outcomes, and using GraphQL union return types so a name collision stops being an exception and becomes a value the client can branch on.

## Batch instead of N round trips

The naive fix is "let the client loop faster." Don't. A batch operation isn't N single operations with a shared HTTP connection — it's one operation with one authorization check, one transaction boundary, and one audit entry. That's the whole point.

Here's `deleteNodes`. It takes a list of ids, validates them all up front against the caller's tenant and permissions, then deletes in a single transaction.

```ts
@Mutation(() => BatchResult)
async deleteNodes(
  @Args('ids', { type: () => [ID] }) ids: string[],
  @CurrentUser() user: AuthUser,
): Promise<BatchResult> {
  return this.filesService.deleteNodes(ids, user);
}
```

```ts
async deleteNodes(ids: string[], user: AuthUser): Promise<BatchResult> {
  const nodes = await this.nodeRepo.find({
    where: { id: In(ids), tenantId: user.tenantId },
  });

  // ids the caller asked for that we couldn't see → not found / not theirs
  const foundIds = new Set(nodes.map((n) => n.id));
  const missing = ids.filter((id) => !foundIds.has(id));

  const results = await this.dataSource.transaction(async (tx) => {
    const repo = tx.getRepository(FileNode);
    const out: ItemResult[] = [];
    for (const node of nodes) {
      if (node.locked) {
        out.push({ id: node.id, ok: false, reason: 'LOCKED' });
        continue;
      }
      await repo.softDelete(node.id); // cascade handled by closure table
      out.push({ id: node.id, ok: true });
    }
    return out;
  });

  for (const id of missing) results.push({ id, ok: false, reason: 'NOT_FOUND' });
  await this.audit.record(user, 'FILES_BATCH_DELETE', { ids, results });
  return { results };
}
```

The shape that matters is `BatchResult { results: ItemResult[] }` where each `ItemResult` carries `{ id, ok, reason? }`. I deliberately did **not** make the whole mutation fail if one node is locked. A manager deleting forty files where two are locked wants the thirty-eight gone and a clear note on the two that weren't. All-or-nothing is the right default for money; it's the wrong default for file housekeeping.

`moveNodes` is the same skeleton with one extra guard I learned about the hard way: you cannot move a folder into its own descendant. We store hierarchy in a closure table (`file_node_closure(ancestor_id, descendant_id, depth)`), so the check is a single query, not a recursive walk.

```ts
// would moving `nodeId` under `targetParentId` create a cycle?
const wouldCycle = await tx
  .getRepository(FileNodeClosure)
  .exist({ where: { ancestorId: nodeId, descendantId: targetParentId } });

if (wouldCycle) {
  out.push({ id: nodeId, ok: false, reason: 'CYCLE' });
  continue;
}
```

The first version of move didn't have that check, and a user dragged "2025 Campaigns" into "2025 Campaigns / Q3" and orphaned the whole subtree. The closure rows still pointed everywhere; the `parentId` pointer lied. Took me an afternoon to reconcile it by hand in MySQL. Now the guard runs before any write.

`shareNodes` batches the creation of share grants — one `file_share` row per (node, recipient) pair — and dedupes against existing grants so re-sharing is idempotent. Nothing exotic, but doing it in one mutation means the email notification fires once with "12 files shared with you," not twelve separate emails. Your recipients will thank you.

## The download problem belongs on a queue

Downloading a single file is a redirect to a presigned S3 URL. Done. Downloading a *folder* is a different animal: you have to walk the subtree, pull every object out of S3, zip them with their relative paths intact, and hand back something the browser can fetch. That can be 800MB and forty seconds of work. It does not belong in the request/response cycle, and it definitely doesn't belong holding a Node event-loop hostage while it streams from S3.

So folder download is a Bull job.

```ts
@Mutation(() => DownloadJob)
async requestFolderDownload(
  @Args('folderId', { type: () => ID }) folderId: string,
  @CurrentUser() user: AuthUser,
): Promise<DownloadJob> {
  const job = await this.downloadQueue.add(
    'build-archive',
    { folderId, tenantId: user.tenantId, requestedBy: user.id },
    { attempts: 2, removeOnComplete: true, removeOnFail: false },
  );
  return { jobId: job.id, status: 'QUEUED' };
}
```

The client gets a `jobId` back immediately and polls (`downloadJobStatus(jobId)`) or, where we've wired it up, listens on a GraphQL subscription backed by Redis pub/sub. The processor does the real work:

```ts
@Processor('folder-download')
export class FolderDownloadProcessor {
  @Process('build-archive')
  async build(job: Job<BuildArchiveData>) {
    const { folderId, tenantId } = job.data;

    const nodes = await this.files.listDescendantFiles(folderId, tenantId);
    const manifest: ManifestEntry[] = [];

    const archive = archiver('zip', { zlib: { level: 6 } });
    const upload = this.s3.uploadStream(`exports/${job.id}.zip`);
    archive.pipe(upload.stream);

    let done = 0;
    for (const node of nodes) {
      const body = this.s3.getObjectStream(node.s3Key);
      archive.append(body, { name: node.relativePath });
      manifest.push({ path: node.relativePath, bytes: node.size, sha: node.checksum });
      await job.progress(Math.round((++done / nodes.length) * 100));
    }

    // manifest.json travels inside the zip — what was in here, and when
    archive.append(JSON.stringify({ exportedAt: new Date(), entries: manifest }, null, 2), {
      name: 'manifest.json',
    });

    await archive.finalize();
    const { Location } = await upload.done;
    return { url: await this.s3.presign(Location, '15m'), entryCount: manifest.length };
  }
}
```

Two decisions in there earned their keep. First, I stream both directions — read each object as a stream from S3, append it to the archiver, and pipe the archiver straight into an S3 multipart upload. The zip never lands on local disk. Early on I buffered each file into memory before appending and a 600MB folder took the pod's memory with it; the OOM killer is not a subtle teacher.

Second, the **manifest**. I append a `manifest.json` to the archive listing every entry with its path, byte size, and checksum. This sounds like over-engineering until support gets a ticket that says "my export is missing files." With the manifest, you open the zip, read the JSON, and you know exactly what the export claimed to contain versus what's there. It also gives you the checksum to prove a file wasn't truncated. Costs nothing to write, saves a long afternoon later.

The S3 key is `exports/{jobId}.zip` and the presigned URL lives 15 minutes. A nightly cleanup job prunes the `exports/` prefix because nobody comes back for yesterday's download.

## Name collisions: an error that isn't an error

Now the part I actually changed my mind about. Creating a folder can collide — there's already a "Contracts" in this parent. The first version threw:

```ts
if (existing) throw new ConflictException('A folder with that name already exists');
```

In REST that's a clean 409. In GraphQL it's a thrown error that lands in the top-level `errors` array, detached from the field, with `data: null` for that mutation. The Angular client has to string-match the message or dig through `extensions.code` to tell "name taken" apart from "you're not allowed" apart from "the database fell over." Three very different situations, one ugly funnel. And a name collision isn't really an error — it's a perfectly ordinary, expected outcome the UI wants to handle by suggesting "Contracts (2)" or focusing the rename box. Modeling an expected outcome as an exception is a category mistake.

GraphQL unions fix this. The mutation returns *either* the created folder *or* a typed collision result, and both are first-class members of the schema:

```ts
@ObjectType()
export class NameCollisionError {
  @Field() message: string;
  @Field() conflictingName: string;
  @Field() suggestedName: string; // "Contracts (2)"
}

export const CreateFolderResult = createUnionType({
  name: 'CreateFolderResult',
  types: () => [FolderItem, NameCollisionError] as const,
  resolveType: (value) =>
    'conflictingName' in value ? NameCollisionError : FolderItem,
});
```

`resolveType` is the part people get wrong. GraphQL has to know, at runtime, which concrete type a returned value is so it can match the right inline fragment. With `code-first` `@nestjs/graphql` there's no class discrimination for free — I key off a property that only exists on the error (`conflictingName`). If you forget `resolveType`, you get the gloriously unhelpful *"Abstract type CreateFolderResult must resolve to an Object type at runtime"* and a confused half hour.

The resolver stops throwing and starts returning:

```ts
@Mutation(() => CreateFolderResult)
async createFolder(
  @Args('input') input: CreateFolderInput,
  @CurrentUser() user: AuthUser,
): Promise<typeof CreateFolderResult> {
  const clash = await this.files.findChildByName(input.parentId, input.name, user.tenantId);
  if (clash) {
    return Object.assign(new NameCollisionError(), {
      message: `"${input.name}" already exists here`,
      conflictingName: input.name,
      suggestedName: await this.files.nextAvailableName(input.parentId, input.name),
    });
  }
  return this.files.createFolder(input, user);
}
```

The client query asks for both shapes and branches on `__typename`:

```ts
mutation CreateFolder($input: CreateFolderInput!) {
  createFolder(input: $input) {
    __typename
    ... on FolderItem { id name createdAt }
    ... on NameCollisionError { message suggestedName }
  }
}
```

Now the Angular side is a `switch (res.__typename)` with no string matching and no error boundary. The collision path renders an inline suggestion; the success path drops the new folder into the tree. The `errors` array goes back to meaning what it should mean: something genuinely broke.

## Where the line actually is

The trap with unions is using them for everything. I don't return a union for "folder not found" or "tenant mismatch" — those are real faults, the client can't do anything smart with them, and they belong in the `errors` channel where logging and alerting already watch. The rule I settled on: **if the client has a sensible, specific UI branch for an outcome, model it as a union member; otherwise throw.** A name collision has a UI (suggest a name). A null tenant does not (show the generic error toast and move on). Unions are for expected forks in the happy path, not a replacement for exceptions.

What I'd do differently: I'd make union results the default for the mutations that mutate user-named things from day one, instead of retrofitting `createFolder`, `renameNode`, and `moveNodes` one at a time after each one bit someone. And I'd standardize the batch `ItemResult.reason` as an enum across every batch mutation from the start — I have `'LOCKED' | 'CYCLE' | 'NOT_FOUND'` now, but `deleteNodes` and `moveNodes` grew their reason strings independently and I had to go back and reconcile them so the client could share one renderer.

The batch-and-union pattern isn't specific to files. Anywhere you've got a list operation with per-item outcomes, or an expected-but-not-happy result the UI should handle deliberately, the same two moves apply. It bites you when you skip them and pretend every operation is a single success or a single throw, because real users select forty things at once and name two folders the same — and they do it the day after you ship.
