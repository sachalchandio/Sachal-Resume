---
title: "When to push work onto a queue (and when not to)"
description: "Inline vs queued, idempotency, retries and backoff, observability, and the stalled-job problem."
date: "2025-05-18"
updated: "2025-05-18"
kind: "deepdive"
category: "Architecture"
tags: ["bull", "queues", "async"]
month: "2025-05"
repo: "backend"
author: "Sachal Chandio"
---

A queue is a promise you make to a user that you'll do something later, and an obligation to keep that promise when the process holding the work dies mid-flight. The first half is easy — `queue.add(...)`, a 200, a happy user. The second half is where the bodies are buried, and on Telelinkz I've buried a few.

Queues earned their place on Telelinkz — bulk imports, search indexing, salary generation all run off the request path now and the app is better for it. But "put it on a queue" is not free architecture. It's a trade: you swap a slow synchronous call for a fast one plus a distributed system you now have to operate. Sometimes that trade is obviously right. Sometimes you're adding Redis, a worker, a dead-letter problem, and a dashboard you'll forget to look at, to save 300ms on a request that was fine.

## The actual rule for moving work off the request path

Push work onto a queue when the user doesn't need the result in the response, and the work is either slow, bursty, or allowed to fail and retry. That's it. All three are about decoupling the user's wait from the work's duration.

The clearest case is salary generation. An admin clicks "generate payroll for May," and behind that one click is a month of sales for every agent, commission math against `package_version` rows, PSU rollups, the whole thing. No universe holds the HTTP connection open while that grinds. So it goes on `salaryQueue`, the request returns immediately with "queued," and the finished report shows up when it's done.

Search indexing is the same shape for a different reason. When a sale is saved, a `search_index` row has to be written so the sale is findable. The user creating the sale doesn't care about that row — they care that the sale saved. So indexing goes on a queue and the create path doesn't wait:

```ts
const savedSale = await this.astoundSaleRepository.save(sale);

await this.eventsQueue.add(
  'index-sale',
  { saleId: savedSale.id, saleData: savedSale, saleType: this.saleType },
  { priority: 5, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
);
```

The tell that this belongs on a queue: indexing failure must never roll back the sale. The two have different owners — the save is the user's, the index is the system's bookkeeping. When two side effects have different consequences for failure, that seam is exactly where the queue boundary wants to go.

## When *not* to queue

Here's the part nobody puts on the slide. Most work should stay inline.

If the user needs the answer to render the next screen, queuing it just moves the wait somewhere worse — now they're polling, or you've built a WebSocket channel to push a result a synchronous call would have just returned. A queue doesn't make a read faster. It makes the read happen on a different box, later, after Redis round-trips, and you still have to get the answer back to a user staring at a spinner the whole time.

Don't queue when the work is fast and the failure matters to the request. A sale's status transition — `PENDING` to `INSTALLED` — has to be transactional with the sale. If I queued that, the response would say "done" while the change still sat in `waiting`, and a user could refresh and see the old status. Lying about durability to save a few milliseconds is a bad trade every time.

And don't queue to dodge a problem you should fix inline. If a request is slow because of an N+1 or a missing index, the queue just relocates the slowness — the job still takes four seconds, you've made four seconds someone else's problem and added operational surface on top. Fix the query. The queue is for work that's *legitimately* slow or allowed to lag, not work you haven't optimized.

My heuristic: queue it if the user can walk away and the result will find them later. Keep it inline if they're waiting on the screen. Bulk import of twelve thousand AT&T rows — queue. Reading one customer to render their detail page — inline, and if it's slow, that's a query problem in a latency costume.

## Every job must be idempotent — this is non-negotiable

The single thing that took me longest to internalize: the moment you put work on a queue, you've signed up for it running more than once. Not might. Will. A worker dies after doing the work but before acknowledging it and Bull retries it; a deploy restarts the process mid-job; a network blip makes a job look failed when it succeeded. At-least-once delivery is the default, and exactly-once is a fairy tale you tell junior engineers.

So the question for every processor is: what happens if this runs twice? If the answer is "duplicate row" or "double commission," the job is broken — and in a way that won't show up until production load makes retries common.

Indexing is naturally idempotent: writing the same `search_index` row twice is a no-op against a unique key. I didn't have to do anything clever there. Salary generation was not, and that one I had to make safe. The naive version inserted a salary record per agent per run. Run it twice for May — which people do, because the first run surfaces a data problem they then fix — and you get two May salaries for everyone. The fix wasn't subtle: a unique constraint on `(agentId, period)` and an upsert instead of an insert, so a re-run overwrites rather than duplicates.

```ts
// idempotent by construction: same (agentId, period) overwrites, never doubles
await this.salaryRepository.upsert(
  { agentId, period, grossAmount, commission, psu },
  ['agentId', 'period'],
);
```

