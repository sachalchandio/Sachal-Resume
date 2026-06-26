---
title: "Detecting stalled Bull workers stuck in ACTIVE forever"
description: "Jobs that wedge in ACTIVE quietly rot a queue. Surfacing them and reaping the dead ones."
date: "2025-09-03"
updated: "2025-09-03"
kind: "deepdive"
category: "DevOps"
tags: ["bull", "queues", "observability"]
month: "2025-09"
repo: "backend"
author: "Sachal Chandio"
---

A salary report didn't show up. An agent generated payroll for the month, the UI said "queued," and then nothing. No error, no completed file, no failed job. It just sat there. When I opened Bull Board at `/admin/queues` and clicked into `salaryQueue`, there it was: one job in **Active**, started forty minutes ago, on a job that normally finishes in under ten seconds.

That's the failure mode nobody warns you about. A failed job is loud — it lands in the Failed tab, it has a stack trace, the retry logic kicks in. A job stuck in ACTIVE is worse because it looks like work. The dashboard shows green. The queue shows "1 processing." Everything is fine, except the process that was processing it died sometime in the last half hour and nothing moved the job anywhere.

## Why ACTIVE jobs get orphaned

Bull's lifecycle is `waiting → active → completed | failed`. When a worker picks a job up it gets moved to the active list and a lock is set in Redis. The worker is supposed to renew that lock on a heartbeat and, when it finishes, move the job out of active. Bull has a stalled-check for exactly the case where a worker dies mid-job: if the lock expires and the job is still active, the stalled checker is meant to push it back to waiting so another worker retries it.

That's the theory. In practice the stalled detection only works if a worker is alive to run the check, the `stalledInterval` hasn't been turned off, and the job hasn't already burned through `maxStalledCount`. We deploy on a single backend instance behind PM2, and during a deploy the old process gets killed while it might be holding a job. If the new process boots and the timing lines up wrong — or if the job was one that genuinely hung on an external call, an S3 upload that never returned, a MySQL query waiting on a lock — the job can sit in active past every retry and just stop being anyone's problem.

Our queues are not exotic. There are seven of them: `imageUploadQueue`, `reportQueue`, `searchIndexQueue`, `salaryQueue`, `pauseTrackingQueue`, `chat-file-upload`, and `saleStatusAnalyticsQueue`. A few of them do real I/O — uploads to S3, heavy report aggregation over a month of sales. Those are exactly the ones that can wedge. And until this happened, my only window into them was clicking through Bull Board tab by tab, queue by queue, which is fine for a forensic dig and useless for "is anything wrong right now."

I needed two things. A way to *list* the jobs that haven't finished, so I can see what's actually outstanding. And a sweep that *reaps* the ones that have clearly been abandoned, so a dead job doesn't masquerade as live work forever.

## Listing what hasn't finished

The first piece is a read. Bull gives you per-state getters — `getActive()`, `getWaiting()`, `getDelayed()` — each returning the job array for that state. "Incomplete" for my purposes means any of those three: actively being worked, waiting for a worker, or scheduled for later. Completed and failed are terminal; I don't care about them here.

```ts
import { InjectQueue } from '@nestjs/bull';
import { Queue, Job } from 'bull';

type IncompleteJob = {
  id: string | number;
  name: string;
  state: 'active' | 'waiting' | 'delayed';
  attemptsMade: number;
  // ms the job has spent in ACTIVE; null for waiting/delayed
  activeForMs: number | null;
  data: unknown;
};

@Injectable()
export class QueueHealthService {
  constructor(
    @InjectQueue('salaryQueue') private readonly salaryQueue: Queue,
    @InjectQueue('reportQueue') private readonly reportQueue: Queue,
    // ...the other five
  ) {}

  async getIncompleteJobs(queue: Queue): Promise<IncompleteJob[]> {
    const [active, waiting, delayed] = await Promise.all([
      queue.getActive(),
      queue.getWaiting(),
      queue.getDelayed(),
    ]);

    const now = Date.now();

    const map = (jobs: Job[], state: IncompleteJob['state']) =>
      jobs.map((job) => ({
        id: job.id,
        name: job.name,
        state,
        attemptsMade: job.attemptsMade,
        activeForMs:
          state === 'active' && job.processedOn ? now - job.processedOn : null,
        data: job.data,
      }));

    return [
      ...map(active, 'active'),
      ...map(waiting, 'waiting'),
      ...map(delayed, 'delayed'),
    ];
  }
}
```

The detail that matters is `activeForMs`. Bull stamps `job.processedOn` when a worker pulls the job into active. Subtract that from now and you get how long the job has been holding the active slot. A healthy salary job shows up here for a few seconds and disappears. A stuck one shows `activeForMs` ticking past two million milliseconds and never leaving. That single number is the whole signal — a job's age in ACTIVE is the difference between "busy" and "dead."

One gotcha I hit immediately: `getActive()` without arguments only returns the first page. The signature is `getActive(start, end)` and it defaults to a window, not the whole list. For our volumes the default was fine, but if you ever have hundreds of jobs in flight you'll silently miss the ones past the page boundary and conclude the queue is healthier than it is. I pass explicit bounds now where it matters.

## Reaping the dead ones

Listing tells me something's wrong. It doesn't fix it. A job stuck in ACTIVE will stay there because, by definition, the thing that was supposed to advance it is gone. So I added a scheduled sweep: anything that's been ACTIVE longer than thirty minutes gets moved to **failed** with a reason of `STALLED`.

