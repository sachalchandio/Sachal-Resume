---
title: "Delete order matters: S3 before the database row"
description: "Deleting the DB record first orphaned the S3 objects and the audit trail. A one-line reordering with real consequences."
date: "2026-03-25"
updated: "2026-03-25"
kind: "deepdive"
category: "Backend"
tags: ["s3", "aws", "consistency"]
month: "2026-03"
repo: "backend"
author: "Sachal Chandio"
---

A sales lead opened a ticket that read, in full: "deleted task, file still downloads." That was it. No steps, no screenshot. I almost closed it as user error, because in our UI a deleted task is gone — the row vanishes from the grid and there's nothing left to click. So how do you download an attachment off a task that doesn't exist anymore?

She had the old S3 link sitting in a browser tab from earlier. She clicked it. The PDF downloaded. The task was three days deleted.

## The first wrong guess

My first thought was caching. We put a lot of read paths through Redis, and my instinct was that some stale presigned URL or a cached attachment list was outliving the delete. That would have been an easy, boring fix — bust the cache key on delete and move on.

So I went looking for where attachment URLs get cached. They don't, really. We mint presigned GET URLs on demand in the resolver; they're short-lived and never written to Redis. The link in her tab wasn't a cache artifact. It was a perfectly valid, still-signed URL pointing at an object that was still sitting in the bucket. The signature hadn't even expired yet.

That reframed the whole thing. This wasn't a stale-read problem. The object was genuinely still there. We had deleted the task and left its files behind.

I ran the obvious check against the bucket:

```bash
aws s3 ls s3://telelinkz-attachments/tasks/ --recursive | wc -l
```

Then counted attachment rows in MySQL:

```sql
SELECT COUNT(*) FROM task_attachment;
```

The bucket had a few thousand more objects than the table had rows. Not a rounding error. We had been quietly leaking files for months, and nobody noticed because orphaned S3 objects don't show up anywhere a human looks. They just accrue, and they bill.

## The root cause

Here's the delete path as it was written. Read it in order, because the order is the bug.

```ts
async deleteTask(id: string): Promise<boolean> {
  const task = await this.taskRepo.findOne({
    where: { id },
    relations: ['attachments'],
  });
  if (!task) throw new NotFoundException('Task not found');

  // 1. drop the row first
  await this.taskRepo.delete(id); // cascades to task_attachment

  // 2. then clean up the files
  for (const att of task.attachments) {
    await this.s3.deleteObject({
      Bucket: this.bucket,
      Key: att.s3Key,
    });
  }

  return true;
}
```

When this runs end to end, it's fine. The row goes, the cascade clears `task_attachment`, then we delete each object from S3.

The trouble is step 2 is a network call to AWS, in a loop, and any one of those calls can fail. A timeout. A throttle. An expired credential on a long-running worker. A pod getting recycled mid-request. The moment one `deleteObject` throws, the method bails — and by then the DB row is already gone. The cascade already wiped `task_attachment`, which held the only record of which `s3Key` belonged to that task.

So now the file is in the bucket with no row pointing at it. There is no list of "things I still need to delete." The pointer was in the row, and I deleted the pointer first. Whatever objects came after the failure in that loop are now unreachable from the database. You cannot retry a cleanup you no longer have the keys for.

And it compounded a second problem I cared about more than the storage bill: the audit trail. We log deletes against the attachment record. With the row gone before the file, a partial failure left an S3 object that no audit entry, no soft-delete tombstone, nothing in MySQL would ever mention again. From the database's point of view, that file had never existed. That's the part that actually bothered me — not the orphaned bytes, but that we'd lost the ability to even know they were orphaned.

## The fix

The fix is to swap the two steps. Delete from S3 first, while you still hold the keys. Only after every object is gone do you remove the row.

```ts
async deleteTask(id: string): Promise<boolean> {
  const task = await this.taskRepo.findOne({
    where: { id },
    relations: ['attachments'],
  });
  if (!task) throw new NotFoundException('Task not found');

  // 1. delete the files first — the row still holds the keys,
  //    so a failure here is retryable
  await Promise.all(
    task.attachments.map((att) =>
      this.s3.deleteObject({ Bucket: this.bucket, Key: att.s3Key }),
    ),
  );

  // 2. only now drop the row (cascades to task_attachment)
  await this.taskRepo.delete(id);

  return true;
}
```

If S3 throws now, the method aborts before touching MySQL. The task and its `task_attachment` rows survive intact, keys and all. The user sees the delete "fail," they retry, and the retry re-reads the same keys and finishes the job. Nothing leaks. The audit trail stays coherent because the row that anchors it is the last thing to go, not the first.

`Promise.all` here is a small bonus — the original loop deleted serially, awaiting each call, which on a task with a dozen screenshots was a dozen sequential round trips to AWS. Firing them together cut a noticeably slow delete down to one round trip's worth of latency. But the parallelism isn't the point. The point is which side of the two-system delete fails first.

One sharp edge worth naming: S3's `DeleteObject` is idempotent and returns success even if the key isn't there. That's exactly what you want here. If a retry runs after the first attempt already deleted three of five objects, deleting those three again is a no-op, not an error. The operation converges. If S3 had thrown on a missing key, the retry path would be a minefield, and I'd have had to track which keys were already gone — which is the original problem wearing a different hat.

## The general rule

Any time a delete spans two systems, you're really doing two deletes that can't be made atomic. There's no transaction stretching across MySQL and S3. So the question is only ever: which one do I do first, and what state am I in if the second one never happens?

The rule I landed on, and the thing I'd tell anyone reviewing this kind of code: **in a two-system delete, remove the thing you can re-derive last.** The database row was re-derivable from nothing — once it's gone, the keys are gone, and the orphaned object is unreachable. The S3 object was re-derivable from the row, because the row carried the key. So the row had to outlive the file. You delete outward from the durable record toward the thing the record describes, and you only retire the record once everything it points to is confirmed gone.

It's the mirror image of how you write. On create, you upload to S3 first and only then write the row, so you never have a row promising a file that isn't there. On delete, you run it backwards: kill the file first, then the row, so you never have a file with no row to account for it. The row is the source of truth on both ends. It's the first thing in and the last thing out.

This bites quietly. A failed delete that leaves an orphan throws no error your monitoring will catch — the user's retry usually "fixes" it, the file gets cleaned up on the second pass, and you never learn the first pass half-finished. The only symptom is the object count drifting above the row count, month over month, until someone reads a storage bill or a sales lead clicks a three-day-old link and files a four-word ticket. Reconcile the two counts on a schedule if you can; the drift is the only thing that tells you your delete order is wrong before a human does.
