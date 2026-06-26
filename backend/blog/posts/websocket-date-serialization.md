---
title: "The WebSocket date bug that broke real-time task updates"
description: "A Date serialized over a GraphQL subscription arrived as the wrong thing on the client. Here's why, and the scalar fix."
date: "2025-02-03"
updated: "2025-02-03"
kind: "deepdive"
category: "Real-time"
tags: ["graphql", "subscriptions", "websocket", "dates"]
month: "2025-02"
repo: "backend"
author: "Sachal Chandio"
---

The bug report was four words and a screenshot: "due date says NaN." A team lead had reassigned a task on the Telelinkz board, and the live card that popped up on her agent's screen — pushed over a GraphQL subscription, no refresh — showed `Invalid Date` where the deadline should be. Reload the page and it was fine. The deadline was correct in MySQL, correct in the REST-ish query response, correct everywhere except the one path that mattered for the feature we'd just shipped: the real-time push.

That "reload fixes it" detail is the tell. If the query is right and the subscription is wrong, the data is fine and the *transport* is mangling it. Two code paths, same task, different answer. So the question was never "is the date wrong in the database." It was "what does the subscription path do to a date that the query path doesn't."

## The wrong guess: timezones

My first instinct was timezone drift, because it always is. We have agents across a few timezones, the server runs UTC, and a date that's "off by a day" is the most clichéd symptom in the catalog. I spent a good hour staring at whether `dueDate` was getting shifted somewhere between the column and the wire — checking the MySQL session timezone, checking whether TypeORM was reading the `datetime` column as local time, dumping `new Date(row.dueDate).toISOString()` in a few spots.

It wasn't that. The dates weren't shifted. Some of them weren't *dates*. When I finally logged the raw payload the Angular client received over the socket, I got three different shapes for what should have been one type:

```json
{
  "createdAt": "2025-02-03T09:14:22.000Z",
  "startDate": { },
  "dueDate": 1738573200000,
  "archivedAt": "2025-02-03 09:14:22"
}
```

A proper ISO string. An empty object. A raw epoch number. And a MySQL-flavored space-separated string that `new Date()` parses inconsistently across browsers. The Angular code did `new Date(task.dueDate)` and trusted it, which is fine for an ISO string and garbage for `{}`. That's where the `NaN` came from. Timezones were a red herring; the real problem was that the value's *type* changed depending on which field and which code path produced it.

## Root cause: JSON has no Date

We publish task changes through Redis. The subscription resolver pulls from a Redis-backed pub/sub:

```ts
return this.redisPubSubService.pubSub.asyncIterator(channel);
```

and the pub/sub itself is `RedisPubSub` from `graphql-redis-subscriptions`, wired to two `ioredis` clients:

```ts
this.pubSubClient = new RedisPubSub({ publisher, subscriber });
```

Here's the part I'd glossed over when I built it. To get a message from the publishing process to the subscribing process, that payload goes through Redis as a string. Which means `JSON.stringify` on the way out and `JSON.parse` on the way in. And `JSON` has no concept of a `Date`. `JSON.stringify(new Date())` gives you an ISO string — fine — but `JSON.stringify` of an object whose date property is `null`, or already a string, or a number, gives you back exactly that. The round-trip flattens whatever you handed it. A `Date` instance becomes a string; the prototype is gone. Anything that was already a non-Date stays weird.

The query path never hit this. A query resolves the entity in-process, the GraphQL layer serializes each field through its declared scalar, and the client gets a clean string. The subscription path serialized the whole object *twice* — once as JSON into Redis, then again through GraphQL — and the first pass had no scalar to enforce a shape. By the time GraphQL's serialization ran, half the fields were already the wrong primitive.

The reason the *shapes* varied field to field came straight from our own schema, and this is the embarrassing bit. The task DTO had typed its dates three different ways depending on who'd touched that field last:

```ts
@Field(() => String)
@IsDateString()
dueDate: Date;          // declared String, typed Date — already lying

@Field(() => Date, { nullable: true })
startDate?: Date;       // the default Date scalar

@Field(() => Date, { nullable: true })
archivedAt?: Date;      // same, but the column held a MySQL-format string
```

`dueDate` was a `String` field holding a `Date` in TypeScript — a contradiction the compiler can't catch because the decorator type and the TS type are checked by completely different machinery. `startDate` used the built-in `Date` scalar. The values in the column weren't uniform either: some rows had real `datetime` values, some legacy rows had `0000-00-00`-style junk that MySQL happily returns as a string. Over the query path, GraphQL's scalar smoothed most of this over on serialize. Over the subscription path, the JSON round-trip got there first and there was no single rule deciding what a date *is*.

## The fix, in two parts

**Part one: one scalar, applied end to end.** I wrote a custom scalar, `ExtendedDateTime`, whose entire job is to take any of the half-dozen things a "date" arrives as and turn it into one canonical thing. It accepts a `Date`, an epoch number, a numeric string, a `YYYY-MM-DD` date-only string, a full ISO string, even MySQL's space-separated format — and it refuses the zero-date junk instead of producing `Invalid Date`:

