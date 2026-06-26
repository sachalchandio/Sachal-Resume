---
title: "Real-time task boards: GraphQL subscriptions over Redis pub/sub"
description: "Manual refresh is a smell. Pushing task changes to exactly the clients who care, with fire-and-forget publishing."
date: "2025-02-22"
updated: "2025-02-22"
kind: "deepdive"
category: "Real-time"
tags: ["graphql", "subscriptions", "redis", "pubsub", "nestjs"]
month: "2025-02"
repo: "backend"
author: "Sachal Chandio"
---

The complaint came from a floor supervisor, and it was the kind that doesn't fit in a Jira ticket cleanly: "I move a task to a rep and I have to tell them to refresh." Two people, one board, and a hidden F5 between them. She'd drag a card into someone's column, then ping them on the side to reload so they'd actually see it. The board was a shared surface that quietly wasn't shared — everyone was looking at a snapshot from whenever they last loaded the page.

Polling was the lazy answer and I almost took it. Refetch the board every ten seconds, call it real-time, move on. But the task board is the busiest screen in the app — every supervisor and every rep on shift has it open all day — and most of those refetches would return the exact same rows they already had. That's a lot of MySQL load to deliver "nothing changed" over and over. The thing that actually changes is rare and small: one card moved, one task created. I wanted to push *that*, to the people looking at that board, and stay quiet otherwise.

## Why pub/sub and not just an in-memory PubSub

NestJS ships a `PubSub` from `graphql-subscriptions` and it works fine in a tutorial. It's an event emitter living in one process's memory. The moment you run more than one instance of the API — which we do, behind a load balancer — it falls apart, invisibly in dev and obviously in production. A mutation lands on instance A. The subscriber holding the open WebSocket is connected to instance B. Instance A emits into its own memory, B never hears it, and the push silently doesn't happen. You'd never catch it locally because locally there's one process and everything's on the same heap.

We already ran Redis for caching and session state. Redis pub/sub solves exactly this: publish on any instance, every instance subscribed to that channel gets the message. So I swapped the in-memory emitter for `graphql-redis-subscriptions`, which gives you the same `asyncIterator` interface the resolver expects but backed by a Redis publisher/subscriber pair under the hood.

```ts
import { RedisPubSub } from 'graphql-redis-subscriptions';
import Redis from 'ioredis';

export const PUB_SUB = Symbol('PUB_SUB');

export const pubSubProvider = {
  provide: PUB_SUB,
  useFactory: (config: ConfigService) => {
    const options = {
      host: config.get('REDIS_HOST'),
      port: config.get<number>('REDIS_PORT'),
    };
    // separate connections: a Redis subscriber can't run normal commands
    return new RedisPubSub({
      publisher: new Redis(options),
      subscriber: new Redis(options),
    });
  },
  inject: [ConfigService],
};
```

The two-connection thing is not optional and it bit me first. A Redis connection in subscribe mode can't issue ordinary commands — once it's listening it's listening, and a `GET` on it throws. I tried to hand `RedisPubSub` the shared cache client for both roles, and got `Connection in subscriber mode, only subscriber commands may be used` the first time anything else touched the cache. Give it its own two connections and stop fighting it.

## Channels scoped so the push goes to the right people

Here's the decision the whole feature hangs on. Publish every task change to one global channel and every connected client gets woken for every change in the company, then has to look at the payload and decide "is this even my board?" That's a fan-out to everyone to deliver something to one team. Wasteful, and it leaks — a rep's socket would receive events for groups they can't see, and now the filtering correctness lives on the client where I don't trust it.

So the channel name carries the scope. Tasks belong to a *group* (a team/queue) and a *client* (the tenant-ish partition above that), so the channel is built from both:

```ts
function taskChannel(event: 'CHANGED' | 'CREATED' | 'DELETED', groupId: number) {
  return `TASK_${event}.group.${groupId}`;
}
// TASK_CHANGED.group.42, TASK_CREATED.group.42, TASK_DELETED.group.42
```

