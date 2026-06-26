---
title: "JWT is stateless. Logout isn't. Reconciling the two."
description: "Allowlist vs blocklist, jti, TTLs, and concurrent sessions — the design space for revoking a token you can't un-sign."
date: "2025-12-13"
updated: "2025-12-13"
kind: "deepdive"
category: "Security"
tags: ["jwt", "auth", "redis", "sessions"]
month: "2025-12"
repo: "both"
author: "Sachal Chandio"
---

The thing people sell you on with a JWT is that you never have to look it up. The server signs a payload, hands it back, and from then on every request is verified with a signature check and a glance at the clock. No database round-trip, no session table, no shared state between nodes. That property is the entire pitch.

It is also why logout is hard.

Because the flip side of "I never look it up" is "I can't change my mind about it." Once you've signed a token that's valid for eight hours, it's valid for eight hours — to anyone holding it, from any machine, until `exp` passes. There is no row to flip. "Log this person out," "force a password reset," "kick them off every device," "an admin disabled this account" — every one of those is a request to invalidate a credential you specifically designed to be un-invalidatable. You sold away the ability to revoke in exchange for not having to look things up. Now revocation is the requirement, and you have to buy it back.

This post is the map of how you buy it back, drawn from the session system I built on Telelinkz, a CRM where one login is supposed to equal one rep on one shift. I'll cover the two shapes of the answer, the claim that makes them cheap, the TTL trick that keeps them from rotting, and the concurrency cap that fell out for free — plus the places where each piece is the wrong call.

## The fork: blocklist or allowlist

Every server-side revocation scheme is one of two postures, and they are mirror images.

A **blocklist** (denylist) tracks the tokens you've explicitly killed. The default is *allow*: a token is good unless it's on the list. Logout means adding the token's id to the list. Verification means checking the list and rejecting on a hit.

An **allowlist** (whitelist) tracks the tokens that are currently permitted. The default is *deny*: a token is dead unless it's on the list. Logout means removing the entry. Verification means checking the list and rejecting on a miss.

They sound symmetric. They are not, and the asymmetry is the whole decision.

A blocklist is leaky by construction. Forget to add a token on one of your logout paths — and there are always more logout paths than you think: explicit logout, password change, account disable, the WebSocket handshake — and that token sails straight through. The failure mode of a blocklist is *a credential you meant to kill still works*. For an auth control, that's the failure mode you least want as your default.

An allowlist inverts it. If a token isn't in the store — logged out, expired, evicted, or the store got wiped on a deploy — it's dead. The failure mode is *a credential that should work doesn't*, which is annoying and recoverable (sign in again) rather than silent and dangerous. The safe state is the closed state.

I went allowlist on Telelinkz for exactly that reason. The redis key is the token's id; presence means alive.

```ts
// validate() in the JwtStrategy — Passport already checked the signature and exp
async validate(payload: JwtPayload) {
  if (!payload.jti) {
    throw new UnauthorizedException('Token missing session id');
  }
  const userId = await this.redis.get(`auth:session:${payload.jti}`);
  if (!userId) {
    // not in the allowlist: logged out, expired, evicted — all the same answer
    throw new UnauthorizedException('Session no longer active');
  }
  return { id: userId, role: payload.role, jti: payload.jti };
}
```

Here's where the advice is wrong, though, so I'll say it plainly: the allowlist costs you statelessness. Every authenticated request now does a Redis `GET`. If your reason for choosing JWTs in the first place was "no per-request state," congratulations, you just bought it back at full price — you're running stateful sessions with extra signature math on top. At that point a plain opaque session id in a cookie, looked up in Redis, would do the same job with less ceremony and no footgun about what you put in the payload.

So the honest rule is: if you're going to allowlist *every access token*, ask why you're using JWTs at all. The case where a blocklist genuinely wins is when revocation is rare and you want to keep the no-lookup property on the happy path — you only hit the store on the (uncommon) explicit-revoke check, or better, you only check the blocklist for high-value operations. I didn't have that luxury. On a sales-floor CRM, "log this rep out right now" is a routine, operational request, not a rare security event. Revocation was common, so the cheap-on-the-happy-path argument evaporated, and I wanted the deny-by-default safety more than I wanted the lookup-free read.

## The claim that makes it cheap: jti

