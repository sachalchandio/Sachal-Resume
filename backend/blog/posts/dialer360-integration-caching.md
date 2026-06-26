---
title: "Integrating Dialer360: an HTTP client with auth, timeouts, and layered caching"
description: "Agent stats and call telemetry from a third party, without hammering it or blocking on it."
date: "2026-04-15"
updated: "2026-04-15"
kind: "deepdive"
category: "Architecture"
tags: ["nestjs", "http", "caching", "redis", "integration"]
month: "2026-04"
repo: "backend"
author: "Sachal Chandio"
---

The dialer is not our system. That single fact shapes everything about this module.

Telelinkz tracks who sold what, who fronted it, who's on break. But the actual phone calls — the connects, the talk time, the unique-call counts that tell you whether an agent is dialing or hiding — those live in Dialer360, a third-party predictive dialer the call floor runs on. We needed its numbers on our dashboards. The agent productivity board, the live floor view, a couple of the daily rollups all wanted "how many unique calls has this agent made today" sitting next to "how many sales did they close." Two numbers, one screen. The sales half was a local query. The calls half was an HTTP call to a box I didn't control and couldn't fix.

So this post is less about a clever algorithm and more about defense. The whole job was absorbing the ways a third party can make your day worse: it can be slow, it can be down, it can hand you a different shape than yesterday, and it can rate-limit you for asking too often. The caching layers are the part I'm proudest of, and they exist entirely because the upstream gave me no other choice.

## What the upstream actually gives you

Dialer360 exposes a small HTTP API. Basic auth — a username and password you pass on every request, no tokens, no refresh, no OAuth dance. You ask for agent lists, you ask for call stats per agent over a date range, you get JSON back. When it's healthy it answers in a couple hundred milliseconds. When it's not, it does the worst possible thing: it doesn't error, it just hangs. A socket that stays open and silent for thirty seconds is so much worse than a clean `503`, because a `503` you can catch and a hang you can only wait out.

The first naive version I wrote was about six lines and I want to show it because it was wrong in an instructive way:

```ts
async getAgents(): Promise<DialerAgent[]> {
  const res = await firstValueFrom(
    this.http.get(`${this.baseUrl}/agents`, {
      auth: { username: this.user, password: this.pass },
    }),
  );
  return res.data;
}
```

This works on a good day. It also has no timeout, no caching, and no opinion about what happens when `res.data` comes back as `{ error: "..." }` instead of an array. It blocks the request thread of whatever called it for as long as Dialer360 feels like taking. On a dashboard that loads the agent list on every page open, with the dialer mid-hiccup, this is how you turn one slow upstream into a floor full of spinning frontends. I shipped roughly this. I'm not proud of it. It taught me the rest.

## The hard timeout

Rule one: never let the third party decide how long my request takes. NestJS's `HttpService` wraps Axios and emits an Observable, which means I get RxJS operators for free, and `timeout` is the one that matters here.

```ts
import { timeout, catchError } from 'rxjs/operators';
import { firstValueFrom, throwError, TimeoutError } from 'rxjs';

private readonly REQUEST_TIMEOUT_MS = 8_000;

private async call<T>(path: string): Promise<T> {
  return firstValueFrom(
    this.http
      .get<T>(`${this.baseUrl}${path}`, {
        auth: { username: this.user, password: this.pass },
        timeout: this.REQUEST_TIMEOUT_MS, // axios-level
      })
      .pipe(
        timeout(this.REQUEST_TIMEOUT_MS), // rxjs-level, the real backstop
        catchError((err) => {
          if (err instanceof TimeoutError) {
            this.logger.warn(`Dialer360 timed out on ${path}`);
          }
          return throwError(() => err);
        }),
      ),
  );
}
```

