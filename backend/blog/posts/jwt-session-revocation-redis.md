---
title: "Real JWT logout: Redis-backed session whitelisting with jti"
description: "Stateless tokens can't be revoked — unless you keep a server-side allowlist. Single-session and logout-everywhere with Redis."
date: "2025-12-12"
updated: "2025-12-12"
kind: "deepdive"
category: "Security"
tags: ["jwt", "redis", "auth", "nestjs"]
month: "2025-12"
repo: "backend"
author: "Sachal Chandio"
---

Logout did nothing. That was the uncomfortable thing I had to admit out loud in a security review.

The client cleared the token from `localStorage`, the UI dropped you back to the login screen, and everyone felt fine about it. But the token itself was still a perfectly valid bearer credential. Anyone who'd grabbed it off the wire, out of a logged browser, or out of a shared machine could keep calling the API until the `exp` claim ran out. For us that was an eight-hour window. "Log out" was a front-end animation, not a server-side fact.

The second half of the problem was concurrency. A rep signs in on the floor PC in the morning, then signs in again on their phone at lunch. Now there are two live tokens for one account and the backend has no idea — it never tracked the first one, so it can't end it when the second appears. For a CRM where one login equals one person on one shift, that's not a hypothetical. It's how a single set of credentials quietly becomes three people on three machines.

Both problems have the same root: a JWT is stateless by design. The server signs it, hands it over, and then verifies it on each request using nothing but the signature and the clock. There's no row to flip, no session to kill. That's the whole selling point — and it's exactly what makes "revoke this token right now" impossible without changing the deal.

## The deal I changed