Both schemes need a stable handle for a single token. That's the `jti` — the JWT ID claim, RFC 7519, a unique id minted at sign time. Without it you'd key your store on the whole token string (works, but ugly and long) or on the user id (wrong — that revokes *all* of a user's tokens, not one). The `jti` is the right granularity: one id per issued token, and it's the key into Redis.

You mint it when you sign, and you write the store entry in the same breath, so the token and its allowlist entry are born together:

```ts
import { randomUUID } from 'crypto';

async issueToken(user: User): Promise<string> {
  const jti = randomUUID();
  const ttlSeconds = this.tokenTtlSeconds; // same number as JWT expiresIn

  const token = this.jwtService.sign(
    { sub: user.id, role: user.role, jti },
    { expiresIn: ttlSeconds },
  );

  await this.redis.set(`auth:session:${jti}`, user.id, 'EX', ttlSeconds);
  return token;
}
```

A blocklist uses the same `jti` — you'd store the `jti`s of revoked tokens instead of live ones. Either way, the claim is load-bearing. A token with no `jti` is a token you can't talk about individually, and on Telelinkz I refuse those outright in `validate` rather than letting them through. That branch matters in the real world for one boring reason: the moment this shipped, there were valid, signed, unexpired tokens already in the wild with no `jti`. A security control that grandfathers in un-revocable credentials isn't a control. One forced re-login beats an indefinite tail of tokens you can't touch.

## TTL matching is what keeps the store from rotting

This is the detail that turns a clever idea into something you don't have to babysit. The Redis TTL is set to the *same* number of seconds as the JWT's `expiresIn`.

That single line — `'EX', ttlSeconds` where `ttlSeconds` equals the token's lifetime — means I never sweep the store. When a token's `exp` passes, the matching key has already been evicted by Redis at the same instant. The store and the token agree, automatically, on when this session dies. A user who never clicks logout still cleans up after themselves. There's no cron job pruning dead sessions, no slow leak of tombstones, no "why is Redis at 12GB" three months later.

Get this wrong and you get the classic bug: store entries that outlive their tokens (a blocklist that never forgets accumulates forever) or that die before them (an allowlist with a too-short TTL logs people out early for no reason). Match the TTL to `exp` and the whole thing self-heals.

The one place TTL matching doesn't save you is auxiliary indexes. On Telelinkz I keep a second structure — a Redis set of each user's live `jti`s — so I can answer "log me out everywhere" and enforce a session cap:

```ts
await this.redis.sadd(`auth:user_sessions:${user.id}`, jti);
```

A set has no per-member TTL. So when a session key expires on its own, its `jti` lingers in the set as a tombstone, and the set slowly drifts out of sync with the truth. I learned to treat that set as a *hint, never a source of truth*: before trusting it, I check which of its `jti`s still have a live `auth:session` key and `SREM` the rest. The per-session key is the truth; the set is a convenience that needs reconciling. If you add any index alongside your TTL'd keys, you inherit this chore. Plan for it.

## Logout, and its three louder cousins

With the allowlist in place, plain logout is anticlimactic — one delete:

```ts
async logoutCurrent(jti: string): Promise<void> {
  await this.redis.del(`auth:session:${jti}`);
}
```

The next request carrying that token hits `validate`, the `GET` returns `null`, Passport throws a 401. The token is still cryptographically perfect — signature valid, clock fine — and it is nonetheless dead, because the allowlist says so. That gap between "valid signature" and "allowed to exist" is the entire reason the design exists.

The interesting ones are the variations, because they're the requirements people forget until a security review surfaces them:

- **Log me out everywhere** (password change, "sign out all devices") needs *all* of a user's `jti`s. That's what the `auth:user_sessions:<userId>` set is for — `SMEMBERS` it, delete every per-session key, delete the set.
- **Admin disables an account.** Before I built this, deactivating a user did nothing to their live tokens; they kept working until `exp`. Now the same `logoutAll(userId)` fires on disable, and the session ends immediately. This is the one people miss, and it's the one that matters in an audit.
- **The WebSocket door.** GraphQL subscriptions don't pass through the HTTP guard — the token arrives on the connection handshake. If you only check the allowlist for queries and mutations, a logged-out token can hold a live subscription open and keep receiving real-time pushes indefinitely. The subscription guard has to do the same `auth:session:<jti>` lookup on connect. A deadbolt on the front door and an open patio slider is not a locked house.

```ts
async logoutAll(userId: string): Promise<void> {
  const key = `auth:user_sessions:${userId}`;
  const jtis = await this.redis.smembers(key);
  if (jtis.length) {
    await this.redis.del(...jtis.map((j) => `auth:session:${j}`));
  }
  await this.redis.del(key);
}
```

## Concurrency caps fall out for free (and bite you on the way)

The original complaint that started all this wasn't "logout doesn't work." It was concurrency. A rep signs in on the floor PC at 9am, then again on their phone at lunch — two live tokens, one account, and the backend never knew about the first because it never tracked it. For a CRM where a login is a person on a shift, that's how one set of credentials quietly becomes three people on three machines.

Once you have the per-user session set, the cap is the same machinery with a count check:

```ts
async enforceSessionLimit(userId: string): Promise<void> {
  const max = this.config.get<number>('MAX_CONCURRENT_SESSIONS', 0);
  if (max <= 0) return; // 0 = unlimited

  const key = `auth:user_sessions:${userId}`;
  const jtis = await this.redis.smembers(key);
  if (jtis.length < max) return;

  // oldest-out: evict sessions until there's room for the new one
  // ...resolve the N oldest jtis, del their auth:session keys, srem them...
}
```

`MAX_CONCURRENT_SESSIONS=1` is the strict one-login rule the floor wanted: logging in on the phone evicts the PC, and the PC's next request gets a clean 401 and a redirect. `0` is unlimited, which is what I run in staging so QA can keep five tabs open without fighting each other.

This is also where I shipped the naive version and regretted it. The first cut had no per-user set — I implemented `logoutAll` and the cap by scanning the whole keyspace with `SCAN MATCH auth:session:*` and reading each value to find the user's sessions. It worked beautifully on my machine with four keys in Redis. In production it's a quiet disaster: `SCAN` walks every key for every user across the whole instance, the cost grows with total active sessions, and you're doing it on the login hot path. The per-user set replaced an O(all-sessions) scan with an O(this-user's-sessions) `SMEMBERS`. That's the kind of thing that's invisible in dev and pages you at 5pm on a Friday when the floor is full.