A subscriber only listens on the channels for the groups it's actually allowed to watch. Redis does the routing. The server process for a given socket only ever wakes up for events on that socket's groups, and the payload that arrives already belongs to that group — there's no "is this mine" check downstream because the channel name already answered it. The authorization happens once, at subscribe time, when I decide which group channels this user may attach to. After that the topology does the filtering.

## The subscriptions on the schema

Three events, because "something about a task changed" is too coarse for the client to render well. A created task animates in. A deleted task animates out. An updated task patches in place. Collapsing them into one `taskChanged` would force the Angular side to diff its cache against every payload to figure out which kind of thing happened, so I split them:

```ts
@Resolver()
export class TaskSubscriptionsResolver {
  constructor(@Inject(PUB_SUB) private readonly pubSub: RedisPubSub) {}

  @Subscription(() => Task, {
    filter: (payload, _vars, ctx) =>
      ctx.user.groupIds.includes(payload.taskChanged.groupId),
  })
  taskChanged(@Args('groupId', { type: () => Int }) groupId: number) {
    return this.pubSub.asyncIterator(`TASK_CHANGED.group.${groupId}`);
  }

  @Subscription(() => Task)
  taskCreated(@Args('groupId', { type: () => Int }) groupId: number) {
    return this.pubSub.asyncIterator(`TASK_CREATED.group.${groupId}`);
  }

  @Subscription(() => ID)
  taskDeleted(@Args('groupId', { type: () => Int }) groupId: number) {
    return this.pubSub.asyncIterator(`TASK_DELETED.group.${groupId}`);
  }
}
```

`taskDeleted` returns just the `ID`, not the whole `Task`. You don't need the object to remove a card; you need its id so the client can splice it out of the list. Sending the full deleted entity would be sending a thing whose entire point is that it's gone.

The `filter` on `taskChanged` is a belt-and-suspenders check. The channel scoping already means you only get events for groups you subscribed to, but `filter` re-asserts membership against the authenticated user on the socket, so even a client that tried to subscribe to a `groupId` it shouldn't has the payload dropped before it's sent. Channel scoping is the performance story; `filter` is the security story. I want both.

## Publishing without letting it block the write

This is the part I'm actually glad I got right the first time, mostly because I'd gotten it wrong somewhere else before. The publish has to happen *after* the database write commits, and it must never be allowed to slow that write down or fail it.

The naive version awaits the publish inline:

```ts
async moveTask(id: number, toGroupId: number): Promise<Task> {
  const task = await this.taskRepo.save({ id, groupId: toGroupId, /* ... */ });
  await this.pubSub.publish(`TASK_CHANGED.group.${toGroupId}`, {
    taskChanged: task,
  });
  return task;
}
```

Read that `await` and think about what it ties together. The mutation can't return until Redis acknowledges the publish. If Redis is slow, the rep who dragged the card waits. If Redis is down, the *write* — which already succeeded in MySQL — throws on the way out and the mutation reports failure for a task that was, in fact, moved. I'd coupled the durability of the write to the liveness of a notification. The write is the thing that matters; the push is a nicety. Letting the nicety fail the thing that matters is exactly backwards.

So publishing is fire-and-forget. Kick it off, don't await it, swallow its failure into a log, return the write immediately:

```ts
private emit(channel: string, payload: Record<string, unknown>): void {
  // intentionally not awaited: a slow or down subscriber path
  // must never block or fail the mutation that already committed
  void this.pubSub.publish(channel, payload).catch((err) => {
    this.logger.error(`pub/sub publish failed for ${channel}`, err);
  });
}

async moveTask(id: number, toGroupId: number): Promise<Task> {
  const task = await this.taskRepo.save({ id, groupId: toGroupId, /* ... */ });
  this.emit(`TASK_CHANGED.group.${toGroupId}`, { taskChanged: task });
  return task;
}
```