```ts
@Scalar('ExtendedDateTime')
export class DateScalar implements CustomScalar<string, Date> {
  serialize(value: any): string {
    const date = this.safeCreateDate(value);
    if (!date) throw new Error(`Invalid date value: ${value}`);
    return date.toISOString();   // exactly one wire format, always
  }

  parseValue(value: any): Date {
    const date = this.safeCreateDate(value);
    if (!date) throw new Error(`Invalid date value: ${value}`);
    return date;
  }
}
```

`safeCreateDate` is the boring, defensive core — it does the type sniffing so nothing downstream has to:

```ts
private safeCreateDate(value: any): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return this.isValidDate(value) ? value : null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return this.isValidDate(d) ? d : null;
  }
  if (typeof value === 'string') {
    const v = value.trim();
    if (!v || v.startsWith('0000-00-00')) return null;   // MySQL zero-date
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return this.isValidDate(new Date(v + 'T00:00:00Z')) ? new Date(v + 'T00:00:00Z') : null;
    }
    if (/^\d{10,13}$/.test(v)) {                          // epoch as string
      const d = new Date(Number(v));
      return this.isValidDate(d) ? d : null;
    }
    const d = new Date(v);
    return this.isValidDate(d) ? d : null;
  }
  return null;
}
```

Then the date fields got pointed at it consistently — `dueDate` stopped pretending to be a `String`, and `startDate`/`archivedAt`/`createdAt` all resolved through the same scalar. The contract became: a date field serializes to an ISO-8601 string via `toISOString()`, on every path, no exceptions. Register it as a provider and it's in the schema:

```ts
providers: [AppService, DateScalar, /* ... */]
```

**Part two: normalize the payload before it re-serializes.** The scalar fixes the eventual wire format, but the subscription has a sequencing problem the query doesn't: the JSON round-trip already happened. By the time the payload comes back out of Redis, `startDate` might be the empty object `{}` that a stringified bad `Date` collapses into, and no scalar `serialize` will rescue `{}` into a real date. So I added a `resolve` step on each subscription that rehydrates the dates back into real `Date` instances *before* GraphQL serialization runs:

```ts
@Subscription(() => TaskChangeNotification, {
  filter: async (payload, variables, context) => { /* auth + scoping */ },
  resolve: (payload) =>
    TaskSubscriptionResolver.normalizeNotificationDates(payload.taskChangedInWorkspace),
})
async taskChangedInWorkspace(/* ... */) {
  return this.redisPubSubService.pubSub.asyncIterator(channel);
}
```

`normalizeNotificationDates` walks the notification and coerces every date-shaped field — top-level task timestamps, the nested image `createdAt`, the dates buried in `assignmentHistory` and its `changes` map — through the same `toValidDate` helper:

```ts
private static toValidDate(value: any): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}
```

So the order of operations on the subscription path is now: publish (JSON out to Redis) → receive (JSON in) → `resolve` rehydrates Dates → GraphQL `serialize` via `ExtendedDateTime` emits one ISO string. The value that lands on the Angular client is byte-for-byte the same shape the query path produces. `new Date(task.dueDate)` on the frontend is finally safe, because `task.dueDate` is *always* an ISO string and never `{}` again.

I'll admit the `resolve`-normalizer is a patch on a leak, not elegance. The cleaner design would be a custom serializer on the pub/sub itself so dates survive the Redis hop with their type intact — `graphql-redis-subscriptions` lets you pass `serializer`/`deserializer` options for exactly this. I went with the per-subscription normalizer because it was surgical and I could ship it that afternoon, and because the failing values (the `{}` from a stringified bad Date) needed coercion logic that lived close to the notification shape anyway. If I were doing it again from scratch I'd push the rule down into the transport. But the scalar is the part that actually mattered: it gave the system one definition of "date" instead of three.

## When this bites you

Any time a value crosses a process boundary as JSON, its type is a suggestion, not a guarantee. The query path lulled me because in-process serialization had a scalar enforcing the shape; the subscription path went through Redis first and lost the scalar's protection until it was too late. The general rule I took away: a `Date` (or a `BigInt`, or a `Map`, or anything with a prototype) does not survive `JSON.stringify`/`JSON.parse` as itself. It survives as whatever primitive `JSON` decided to flatten it into, and if different fields started life as different primitives, you get a different bug per field — which is exactly the "sometimes a string, sometimes an object, sometimes a number" symptom that sent me chasing timezones.

The thing I'd actually tell a teammate: when a value is right over HTTP and wrong over the socket, don't debug the value. Debug the boundary it crossed. And the day you let the same logical type be declared as `@Field(() => String)` in one place and `@Field(() => Date)` in another, you've already written this bug — it's just waiting for a transport that doesn't paper over the difference.
