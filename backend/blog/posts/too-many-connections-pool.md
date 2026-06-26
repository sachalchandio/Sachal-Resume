---
title: "‘Too many connections’: tuning the TypeORM and MySQL pool"
description: "A production pool exhaustion bug, and what connectionLimit, acquireTimeout, and date transformers actually do under load."
date: "2026-01-02"
updated: "2026-01-02"
kind: "deepdive"
category: "Databases"
tags: ["typeorm", "mysql", "connection-pool", "production"]
month: "2026-01"
repo: "backend"
author: "Sachal Chandio"
---

The first sign was a Slack message from a sales manager: "the dashboard is spinning and then it just errors." By the time I had the logs open the stack trace was repeating every few seconds.

```
QueryFailedError: ER_CON_COUNT_ERROR: Too many connections
    at Query.onResult (mysql2/lib/commands/query.js:...)
    at PoolConnection.execute (typeorm/driver/mysql/MysqlQueryRunner.js:...)
```

This was during a Monday morning, which for a telecom sales CRM is the worst possible time. Every fronter and agent logs in within the same fifteen minutes, opens their pipeline, and the dashboards start firing GraphQL queries — sale counts, status breakdowns, leaderboard widgets, each one its own ECharts panel hitting its own resolver. Concurrency goes from near-zero on Sunday night to a few hundred in-flight requests, fast.

## The wrong guess first

My first instinct was that MySQL itself was out of connections. `ER_CON_COUNT_ERROR` is, after all, the error MySQL throws when you exceed `max_connections`. So I SSH'd into the RDS box's monitoring, pulled `SHOW VARIABLES LIKE 'max_connections'`, and got 150. Then `SHOW STATUS LIKE 'Threads_connected'` while the app was struggling — and it was sitting at maybe 12.

Twelve. Out of 150. The database was bored.

That number is the whole story, in hindsight, but at the time it just confused me. If MySQL has 138 connections free, why is anything getting "too many connections"? I went down a rabbit hole for twenty minutes assuming some other service — a stray migration runner, a cron container, an analytics tool — was hogging the connection ceiling. It wasn't. Nobody else was connected.

The error message is technically MySQL's, but the cause wasn't on MySQL's side at all. It was ours.

## What the pool was actually doing

Here's the config that was in production. We'd set it early on, copied from some tutorial, and never touched it because it had never mattered.

```ts
// app.module.ts — the original, naive config
TypeOrmModule.forRoot({
  type: 'mysql',
  host: process.env.DB_HOST,
  port: 3306,
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  autoLoadEntities: true,
  extra: {
    connectionLimit: 5,
  },
});
```

`connectionLimit: 5`. The mysql2 pool will open at most five sockets to the database and hand them out one at a time. When all five are checked out and a sixth query arrives, that query waits in a queue for a connection to come back.

That part is fine. Queueing is the whole point of a pool. The problem is what happens when the queue never drains fast enough. Under Monday load we had dozens of resolvers all wanting a connection at once, against a pool of five. Requests didn't fail because the database was full — they failed because they sat in the pool's internal acquire queue until they timed out, and mysql2 surfaces that timeout as the same `ER_CON_COUNT_ERROR` family.

So the "too many connections" was really "too few connections, for too long." A pool of five doesn't give you five times the throughput and then degrade gracefully. It serializes everything past the fifth concurrent query. If each dashboard query takes 80ms and you've got 60 of them land at once, the unlucky ones at the back of the line are waiting half a second or more just to get a socket, before the query itself even runs. Pile a few of those Monday spikes on top of each other and the queue depth grows faster than it drains.

The fix isn't subtle once you see it. The pool was sized for a side project, not for a few hundred concurrent users.

## The fix

I raised the limit, but more importantly I made the timeouts explicit so the failure mode would be legible next time.

```ts
// app.module.ts — after
TypeOrmModule.forRoot({
  type: 'mysql',
  host: process.env.DB_HOST,
  port: 3306,
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  autoLoadEntities: true,
  extra: {
    connectionLimit: 25,   // was 5
    acquireTimeout: 30_000, // wait up to 30s for a pooled connection
    waitForConnections: true,
    queueLimit: 0,         // unbounded queue; rely on acquireTimeout instead
    connectTimeout: 20_000, // TCP/handshake timeout for opening a new socket
  },
});
```