The standard move here is some flavor of token list. A denylist (track the tokens you've explicitly killed) or an allowlist (track the tokens that are currently allowed, reject everything else). I went with an allowlist — a session whitelist — and the reasoning matters.

A denylist only knows about tokens you've actively revoked. It's leaky by default: forget to add a token to the blocklist and it sails through. It also grows with every logout and you have to keep each entry until the token would have expired anyway, so you're storing garbage either way. An allowlist inverts the default to *deny*. If a token isn't in the store, it's dead — expired, logged out, evicted, server wiped, doesn't matter. The safe state is the closed state. For an auth control I want the failure mode to be "reject," not "allow."

The cost is real and I want to name it: I gave up pure statelessness. Every authenticated request now does a Redis lookup. I decided a single `GET` on the hot path was an acceptable price for being able to actually end a session, and in practice it's sub-millisecond next to the database work every resolver does anyway. If that lookup is your bottleneck, you have nicer problems than I do.

The piece that makes the allowlist cheap to maintain is the `jti` — the JWT ID claim. Every token gets a unique id at sign time, and that id is the key into Redis.

## Putting a jti on every token

The login service used to sign a payload of `{ sub, role, ... }` and call it a day. I added a `jti` and started writing the session record at the same moment I mint the token, so the token and its allowlist entry are born together:

```ts
import { randomUUID } from 'crypto';

async issueToken(user: User): Promise<string> {
  const jti = randomUUID();
  const ttlSeconds = this.tokenTtlSeconds; // matches JWT expiresIn

  const token = this.jwtService.sign(
    { sub: user.id, role: user.role, jti },
    { expiresIn: ttlSeconds },
  );

  // auth:session:<jti> -> userId, expiring exactly when the token does
  await this.redis.set(`auth:session:${jti}`, user.id, 'EX', ttlSeconds);

  return token;
}
```

Two details that aren't accidental.

The Redis TTL is set to the same number of seconds as the JWT's `expiresIn`. That's what stops the allowlist from becoming a landfill. I never have to sweep expired sessions — Redis evicts the key at the exact moment the token would have stopped verifying anyway. The store and the token agree on when this session dies, automatically. A logout that never happens still cleans up after itself.

The value is the `userId`, not just a `1` or a tombstone. That turns the session key into something I can actually use — given a `jti` I know whose session it is, and I'll need that for the "log me out everywhere" path in a minute.

## Enforcing it on the way in

The allowlist is useless unless something checks it on every request. In NestJS that's the `JwtStrategy`. Passport already verifies the signature and expiry for me before `validate` ever runs; my job in `validate` is to add the one question the signature can't answer — *is this specific token still allowed to exist?*

```ts
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    if (!payload.jti) {
      // pre-jti token, minted before this shipped — refuse it
      throw new UnauthorizedException('Token missing session id');
    }

    const userId = await this.redis.get(`auth:session:${payload.jti}`);
    if (!userId) {
      // not in the allowlist: logged out, expired, or evicted
      throw new UnauthorizedException('Session no longer active');
    }

    return { id: userId, role: payload.role, jti: payload.jti };
  }
}
```

The `!payload.jti` branch is there because of migration reality. The instant this deployed, there were valid, signed, unexpired tokens in the wild that predated the feature and had no `jti`. I refused them. That forces a fresh login for everyone holding an old token — harsh-sounding, but correct for a security change. A token I can't track is a token I can't revoke, so it doesn't get to be special. One day of "sign in again" beats an indefinite tail of un-revocable credentials.

The other place that has to enforce this is the WebSocket layer. GraphQL subscriptions don't go through the same HTTP guard — the token comes in on the connection handshake, and if I only checked the allowlist for queries and mutations, a logged-out token could keep a live subscription open and keep receiving real-time pushes forever. So the subscription guard does the same `auth:session:<jti>` lookup on connect. Miss that path and you've built a front door with a deadbolt and left the patio slider wide open.

## Logout that actually logs out

With the allowlist in place, logout stops being a client-side gesture and becomes a one-line delete. Kill the key, kill the token:

```ts
async logoutCurrent(jti: string): Promise<void> {
  await this.redis.del(`auth:session:${jti}`);
}
```

That's the whole thing. The next request carrying that token hits `validate`, the `GET` returns `null`, and Passport throws a 401. The token is still cryptographically valid — the signature checks out, the clock's fine — and it is nonetheless dead, because the allowlist says so. That gap between "valid signature" and "allowed to be used" is the entire point of the design.

"Log out everywhere" needed a way to find *all* of a user's sessions, not just the one in your hand. This is where storing `userId` as the value pays off, but it doesn't get me all the way there on its own — Redis can match keys by pattern, but it can't query keys by value. So alongside the per-session key I keep a set of the user's live `jti`s:

```ts
async issueToken(user: User): Promise<string> {
  // ...mint token, set auth:session:<jti> as before...
  await this.redis.sadd(`auth:user_sessions:${user.id}`, jti);
  return token;
}

async logoutAll(userId: string): Promise<void> {
  const key = `auth:user_sessions:${userId}`;
  const jtis = await this.redis.smembers(key);
  if (jtis.length) {
    await this.redis.del(...jtis.map((j) => `auth:session:${j}`));
  }
  await this.redis.del(key);
}
```

`logoutAll` is what fires on a password change, on a "sign out of all devices" button, and — this turned out to matter — when an admin disables an account. Before this, deactivating a user did nothing to their live tokens; they kept working until expiry. Now disabling an account ends every session they have, immediately.

## Single-session, and the cleanup it dragged in

The original concurrency complaint — second login should end the first — falls out of the same machinery, gated behind a config flag so I could tune it per environment:

```ts
async enforceSessionLimit(userId: string): Promise<void> {
  const max = this.config.get<number>('MAX_CONCURRENT_SESSIONS', 0);
  if (max <= 0) return; // 0 = unlimited

  const key = `auth:user_sessions:${userId}`;
  const jtis = await this.redis.smembers(key);
  if (jtis.length < max) return;

  // oldest-out: evict sessions until there's room for the new one
  const overflow = jtis.length - max + 1;
  // ...resolve the N oldest jtis and del their auth:session keys + srem them...
}
```

`MAX_CONCURRENT_SESSIONS=1` is the strict one-login-per-account rule the floor wanted. Logging in on the phone evicts the floor PC's session, and the next request from that PC gets a clean 401 and a redirect to login. Set it to `0` and it's unlimited, which is what I run in staging so QA can have five tabs open without fighting each other.

This is also where I hit the sharp edge. The naive version I shipped first didn't have the `auth:user_sessions:<userId>` set — I tried to do `logoutAll` and the session limit by scanning keys with `SCAN MATCH auth:session:*` and reading each value to find the user's. It worked on my machine with four sessions in Redis. It is a genuinely bad idea in production: `SCAN` walks the entire keyspace, the cost grows with total active sessions across all users, and you're doing it on the login hot path. The set was the fix — `SMEMBERS` on one key gives me exactly this user's sessions, no scan, no reading values I don't need.

The set brought its own bug, though, and it's the kind I'd warn anyone copying this about. The per-session key (`auth:session:<jti>`) expires on its own TTL. The membership in the set (`auth:user_sessions:<userId>`) does not — a set has no per-member expiry. So when a token times out naturally, its session key vanishes but its `jti` lingers in the set as a tombstone. Left alone, the set fills with dead ids, `enforceSessionLimit` over-counts, and a user who actually has one live session gets told they've hit the limit because the set still remembers four expired ones. The membership and the truth drift apart, exactly the failure mode I've been bitten by before with Redis indexes.

So `logoutAll`, `enforceSessionLimit`, and login all reconcile: before trusting the set, I check which of its `jti`s still have a live `auth:session` key and `SREM` the ones that don't. The set is treated as a hint to be verified, never as the source of truth. The source of truth is always whether the individual session key still exists.

## What I'd do differently

I'd reach for the refresh-token split sooner. Right now one access token does an eight-hour shift, which means a Redis lookup on every single request and a fairly long-lived credential. The cleaner shape is a short access token (minutes) that I don't bother allowlisting at all, plus a long-lived refresh token that *is* in Redis and is the only thing you can revoke. You check the allowlist once per refresh instead of once per request, and a stolen access token dies in minutes on its own. I didn't build that first because the single-token allowlist was simpler to reason about and shipped in a day against a real review finding — correct-enough beat elegant-and-pending while un-revocable tokens were live in production.

The other thing I underweighted: Redis is now load-bearing for auth. If it goes down, every request fails the allowlist check and nobody can use the app — I traded "tokens can't be revoked" for "Redis is a hard dependency on the login path." That's a defensible trade for a single-region internal CRM. It would not be defensible without a story for Redis availability, and "the cache is just a cache" stops being true the moment you put authorization decisions behind it. Mine isn't a cache anymore. It's the session store, and I should treat it like one.