The discipline I hold now: a job isn't done until I can answer "what if this runs three times" with "nothing bad." Idempotency isn't a nice-to-have you bolt on after an incident — it's the price of admission, and the database is usually where you buy the ticket. A unique constraint that turns a double-run into a harmless collision beats any application logic trying to prevent the double-run. You can't prevent it. You can only survive it.

## Attempts and backoff, and why exponential

Retries are the second half of at-least-once. If jobs run more than once anyway, make the re-runs useful — retry the transient failures, give up on the doomed ones.

Most of our jobs carry the same shape: `attempts: 3, backoff: { type: 'exponential', delay: 2000 }`. Three tries, first retry at 2 seconds, then 4. The exponential part matters more than it looks. Indexing a sale resolves the provider, computes commission against `package_version`, sometimes does an agent-name lookup — under load any of those can briefly fail on a deadlock or a connection-pool wait. A linear retry that fires again immediately just slams the same overloaded resource at the same instant. Exponential backoff gives the transient thing time to clear before you knock again.

But backoff is only correct *because* the job is idempotent. Read that twice — it's the whole architecture in one line. If retrying a non-idempotent job double-charges someone, backoff isn't a safety feature, it's a slower way to corrupt your data. Retries amplify whatever the job does. Idempotent job: a safety net. Non-idempotent job: a foot-gun with a timer on it.

Three attempts is also a deliberate ceiling. A job that's failed three times with exponential spacing is usually not transient — it's structurally broken, a bad input or a missing provider mapping that won't get less missing on a fourth try. Past three, I'd rather it land in the dead pile loudly than spin forever.

## The operational tax you just signed up for

Here's what gets left out of "just put it on a queue." A queue is a system, systems need watching, and the failure modes are quieter than synchronous code.

When an inline call fails, the user sees an error, you see a stack trace, the request is over. When a *job* fails, nothing happens in anyone's face — it lands in the Failed tab of a dashboard nobody opens, and the work silently didn't get done. We index sales through a queue, and for a while the bulk-create path just... didn't enqueue the index job at all. No error. The sales saved fine. They were simply invisible to search until someone ran a manual resync — and because the resync existed, the gap got papered over for weeks before anyone connected the dots. That's the queue tax: a class of bug where the happy path is green and the work quietly evaporated.

Then there's the stalled job, which is worse than a failed one. A failed job is loud. A job stuck in `active` looks like work — the dashboard shows green, the queue says "1 processing," and the process that was processing it died forty minutes ago. I found one the hard way: a salary report that never appeared, sitting in `active` for forty minutes on a job that normally finishes in ten seconds. Bull's stalled-checker is supposed to recover those, but it only runs if a worker's alive to run it, and during a deploy the timing can line up wrong. I ended up writing a sweep that reaps anything `active` past thirty minutes into failed with a `STALLED` reason, because a dead job masquerading as live work will sit there until you go looking.

So the real cost sheet for moving work onto a queue:

- **Redis** is now load-bearing. It's your job store, not just cache. If it's down, the work doesn't queue.
- **A dead-letter story.** Failed jobs need somewhere to go and someone to notice. `STALLED` in the Failed tab is a tombstone, not a recovery.
- **Visibility.** `getJobCounts()` per queue on a polled dashboard, watching `waiting` climb while `active` stays flat — that's backlog forming, usually a dead worker. You have to build that; it doesn't come free with `queue.add`.
- **Idempotency on every processor**, forever, as a standing tax on every new job you write.

None of that exists when the work runs inline. That's the honest other side of the ledger.

## Where the advice flips

The place I've been most wrong is queuing too granularly. Early on a bulk import fired three `queue.add` calls per sale — one to index, one to emit the created-event, one for analytics — so a few thousand rows became thousands of jobs to schedule, retry, and account for, doing work that could've batched. Sometimes the right move is one job that processes a hundred rows, not a hundred jobs. The queue is a tool for decoupling, not a religion that demands maximum fan-out.

The subtler flip: "just one call" doesn't mean "keep it inline." A slow third-party call you make purely for bookkeeping, blocking a response the user is waiting on, wants to be queued even though it's a single call — its slowness is stealing latency from work that actually matters to the user. The unit that decides inline-versus-queued is never the size of the work; it's whether the user is waiting on its result.

## Rules of thumb I actually use

Queue work when the user can walk away and the result will find them later; keep it inline when they're waiting on the screen, and if inline is slow, fix the query before you reach for Redis. Every job runs at least once — make it idempotent at the database, because retries and backoff are only safe on a job that survives running twice.

The work isn't done when it's queued. It's done when it's done, and a queue is very good at hiding the difference. Build the dashboard, watch the age of the oldest active job, and assume the first time a queue fails you, it'll do it quietly. The whole reason you put work on a queue is so the user doesn't have to watch it. Which means *you* have to.
