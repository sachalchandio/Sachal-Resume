---
title: "Instrumenting a subsystem: average ms, average bytes, and access records"
description: "You can't tune what you don't measure. Adding lightweight instrumentation to the file manager."
date: "2025-04-23"
updated: "2025-04-23"
kind: "deepdive"
category: "DevOps"
tags: ["observability", "metrics", "nestjs"]
month: "2025-04"
repo: "backend"
author: "Sachal Chandio"
---

Someone on the sales team complained that downloading a call recording "felt slow sometimes." That was the entire bug report. No timestamp, no file, no repro. And I had nothing to push back with, because the file manager in Telelinkz was a black box. It uploaded to S3, it streamed back out, it cached presigned URLs in Redis, and at no point did it record how long any of that took or how much data moved through it.

I couldn't tune what I couldn't see. So before touching a single thing for performance, I went and made the subsystem talk.

## The temptation to measure everything

My first instinct was the bad one. I started sketching a list of everything I could instrument: time to generate the presigned URL, Redis hit/miss ratio, S3 round-trip latency, bytes per file type, p50/p95/p99 per endpoint, error rates by S3 status code, queue depth on the thumbnail jobs. A beautiful dashboard in my head with twelve panels.

Then I asked the only question that matters: which of these numbers would actually change a decision I make?

Most of them wouldn't. p99 latency is great when you have the traffic to make a tail meaningful — we did not. A telecom CRM with a few hundred agents uploading documents and pulling recordings is not generating the volume where the 99th percentile is anything but noise on one unlucky request. Building a full percentile histogram for that is instrumenting for a scale I didn't have, and every metric you collect is a thing you now have to store, read, and not be misled by.

I settled on three numbers, and I'm still happy with that choice:

- **average access time in milliseconds** — is the subsystem getting slower over time?
- **average bytes transferred** — are people moving big files, small files, and is that shifting?
- **an access count, per file** — which files are actually hot?

Two rolling averages and a counter. That's it. The discipline wasn't in what I added; it was in what I refused to add.

## Modelling the access record

The averages need to be derived from something, and I didn't want to recompute them by scanning a log table every time someone hit the metrics endpoint. I also wanted a raw trail — if a specific file looked pathological, I wanted to drill into individual accesses, not just the aggregate.

So there are two pieces. A `FileAccessRecord` row written on every access, and rolling aggregate columns kept on the file entity itself so the common read is O(1).

```ts
@Entity('file_access_records')
export class FileAccessRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => ManagedFile, (file) => file.accessRecords, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'fileId' })
  file: ManagedFile;

  @Column()
  fileId: string;

  // 'download' | 'upload' | 'presign'
  @Column({ type: 'varchar', length: 16 })
  operation: string;

  @Column({ type: 'int', unsigned: true })
  durationMs: number;

  @Column({ type: 'bigint', unsigned: true })
  bytesTransferred: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  actorId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
```

`bytesTransferred` is a `bigint`. That decision cost me twenty minutes later, which I'll get to. The rolling fields live on `ManagedFile`:

```ts
@Column({ type: 'int', unsigned: true, default: 0 })
accessCount: number;

@Column({ type: 'float', default: 0 })
avgAccessTimeMs: number;

@Column({ type: 'float', default: 0 })
avgBytesTransferred: number;
```

I deliberately did not denormalise a `lastAccessedAt` or store min/max. If I needed those, I had the raw records. The entity columns are only the things I want cheap on every read.

## Updating a rolling average without a race

The naive way to keep an average is to load the row, compute the new average in JavaScript, and save it back. Read-modify-write. Under two concurrent downloads of the same file that's a lost update — both read `accessCount = 10`, both write `11`, and you've undercounted.