Two different timeouts live in here and it's worth being precise, because I conflated them at first:

- `connectTimeout` is how long mysql2 waits to *establish* a brand-new TCP connection and finish the MySQL handshake. If RDS is unreachable or slow to accept, this is the one that fires.
- `acquireTimeout` is how long a query waits to *borrow* an existing connection from the pool. This is the one that was effectively firing under load — the connections were healthy, there just weren't enough of them and the wait was unbounded-but-short by default.

I picked 25 by working backwards from MySQL's ceiling. We run a few app instances behind the load balancer, and `connectionLimit` is per instance, per pool. So the real number to keep under `max_connections` is `instances × connectionLimit`, plus headroom for migrations, the BullMQ workers' own pool, and the occasional human poking around in a SQL client. With 150 on RDS and a handful of instances, 25 each leaves comfortable room. Don't set `connectionLimit` to something that, multiplied across every instance, blows past `max_connections` — then you really will get the MySQL-side version of this error, and raising the pool will have made it worse.

After deploying, `Threads_connected` settled around 30–40 during the morning spike, the acquire queue stopped backing up, and the dashboard stopped spinning. The slow page was the symptom; a pool of five was the disease.

## The phantom migration that showed up while I was in there

While I had the entity files open I noticed something that had been quietly annoying me for weeks. Every time I ran `typeorm migration:generate`, it wanted to "fix" the same date columns — generating an `ALTER TABLE` for columns nobody had touched.

```sql
ALTER TABLE `sale` CHANGE `created_at` `created_at` datetime NOT NULL
ALTER TABLE `sale` CHANGE `sale_date` `sale_date` date NOT NULL
```

These migrations were empty in spirit — they changed nothing real — but TypeORM kept regenerating them because its idea of the column type didn't round-trip with what MySQL actually stored. MySQL hands back `DATE` columns as JS `Date` objects in local server time, and the schema comparison TypeORM does on `sale_date` was tripping over the type mismatch between what it expected and what the driver returned. The result is a "synchronize" diff that's always non-empty, so the CLI always thinks there's a migration to write.

It's harmless until it isn't. The danger is the day a real schema change hides inside the noise, or someone runs one of these phantom `ALTER`s on a big table and takes a lock for no reason.

The fix that made it stop was an explicit column transformer that pins the in/out shape so the comparison round-trips cleanly. For the pure-date column I store and read a plain `YYYY-MM-DD` string and let the transformer own the conversion:

```ts
// a small reusable transformer for DATE columns
export const dateOnlyTransformer = {
  to: (value?: Date | string | null): string | null => {
    if (!value) return null;
    const d = typeof value === 'string' ? new Date(value) : value;
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  },
  from: (value?: string | null): string | null => value ?? null,
};

@Entity()
export class Sale {
  @Column({
    type: 'date',
    transformer: dateOnlyTransformer,
  })
  saleDate: string;
}
```

The point isn't the transformer itself so much as making TypeORM's expected representation and MySQL's stored representation agree, so the schema diff comes back empty and `migration:generate` stops inventing work. Once both sides spoke `date` the same way, the phantom `ALTER`s disappeared and the next generated migration was, correctly, empty.

If you'd rather not hand-roll a transformer, the cheaper version is to be exact about the column type up front — `@CreateDateColumn({ type: 'datetime' })` with the same precision the table actually has — and to never let `synchronize: true` anywhere near production. We don't; every change goes through a generated migration that a human reads first. That discipline is what turned the phantom migrations from a mystery into a five-minute fix.

## What I'd tell past me

The connection pool is the most boring config you'll ever write and the one most likely to take down a Monday. A pool of five looks fine in dev, fine in staging, fine in the demo — because none of those have a hundred people logging in at the same minute. It only shows its teeth under real concurrency, and when it does, the error points at the database when the problem is your pool size.

Two things stuck with me. First: when you see `ER_CON_COUNT_ERROR`, check `Threads_connected` against `max_connections` before you touch anything. If the database has plenty of headroom, the lie is in your pool config, not the server. Second: size `connectionLimit` deliberately as `instances × limit < max_connections`, set `acquireTimeout` so the failure is a clean, traceable timeout instead of a confusing inherited error, and keep the date columns honest so the schema tooling never cries wolf. The day a real migration matters, you want the diff to be empty unless it actually isn't.
