---
title: "Mixing Redis SET and HASH: the pause-tracking bug that inflated everyone's break time"
description: "Adding agents with HSET but removing them with DEL left stale pause state. A lesson in picking one Redis structure."
date: "2025-12-04"
updated: "2025-12-04"
kind: "deepdive"
category: "Real-time"
tags: ["redis", "distributed-systems", "state"]
month: "2025-12"
repo: "backend"
author: "Sachal Chandio"
---

A floor manager pinged me with a screenshot of the live agent board. Three agents showed a little orange "on break" pill. The problem: two of them were on calls. I could see them on calls. The dialer said they were on calls. The board insisted they'd been on break for forty minutes.

That's the kind of bug that erodes trust in a whole feature. Once a manager catches the break tracker lying once, every number it produces is suspect. And the numbers feed a daily efficiency report — active time over shift time — so a stuck "on break" flag wasn't just a wrong pill on a dashboard. It was dragging down a metric people get measured on.

## The shape of the system

The pause tracker keeps live agent state in Redis and a durable copy in MySQL. The MySQL side is the system of record: `shift_session`, `pause_session`, `daily_pause_summary`. Redis is the hot path — the floor board polls and subscribes for real-time status, and hitting the database for every tick of a dozen running timers would be silly.

For each agent there's a JSON blob under a per-agent key:

```ts
const AGENT_STATUS_KEY = (agentId: string) => `pause:agent:${agentId}`;
```

That part was never the problem. The blob round-trips cleanly: `setex` with a 24h TTL on write, `JSON.parse` on read. The problem lived in the two *index* keys — the ones that answer "who is currently working?" and "who is currently on break?" without me having to scan every agent key in the keyspace.

```ts
const ACTIVE_AGENTS_SET = `pause:active_agents`;
const PAUSED_AGENTS_SET = `pause:paused_agents`;
```

Read those names again, because they're the whole bug in miniature. They say `SET`. They are not sets. They're hashes. Those constants are named after the data structure I *originally* reached for, and the names outlived the decision. That's foreshadowing.

## The wrong guess

My first theory was a race. Real-time state plus pub/sub plus a couple of Bull jobs sweeping in the background — the obvious suspect when state goes stale is two writers stepping on each other. An agent ends a break at the same instant the inactivity sweeper decides they're idle, and the writes interleave so the "remove from paused" loses.

I spent a good hour on that theory. Added logging around `endPause`, watched two agents reproduce it on staging. The logs were inconvenient for my hypothesis: there was no concurrent write. `endPause` ran start to finish, alone, logged `Pause ended for agent ... (212s, type: BREAK)`, and the agent was *still* in the paused index afterward. No race. The single, uncontended code path was leaving the index dirty by itself.

So I stopped theorizing and went and looked at how an agent got *into* the paused index versus how they got *out*.

## The root cause

Here's the asymmetry, reconstructed from what the code was doing back then. Starting a pause added the agent to the index as a hash field — agent id to pause type:

```ts
// startPause: add to the paused index
await this.redis.hset('pause:paused_agents', { [agentId]: pauseType });
```

That's a `HSET`: one field inside one hash key. The hash holds every paused agent as a field. Good.

Ending a pause was supposed to undo exactly that. It did this instead:

```ts
// endPause: "remove" from the paused index  — WRONG
await this.redis.del(`pause:paused_agents:${agentId}`);
```

Look at the key. `HSET` wrote a field named `<agentId>` *inside* the key `pause:paused_agents`. The "remove" did a `DEL` on a *different, made-up* key — `pause:paused_agents:<agentId>` — that never existed. `DEL` on a non-existent key returns `0` and does nothing, cheerfully, no error. The agent's field stayed in the real hash forever.

It's the classic mismatch you get when you stop thinking in terms of the actual structure. With a hash, the field lives *inside* one key and you remove it with `HDEL key field`. The buggy line treated the structure like a bag of top-level string keys — one key per agent, blow it away with `DEL` — which is how you'd model this with `SET`/`GET` on individual keys, or with a real Redis SET via `SADD`/`SREM`. The mental model was "set of paused agents." The implementation on the write side was a hash. The two never agreed, and the remove fell through the gap.

So every break an agent ever took left a tombstone in `pause:paused_agents`. The floor board reads that hash to decide who shows the orange pill. Stale fields meant phantom breaks. And because the per-agent JSON blob (the source of the duration math) had a 24h TTL but these index entries were written with no expiry, the index would actually outlive the real state — the blob would quietly expire and the index would still be insisting the agent was on break. Restart Redis mid-shift and it got worse: nothing reconciled the in-memory truth back against the index at all.

