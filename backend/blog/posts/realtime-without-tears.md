---
title: "Real-time without tears: GraphQL subscriptions plus Redis pub/sub"
description: "Channels, fire-and-forget publishing, socket auth, and the serialization gotchas that get you."
date: "2025-02-24"
updated: "2025-02-24"
kind: "deepdive"
category: "Real-time"
tags: ["graphql", "subscriptions", "redis", "websocket"]
month: "2025-02"
repo: "backend"
author: "Sachal Chandio"
---

A sales rep closes a deal in the field. Within a second, the floor manager's dashboard ticks up, the team leaderboard reshuffles, and the rep who just got leapfrogged sees their rank drop in real time. None of those three browsers polled anything. That's the bar I set for Telelinkz, and the whole thing rides on two pieces: GraphQL subscriptions over WebSocket on the edge, Redis pub/sub in the middle.

The wiring is the easy part. `@nestjs/graphql` ships a `PubSub` you can `import` and call in twenty minutes. The thesis of this post is everything that twenty-minute version gets wrong: it broadcasts to people who shouldn't hear it, it blocks your writes behind your slowest socket, it trusts anyone who can open a connection, and it will silently corrupt your dates. I shipped all four of those bugs before I fixed them. Here's the order I'd fix them in.

## The default PubSub is a toy

Out of the box you get this:

```ts
import { PubSub } from 'graphql-subscriptions';
export const pubSub = new PubSub();
```

That's an in-memory event emitter. It works perfectly on one Node process and evaporates the moment you run two. Telelinkz runs multiple instances behind a load balancer, so a `sale.created` published on instance A never reaches a subscriber holding a socket on instance B. The fix is to swap the transport for Redis so every instance shares one bus:

```ts
import { RedisPubSub } from 'graphql-redis-subscriptions';
import Redis from 'ioredis';

const opts = {
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  retryStrategy: (times: number) => Math.min(times * 50, 2000),
};

export const pubSub = new RedisPubSub({
  publisher: new Redis(opts),
  subscriber: new Redis(opts),
});
```

Two connections, not one — Redis won't let you `SUBSCRIBE` and run normal commands on the same client. Once this is in, the publish API is identical to the in-memory one, so the rest of the code doesn't know it changed. Good. The interesting work starts now.

## Scope the channel or you've built a megaphone

The naive subscription has one channel name:

```ts
@Subscription(() => Sale)
saleCreated() {
  return pubSub.asyncIterator('saleCreated');
}
```

Every connected client subscribes to the literal string `saleCreated`. So when an agent in the Lahore team closes a deal, the Karachi floor manager's dashboard updates too. Not a leak in the security sense — they could query that sale anyway — but it's noise, it's wasted renders, and it does not scale. With a few hundred reps online, every sale fans out to every socket.

The fix is to bake the scope into the channel name and let clients subscribe only to the slice they own. I namespace by team:

```ts
@Subscription(() => Sale, {
  filter: (payload, variables) =>
    payload.saleCreated.teamId === variables.teamId,
})
saleCreated(@Args('teamId', { type: () => ID }) teamId: string) {
  return pubSub.asyncIterator(`saleCreated.${teamId}`);
}
```

Two layers here and they do different jobs. The dynamic channel name `saleCreated.${teamId}` means Redis only delivers the message to instances that have a subscriber for that team — the routing happens in Redis, cheaply. The `filter` is a second gate in case I publish to a broader channel and want a per-subscriber predicate. On the publish side I match the channel:

```ts
await pubSub.publish(`saleCreated.${sale.teamId}`, { saleCreated: sale });
```

A note that cost me an afternoon: the `filter` runs *on the instance holding the socket*, after Redis has already delivered the payload. So if you rely only on `filter` and publish to one fat channel, you've moved the fan-out from Redis into Node and gained nothing. Push the scoping into the channel name. Use `filter` for the fine-grained leftover, not as your primary routing.

There's a case where this advice is wrong, and it's worth saying. If your scope is high-cardinality and ephemeral — say, one channel per individual sale for a live comment thread — you can end up with thousands of distinct Redis channels and a lot of subscribe/unsubscribe churn. At that point a single channel with a `filter` predicate, or a smarter pattern subscription, is the saner call. Channel-per-entity is great for stable, low-cardinality scopes like teams and regions. It's a trap for unbounded ones.

## Publish fire-and-forget, or your writes pay for your sockets

This is the one that actually bit us in production. The sale-creation mutation looked reasonable:

```ts
const sale = await this.salesRepo.save(dto);
await pubSub.publish(`saleCreated.${sale.teamId}`, { saleCreated: sale });
return sale;
```

That `await` is the bug. The mutation now waits on the publish before it returns to the rep who's standing there with a customer. Most of the time it's a millisecond. But the publish has to hand off to Redis, and Redis fans out to every subscriber connection, and if one floor-manager dashboard is on flaky hotel wifi with a backed-up socket buffer, the broadcast slows down — and you've coupled the latency of a *write* to the health of your *slowest reader*. That is exactly backwards. The reader should never be able to hurt the writer.

So I stopped awaiting it. The notification is a side effect, not part of the transaction:

```ts
const sale = await this.salesRepo.save(dto);

// fire-and-forget: a slow subscriber must never block the write
void pubSub
  .publish(`saleCreated.${sale.teamId}`, { saleCreated: sale })
  .catch((err) => this.logger.warn(`saleCreated publish failed: ${err.message}`));

return sale;
```