Two timeouts, and that's deliberate. The Axios `timeout` covers the case where the connection is made and the response stalls. The RxJS `timeout` is the backstop for everything Axios's timer doesn't reliably cover — DNS that hangs, a socket that connects but never sends a byte, the cases where I've watched the Axios timer not fire when I expected it to. Eight seconds is the number I landed on after watching production: long enough that a merely-slow dialer still answers, short enough that a frontend waiting on it doesn't feel hung. I'd rather serve a slightly stale number from cache than make a manager stare at a spinner.

And critically, a timeout is not a crash. It throws, the caller catches, and — this is the whole design — the caller falls back to cache instead of propagating an error to the dashboard.

## The caching layers, which are the point

Here's the thing the dialer forced on me. The agent productivity board polls. Multiple managers have it open. Each poll wants agent lists and per-agent call counts. If every poll from every open board became a live HTTP call to Dialer360, I'd be hammering an upstream that's already shaky, and I'd be doing it for data that barely changes minute to minute. The agent *roster* changes maybe twice a day. The *call counts* change constantly but nobody needs them to the second.

So: two layers, and — this is the part that took me a while to get right — two different TTLs, because the two kinds of data have completely different freshness needs.

Layer one is in-memory, per-instance: a plain `Map` with timestamps. It catches the case where the same Node process asks for the same thing twice within a few seconds, which happens constantly when a dashboard resolves several fields off one request. Layer two is Redis, shared across every backend instance, which is what actually shields Dialer360 from the fleet. An in-memory cache on three instances still means three calls to the upstream; the Redis layer collapses that to one.

```ts
private readonly AGENTS_TTL = 30 * 60;      // 30 min — roster is near-static
private readonly CALL_COUNT_TTL = 60;       // 60 sec — counts move, but not per-tick
private readonly mem = new Map<string, { value: unknown; expiresAt: number }>();

private async cached<T>(key: string, ttlSec: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();

  // L1: in-process
  const local = this.mem.get(key);
  if (local && local.expiresAt > now) return local.value as T;

  // L2: Redis, shared across instances
  const hit = await this.redis.get(key);
  if (hit) {
    const value = JSON.parse(hit) as T;
    this.mem.set(key, { value, expiresAt: now + 5_000 }); // short local mirror
    return value;
  }

  // miss on both — go to the upstream, populate both layers
  const value = await loader();
  await this.redis.setex(key, ttlSec, JSON.stringify(value));
  this.mem.set(key, { value, expiresAt: now + Math.min(ttlSec, 30) * 1000 });
  return value;
}
```

The two TTLs are the actual design decision, not an implementation detail. Thirty minutes for the agent roster because onboarding a new agent on the dialer is a rare, human-paced event; if their card shows up half an hour late nobody files a ticket. Sixty seconds for unique-call counts because that number is the live signal managers watch, but a minute of staleness is invisible to a human and it cuts the upstream load to at most one fetch per minute per key no matter how many boards are polling. Put a single TTL on both and you lose either way: thirty minutes on call counts makes the productivity board lie, sixty seconds on the roster means you're re-fetching a static list constantly for no reason.

Note the local mirror on a Redis hit gets a short 5-second TTL, not the full one. The in-memory layer's only job is to catch tight bursts within one request lifecycle; it deliberately doesn't try to hold the full TTL, because then a single instance could serve a value 25 seconds staler than what Redis has, and reconciling that isn't worth it. Redis is the source of cached truth. Memory is just a flyweight in front of it.

## Reconciling their agents to our users

The other obstacle was identity. Dialer360 has its own agent records with its own ids and its own idea of an agent's name — usually a login handle, sometimes with a station number stapled on. Our `user` table has the real person. Nothing in the dialer payload is our user id, so every call stat comes back keyed to a stranger.

I needed a mapping layer, and I learned not to trust name matching alone. The first cut matched on display name and it was a mess — "j.smith" on the dialer versus "John Smith" in our system, two agents who'd swapped stations, a trailing whitespace that made an exact match miss. So the mapping is an explicit crosswalk persisted in our database, `dialer_agent_map`, keyed by the dialer's agent id to our `userId`, with the name match used only as a *suggestion* when a new dialer agent appears unmapped.