The inflated break-time numbers came from the same root, one layer up. The reporting rollup and some of the live aggregation trusted "is this agent currently paused?" as a gate. An agent stuck in the paused index kept accruing against a pause that, in reality, had ended minutes ago.

## The fix

Two parts. First, make remove the exact inverse of add. Stop pretending the hash is a pile of string keys.

```ts
// before — DEL on a key that was never written
await this.redis.del(`pause:paused_agents:${agentId}`);

// after — HDEL the field out of the one hash key
await this.redis.hdel('pause:paused_agents', agentId);
```

That `hdel` wrapper is a thin pass-through to `client.hdel(key, field)`. One key, one field removed. `endPause`, `forceEndPause`, and the shift-teardown path all route through the same removal now, so there's exactly one way an agent leaves the paused index and it matches the one way they enter it.

I also stopped writing two structures for one question. Active and paused were two separate hashes, which meant two writes to keep consistent on every transition and two ways to drift. I collapsed `active`/`paused` into the per-agent state plus a single `active_agents` hash, and let the agent's `shiftStatus` inside the JSON blob be the source of truth for *which* of active/paused/different-station they're in. The index answers one question — "is this agent on the floor at all?" — and the blob answers the rest. Fewer keys, fewer ways to disagree. The constant is still named `ACTIVE_AGENTS_SET`; renaming it touches more than I wanted in that change, and the lie is at least now a small one. (I owe it a rename.)

Second — and this is the part that actually lets me sleep — assume the index *will* drift anyway and reconcile it. Redis is a cache here, not the truth. So there's a cleanup pass, run on a Bull schedule, that walks the candidate active agents, pulls the durable state, and ends anything that's obviously wrong:

```ts
async cleanupStaleSessions(maxShiftHours = 14): Promise<number> {
  const now = new Date();
  const maxShiftMs = maxShiftHours * 3_600_000;
  let cleaned = 0;

  for (const agentId of await this.getCandidateActiveAgentIds()) {
    const state = await this.getOrRestoreAgentRedisState(agentId);
    if (!state?.shiftStartTime) continue;

    const elapsed = now.getTime() - new Date(state.shiftStartTime).getTime();
    if (elapsed > maxShiftMs) {
      // browser crash, closed laptop, forgotten logout — end it, don't trust the flag
      if (await this.endShiftSilent(agentId, `stale session (>${maxShiftHours}h)`)) cleaned++;
    }
  }
  return cleaned;
}
```

`getOrRestoreAgentRedisState` is the other half of the safety net: if the blob is gone from Redis (expired, or wiped by a restart) but MySQL still has an open shift, it rebuilds the Redis state from the database before anyone reads it. On boot, `onModuleInit` does the same sweep across all open shifts. So a mid-shift Redis restart now self-heals instead of stranding everyone's timers.

There's a sibling job, `checkInactiveAgents`, that auto-logs-out agents who've gone quiet for thirty minutes — but, importantly, it skips anyone whose `shiftStatus` is `ON_PAUSE` or `ON_DIFFERENT_STATION`. A paused agent isn't idle, they're on a break. Getting that exclusion wrong would have been a fresh way to corrupt the very numbers I was trying to fix, so the inactivity gate reads the same single source of truth — the blob's `shiftStatus` — rather than re-deriving "are they paused?" from the index it's meant to be policing.

## What I'd carry to the next one

Pick one Redis structure per concept and let the operations follow from it, not the other way around. The bug wasn't a typo, it was a category error: the *write* committed to a hash and the *read/remove* still thought in sets. `HSET` to add, `DEL` to remove — those don't even live in the same data model. Once the structure drifts from the operations, Redis won't warn you. `DEL` on a missing key returns `0` and a clear conscience.

The tell I'll watch for next time: a key whose *name* describes a different structure than the commands touching it. `pause:paused_agents` called itself a set and got written like a hash. That naming smell was sitting there in plain sight the whole time, and it was a more honest bug report than any log line I added.

And the broader habit, the one that outlasts this specific feature — if you're caching distributed state in Redis, write the reconciler before you need it. Not because your add/remove logic is wrong (though here it was), but because processes restart, keys expire, TTLs race each other, and networks drop writes. The version of this feature that's bitten me is always the one that assumed the cache and the database could never disagree. They can, they will, and the only question is whether something is scheduled to notice.