The `void` and the `.catch` are both load-bearing. `void` tells the reader, and the linter, that not awaiting this is deliberate. The `.catch` is there because an unawaited promise that rejects is an unhandled rejection, and a flaky Redis would have turned into a stream of process-level warnings — or a crash, depending on your Node flags — for something I explicitly decided not to care about in the request path. The worst case is now a missed live update, and the recovery for that is what the supervisor was already doing by hand: refresh. Degraded, not broken.

## The move that touches two boards

`moveTask` has a wrinkle the create and delete paths don't. When a task moves from group 7 to group 42, two boards are wrong, not one. The board watching group 7 needs the card to leave; the board watching group 42 needs it to arrive. Publishing only `TASK_CHANGED.group.42` updates the destination and leaves a ghost card sitting on the source board until someone reloads.

So a cross-group move emits to both, and it emits a *delete* to the old group, not a change:

```ts
async moveTask(id: number, toGroupId: number): Promise<Task> {
  const before = await this.taskRepo.findOneByOrFail({ id });
  const fromGroupId = before.groupId;
  const task = await this.taskRepo.save({ id, groupId: toGroupId });

  if (fromGroupId !== toGroupId) {
    this.emit(`TASK_DELETED.group.${fromGroupId}`, { taskDeleted: id });
  }
  this.emit(`TASK_CHANGED.group.${toGroupId}`, { taskChanged: task });
  return task;
}
```

From the source board's point of view the task no longer exists on it, so `taskDeleted` is the honest event — the card should leave the way a real deletion would. Reusing the delete subscription instead of inventing a `taskMovedAway` event meant the client already knew how to handle it. I almost added a fourth subscription for moves before realizing a move *is* a delete here and a create there, sharing a row.

## Sharp edges I didn't see coming

The reconnect gap is the honest limitation. WebSockets drop — laptop sleeps, wifi blips, a deploy cycles the pods — and while a socket is down, any task change published in that window is gone for that client. Pub/sub has no replay; if nobody's listening on the channel at publish time, the message evaporates. A reconnecting client has a hole in its history it can't know about. The fix isn't more pub/sub. The client refetches the board once on every (re)connect to establish a clean baseline, then trusts the live stream from there. Pub/sub keeps you current; the refetch-on-connect is what makes you *correct* after a gap. Treating the stream as the source of truth instead of as a delta on a fetched baseline is a trap I'd warn anyone off.

The other one, the embarrassing one, was payloads. The created/changed subscriptions ship the full `Task` entity, and a `Task` has a `Date` deadline on it. Dates don't survive the subscription transport the way they survive a normal query response — that turned into its own bug and its own fix, a custom scalar, which I wrote up separately. The lesson that generalizes: data published over pub/sub goes through a different serialization path than data returned from a resolver, and "it's correct in the query" buys you nothing about whether it's correct on the wire.

## What I'd change

I'd carry a small sequence number on each task and let the client drop stale pushes. Right now two rapid edits to the same task race — if the publish for edit #1 lands after edit #2 because of network ordering, the board briefly shows the older state until the next event corrects it. It's rare and self-healing, so I shipped without it, but a monotonic `rowVersion` on the payload would let the client ignore anything older than what it's already showing, and I'd sleep slightly better about ordering I don't actually control.

And I'd be more deliberate about the channel name. Scoping by group was right, but I baked `groupId` into the string in a dozen call sites by hand, and a typo — `TASK_CHANGE` instead of `TASK_CHANGED` — is a push that silently goes nowhere, because publishing to a channel nobody's subscribed to is a no-op, not an error. Same failure shape as fire-and-forget: quiet. The most useful thing I did late was route every channel name through one `taskChannel()` builder so the publisher and the subscriber can't disagree about the string. When the wire is silent on failure, you want the names impossible to get wrong, not a log line telling you that you did.