```ts
async mapStatsToUsers(stats: DialerCallStat[]): Promise<UserCallStat[]> {
  const map = await this.getAgentMap(); // cached: dialerAgentId -> userId
  const mapped: UserCallStat[] = [];
  const unmapped: DialerCallStat[] = [];

  for (const stat of stats) {
    const userId = map.get(stat.dialerAgentId);
    if (userId) mapped.push({ userId, uniqueCalls: stat.uniqueCalls, talkTime: stat.talkTime });
    else unmapped.push(stat);
  }

  if (unmapped.length) {
    // surface, don't silently drop — these are real calls with no home
    this.logger.warn(`${unmapped.length} dialer agents unmapped: ${unmapped.map((u) => u.dialerAgentId).join(', ')}`);
  }
  return mapped;
}
```

The decision that earned its keep: unmapped agents get logged loudly, never dropped silently. Early on I had this swallow anything it couldn't map, and a manager noticed the floor's total call count was lower than what the dialer's own screen showed. The gap was three agents nobody had added to the crosswalk. Silent drops in an integration are how you ship a number that's quietly, unfalsifiably wrong. Now the warning tells me exactly which dialer ids need a row in `dialer_agent_map`, and the agent map itself is cached on the same `cached()` helper with the 30-minute roster TTL.

## Diagnostics for when it's flaky

Because the upstream is the part most likely to break, and it's the part I can't fix, I needed to be able to answer "is it them or is it us" in ten seconds without redeploying. So there's a small diagnostics surface — an admin-only endpoint that does a live probe and reports timing, plus counters that track how often we're serving from cache versus going live.

```ts
async diagnose(): Promise<DialerHealth> {
  const start = Date.now();
  try {
    await this.call<unknown>('/ping');
    return {
      reachable: true,
      latencyMs: Date.now() - start,
      cacheHitRate: this.hits / (this.hits + this.misses || 1),
      lastUpstreamError: this.lastError,
    };
  } catch (err) {
    return {
      reachable: false,
      latencyMs: Date.now() - start,
      cacheHitRate: this.hits / (this.hits + this.misses || 1),
      lastUpstreamError: (err as Error).message,
    };
  }
}
```

The cache hit rate is the number I actually watch. When the dialer is healthy it sits high, because most reads are served from Redis. When it dips, it means either the cache isn't doing its job or something is bypassing it — and either way it points me at the right layer. The `lastUpstreamError` field has saved me more than once from chasing a bug on our side that turned out to be the dialer returning HTML from a misconfigured reverse proxy instead of JSON. You only find that out if you keep the raw error around to look at.

## How I verified it, and where it'll bite

I tested the failure paths harder than the happy path, because the happy path is the one that works on my machine. I stubbed the `HttpService` to return a never-resolving Observable and asserted the call rejected at 8 seconds, not 30. I primed Redis with a known value, made the stubbed upstream throw, and asserted the caller still got the cached number instead of an error — that fallback is the load-bearing behavior, so it gets an explicit test. And I fired a burst of concurrent reads at one key and counted upstream calls; with both cache layers warm it should be exactly one, and the test fails loudly if a cache miss slips through and fans out.

The thing I'd flag for whoever touches this next: there's no negative caching, and that's a real gap. If the dialer is fully down, every cache miss still tries the upstream and eats the full 8-second timeout before falling back. Under a sustained outage with cold caches — say, right after a deploy flushed memory — that's a lot of requests each paying eight seconds to learn the same bad news. The right fix is a short-lived "known unreachable" flag, a circuit breaker that fails fast for thirty seconds after a string of timeouts instead of re-probing on every request. I sketched it, decided the current behavior was tolerable because warm caches absorb most of it, and moved on. That decision is fine right up until the dialer has a bad afternoon and the caches are cold at the same time. When that day comes, the breaker is the first thing I'll wish I'd finished.