The trick is the [incremental average](https://en.wikipedia.org/wiki/Moving_average) formula, which lets you update the mean knowing only the old mean, the old count, and the new sample:

```
newAvg = oldAvg + (sample - oldAvg) / newCount
```

And the part that actually fixes the race: do the whole thing in one SQL `UPDATE` so MySQL computes it atomically against the current row, not a stale value I read seconds ago.

```ts
async recordAccess(
  fileId: string,
  durationMs: number,
  bytes: number,
): Promise<void> {
  await this.dataSource.query(
    `UPDATE managed_files
       SET avgAccessTimeMs =
             avgAccessTimeMs + (? - avgAccessTimeMs) / (accessCount + 1),
           avgBytesTransferred =
             avgBytesTransferred + (? - avgBytesTransferred) / (accessCount + 1),
           accessCount = accessCount + 1
     WHERE id = ?`,
    [durationMs, bytes, fileId],
  );
}
```

`accessCount + 1` is evaluated by MySQL against the live row. Two concurrent accesses serialise on the row lock and both land. No application-level read-modify-write, no lost updates. The raw `FileAccessRecord` insert happens separately, and I don't care if those two writes are in the same transaction — the aggregate is the source of truth for the dashboard, the records are the audit trail.

## Capturing the numbers without smearing them everywhere

The measurement itself had to wrap the actual S3 work, and I did not want to sprinkle `Date.now()` calls through five different service methods. A small helper that times a function and reports the result kept the call sites clean:

```ts
private async timed<T>(
  fileId: string,
  operation: string,
  work: () => Promise<{ result: T; bytes: number }>,
): Promise<T> {
  const start = performance.now();
  const { result, bytes } = await work();
  const durationMs = Math.round(performance.now() - start);

  // fire-and-forget; instrumentation must never break the download
  this.metrics
    .recordAccess(fileId, operation, durationMs, bytes)
    .catch((err) => this.logger.warn(`metric write failed: ${err.message}`));

  return result;
}
```

Two things in there are load-bearing. `performance.now()` over `Date.now()` because I wanted a monotonic clock that doesn't jump if NTP nudges the system time mid-request. And the `.catch()` that swallows metric failures — the day the metrics table is locked or the disk is full, a customer's call recording still downloads. Observability is not allowed to take down the thing it observes. I learned that one the embarrassing way on a different project.

A download call site then reads cleanly:

```ts
return this.timed(fileId, 'download', async () => {
  const object = await this.s3.getObject(key);
  return {
    result: object.stream,
    bytes: object.contentLength ?? 0,
  };
});
```

## The sharp edges

**bigint comes back as a string.** The MySQL driver returns `BIGINT` columns as JavaScript strings, because a 64-bit integer doesn't fit safely in a JS `number`. So `avgBytesTransferred` in my first GraphQL response came out as `"1048576"` with quotes, and the frontend chart silently plotted nothing because it was trying to do math on a string. For the averages I stored as `float`, which sidesteps it. For the raw `bytesTransferred` on the record, I added an explicit transformer so the API contract stayed numeric, and accepted that files over 9 petabytes would be a problem for future me.

**S3 doesn't always tell you the size.** When streaming a download, `ContentLength` is on the response, but on a few code paths — particularly the cached presigned-URL flow where the client fetches directly from S3 — the bytes never pass through my server at all. I can't measure what doesn't touch me. So `bytesTransferred` is zero on presign operations, and `avgBytesTransferred` is honestly the *server-mediated* average, not the true transfer average. I documented that in a comment rather than pretend the number meant more than it did. A metric you misunderstand is worse than no metric.

**rolling averages have no memory and no forgetting.** A cumulative mean over all time means one giant 2GB export three months ago still drags `avgBytesTransferred` upward forever, and a recent slowdown gets diluted by thousands of fast historical accesses. The average tells you the lifetime story, not the current weather. For "is it slow *right now*" I lean on the raw `FileAccessRecord` rows filtered to the last hour. The cumulative average was the right cheap default; it just isn't a trend detector, and I almost fooled myself into reading it as one.

## What I'd do differently

The aggregate columns were the right call for a read-cheap dashboard, and I'd keep them. But the cumulative average is the part I'd change. If I rebuilt this I'd use an [exponentially weighted moving average](https://en.wikipedia.org/wiki/EWMA_chart) on `avgAccessTimeMs` so recent accesses count more than ancient ones — same one-row atomic update, but with a decay factor it actually answers the "slower lately?" question the cumulative mean can't. One constant, `alpha`, and the SQL barely changes.

The other thing: I'd put a TTL or a rollup on `file_access_records` from day one. It grows forever, one row per access, and on a busy file that's a lot of rows whose only long-term value is aggregate. A nightly Bull job that rolls yesterday's records into a per-file daily summary and deletes the originals would keep the table from becoming the next black box I have to go instrument.

That "felt slow sometimes" ticket, by the way? Once I could see the numbers, the average access time for recordings was 40ms. The slowness was the Angular audio player buffering, not the backend at all. Which is its own lesson: the first thing good instrumentation does isn't make your code faster. It tells you when the problem was never where you were looking.