The `void` and the `.catch` are both load-bearing. `void` says "I'm deliberately not waiting." The `.catch` is there because an un-awaited promise that rejects is an unhandled rejection, and on some Node configs that takes the process down. You are explicitly trading delivery guarantees for write latency: if Redis is down for that 50ms, the event is gone and nobody gets the live update. That's a trade I'll make every time for a dashboard tick. I would *not* make it for something you can't reconstruct — if the real-time event is the only record that a thing happened, you need it durable in the database first and the broadcast second, which is exactly what this ordering gives you. The row is saved before we ever touch Redis. The subscription is pure garnish on top of durable state.

For the heavier reactions — recomputing a leaderboard, denormalizing a daily total — I don't even publish inline. I drop a job on a BullMQ queue and let a worker do the math and publish the result. The mutation's only job is to save the row and get out of the way.

## Authenticate the socket, not just the request

HTTP requests carry an `Authorization` header and my guards check it. WebSocket upgrades are different: the handshake happens once, the connection lives for minutes, and there's no header on each subscription frame. If you don't authenticate at connection time, anyone who can reach the endpoint can open a socket and subscribe to your teams' sale feed. I did exactly that on day one because subscriptions "just worked" in the playground and I forgot they bypass my HTTP guards entirely.

The hook is `onConnect` in the subscriptions transport config. The client sends a token in `connectionParams`; I verify it there and reject the socket before it's ever established:

```ts
GraphQLModule.forRoot<ApolloDriverConfig>({
  driver: ApolloDriver,
  subscriptions: {
    'graphql-ws': {
      onConnect: (context) => {
        const { connectionParams } = context;
        const token = connectionParams?.authorization?.replace('Bearer ', '');
        if (!token) throw new Error('Missing auth token');

        const user = this.jwt.verify(token);   // throws on bad/expired token
        // stash it so resolvers can read it off the ws context
        (context.extra as any).user = user;
        return true;
      },
    },
  },
  context: ({ extra }) => ({ user: extra?.user }),
}),
```

On the Angular side, Apollo's `GraphQLWsLink` takes the same params:

```ts
const wsLink = new GraphQLWsLink(
  createClient({
    url: environment.wsUrl,
    connectionParams: () => ({
      authorization: `Bearer ${this.auth.token}`,
    }),
  }),
);
```

Two things I learned the hard way. First, throwing inside `onConnect` is how you reject — return `false` or throw and the socket never opens, which is what you want. Second, `connectionParams` is evaluated lazily as a function, not a static object, so when the token rotates the *next* reconnection picks up the fresh one. If you pass a plain object you'll happily reconnect with a stale token for the life of the page. And the token does expire mid-session — a long-lived socket will outlive a short JWT, so I keep a short re-auth on reconnect rather than trying to re-verify on every frame.

## Pin your scalars or your dates will lie to you

This is the bug that taught me the lesson in the title. Sales carry a `closedAt` timestamp, a real `Date`. Over HTTP queries it serialized fine. Over the subscription it came through the socket looking like this on the client:

```json
{ "saleCreated": { "closedAt": "2025-02-19T09:31:04.000Z" } }
```

A string. Apollo handed Angular a string where the rest of the app expected a `Date`, so `sale.closedAt.getTime()` threw `closedAt.getTime is not a function`, but only on the live-pushed sales, never on the ones loaded by query. Maddening, because the same field on the same type behaved differently depending on the transport.

The root cause: when you `JSON.stringify` a payload to put it on Redis and `JSON.parse` it on the other side, a `Date` becomes an ISO string and never comes back. The HTTP path didn't hit this because the object never round-tripped through Redis — it went straight from TypeORM to the GraphQL serializer in one process. The subscription path serializes to Redis and rehydrates somewhere else, and `JSON.parse` has no idea that string was ever a date.

The fix is to stop letting GraphQL treat that field as a plain scalar and pin it to a real `DateTime` scalar that knows how to parse a string back into a `Date`. I used `graphql-scalars`:

```ts
import { GraphQLISODateTime } from '@nestjs/graphql';
// or the graphql-scalars DateTimeResolver

@Field(() => GraphQLISODateTime)
closedAt: Date;
```

With the field explicitly typed as a date scalar, the scalar's `parseValue` runs on the way out and the wire format is consistent regardless of how the payload got there. The deeper rule: any value that survives a `JSON.stringify`/`parse` round trip through Redis must have an explicit scalar that owns both its serialize and parse direction. Dates are the obvious victim. The quieter ones are `BigInt` (turns into a string or loses precision), `Decimal` money columns (TypeORM hands you a string already — don't let it reach the client as a number), and anything you store as a `Buffer`. If GraphQL is inferring the scalar, you're trusting `JSON.parse` to guess, and it guesses wrong on exactly the fields where wrong is expensive.

## Rules I'd tell my past self

Scope in the channel name, not the filter — the filter runs after Redis has already done the work, so it's a refinement, never your routing. Never `await` a publish inside a mutation; the write is durable the moment the row is saved, and the broadcast is garnish you can afford to drop. Authenticate the handshake, because a WebSocket bypasses every HTTP guard you wrote and a long socket will outlive a short token. And pin a real scalar on every field that round-trips through Redis, because `JSON.parse` does not know your strings used to be dates, and it will let you find out in production on only half your records.

Where this bites: the day you scale a stable team-scoped channel design onto something high-cardinality and unbounded, every rule above flips. Channel-per-entity becomes channel sprawl, the cheap Redis routing becomes subscribe/unsubscribe thrash, and the filter you demoted is suddenly the right tool again. Real-time isn't hard because of the sockets. It's hard because the right answer depends on the cardinality of the thing you're broadcasting, and that's the number nobody writes down until it hurts.