Thirty minutes is a deliberately blunt number. The slowest legitimate job we run is a full-month salary report, and even that finishes inside a couple of minutes. Thirty gives an order of magnitude of headroom so I never reap a job that's merely slow. If you have a job that genuinely runs for half an hour, this threshold is wrong for you and you'd want it per-queue — more on that below.

```ts
const STALL_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

@Cron(CronExpression.EVERY_10_MINUTES)
async sweepStalledJobs(): Promise<void> {
  const now = Date.now();

  for (const queue of this.allQueues) {
    const active = await queue.getActive();

    for (const job of active) {
      if (!job.processedOn) continue;
      const activeForMs = now - job.processedOn;
      if (activeForMs < STALL_THRESHOLD_MS) continue;

      this.logger.warn(
        `Reaping stalled job ${job.id} on ${queue.name} ` +
          `(${job.name}), active for ${Math.round(activeForMs / 60000)}m`,
      );

      // moveToFailed needs the job's lock token; ignoreLock forces it.
      await job.moveToFailed({ message: 'STALLED' }, true);
    }
  }
}
```

That `true` second argument to `moveToFailed` is the part I got wrong the first time. Normally `moveToFailed(reason, ignoreLock)` expects the worker to hold the job's lock — it's how Bull stops two workers from both finishing the same job. But a stalled job's worker is *dead*; there is no lock holder. Without `ignoreLock: true` the call throws `Missing lock for job` and the sweep does nothing, which is a special kind of useless: a reaper that can't reap. Forcing past the lock is correct precisely because the absence of a live lock holder is what defines the job as stalled in the first place.

Moving it to failed — rather than back to waiting — was a choice. Bull's own stalled recovery retries by pushing the job back to waiting. I deliberately don't, because by the time my sweep fires, the job has already had its automatic retries and its stalled-checks and still ended up here. Re-queueing a job that's been hung for thirty minutes is a good way to hang the next worker on the same poisoned input. `STALLED` in the Failed tab is a tombstone: it tells whoever's looking that this job didn't fail on its own merits, it was abandoned and I declared it dead. If the work still needs doing, a human re-triggers it knowing what they're re-triggering.

## Surfacing the counts

The third piece is the cheap one and the one I use most. Bull has `getJobCounts()`, which returns the tally per state in a single Redis round-trip. I wrapped it per queue and exposed it through GraphQL so a dashboard can show backlog at a glance without anyone opening Bull Board.

```ts
async getQueueHealth() {
  return Promise.all(
    this.allQueues.map(async (queue) => {
      const counts = await queue.getJobCounts();
      // counts: { waiting, active, completed, failed, delayed, paused }
      return {
        name: queue.name,
        waiting: counts.waiting,
        active: counts.active,
        failed: counts.failed,
        delayed: counts.delayed,
      };
    }),
  );
}
```

On the frontend this is one ECharts bar per queue, polled every thirty seconds. The thing I actually watch is `waiting` climbing while `active` stays flat — that's backlog forming faster than the workers drain it, which usually means a worker died and nobody's processing. A spike in `failed` right after a deploy is my `STALLED` sweep doing its job. The whole point is that the unhealthy state now has a shape on a screen instead of being something I find out about when an agent messages me about a missing report.

## The sharp edges

A few things bit me that the happy-path version doesn't show.

`getJobCounts()` and the per-state getters read Redis live, so on a queue with a large completed history they're not free. We keep `removeOnComplete` set on the heavier jobs so the completed list doesn't grow without bound — otherwise the counts call slows down and, worse, Redis memory creeps up for data nobody reads. If your queues don't trim, fix that before you add a polling dashboard on top of them.

The thirty-minute global threshold is the honest weak point. It's right for our seven queues because none of them legitimately run that long, but it's a property of *our* workload, not a universal truth. The correct design is a per-queue threshold — `imageUploadQueue` could be two minutes, a hypothetical long export could be an hour — and I punted on it because a single constant solved the actual fire. If I add a genuinely long-running job tomorrow, this sweep will start reaping live work, and the fix is to make the threshold a property of the queue rather than a global. I know exactly where that landmine is; I just haven't stepped on it yet.

There's also a multi-instance assumption baked in. The sweep is safe on our single PM2 process because only one thing runs it. The day we scale to two backend instances, two cron sweeps will race to reap the same job, and while `moveToFailed` on an already-failed job is mostly harmless, the double-log noise and the potential for both reaping a job that one of them is *legitimately* still working is real. Before that day, the sweep needs a distributed lock — a Redis `SET NX` guard so exactly one instance runs the reap. I noted it in a comment and moved on, which is the kind of debt you take on knowingly and write down so future-you doesn't discover it the hard way.

## What I'd do differently

I built this reactively, starting from one stuck salary report, and it shows. If I were laying it out fresh I'd make the stall threshold a per-queue config from the start, because I already know the global constant is a temporary truth. I'd add the distributed lock immediately rather than leaving it as a comment, since "we'll never run two instances" is exactly the assumption that gets quietly violated six months later by someone scaling for an unrelated reason.

The deeper lesson is about what "monitoring a queue" even means. I had Bull Board the whole time and still didn't notice a wedged job, because a dashboard you have to remember to open is not monitoring — it's archaeology. The active count looked normal at a glance; the rot was in *how long* one job had been active, and nothing surfaced duration until I made it. The useful signal wasn't the state of the queue. It was the age of the oldest job in ACTIVE. If you take one thing from this: don't alert on whether jobs are processing, alert on how long the oldest one has been processing. A queue that's been "busy" with the same job for thirty minutes isn't busy. It's broken, and it's lying to you about it.