## When this whole approach is wrong

A few honest caveats, because "allowlist every token in Redis" is not a universal answer:

You just made Redis load-bearing for auth. If it goes down, every request fails the allowlist check and nobody can use the app. You traded "tokens can't be revoked" for "Redis is a hard dependency on the login path." Defensible for a single-region internal CRM. Not defensible without an availability story, and the moment authorization decisions live behind it, "the cache is just a cache" stops being true. Mine isn't a cache. It's the session store, and I treat it like one now.

If revocation is genuinely rare for you — a public API where users almost never log out mid-token — a blocklist keeps the no-lookup property on the common path and only costs you a check when something's actually revoked. The allowlist's deny-by-default safety is worth most when revocation is routine, like it is for me.

And the shape I'd reach for sooner next time: a short-lived access token (minutes) that I *don't* allowlist at all, paired with a long-lived refresh token that *is* the only revocable thing. You check the store once per refresh instead of once per request, and a stolen access token dies on its own in minutes. I didn't build that first because a single allowlisted token shipped in a day against a live review finding, and correct-enough-now beat elegant-and-pending while un-revocable tokens were in production. But if you're greenfield, start there.

The rules of thumb I'd actually hand someone:

- Pick **allowlist** when revocation is routine and you want deny-by-default. Pick **blocklist** only when revocation is rare and the lookup-free happy path is worth the leaky default.
- Key everything on **`jti`**, and refuse tokens that don't carry one — including the legacy ones, on day one.
- **Match the store TTL to the token's `exp`** so it self-evicts. Any side index you add (per-user sets, etc.) won't inherit that TTL — treat it as a hint and reconcile it against the real keys.
- Enumerate your revocation triggers up front: explicit logout, password change, "all devices," **account disable**, and the **WebSocket handshake**. The last two are the ones that quietly stay open.
- The second your allowlist is mandatory on every request, you've rebuilt server-side sessions. That's fine — just admit it, and don't put secrets in the JWT payload thinking it stays stateless. It doesn't anymore.
