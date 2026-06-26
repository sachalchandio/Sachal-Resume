---
title: "An HTTP interceptor with bearer auth and expiry checks on both sides"
description: "Attaching the token, checking expiry before you send, and storing it encrypted at rest."
date: "2024-08-16"
updated: "2024-08-16"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "interceptors", "auth"]
month: "2024-08"
repo: "frontend"
author: "Sachal Chandio"
---

Every request out of the Telelinkz frontend needs a bearer token on it. Not most requests. Every one — GraphQL queries, mutations, the file uploads to S3, all of it. The naive way to do that is to remember to set a header at every call site, which means you will forget at exactly one call site, and that one will be the endpoint your QA lead hits during a demo.

So the token attachment lives in one place: an Angular `HttpInterceptor`. That part is boring and well-trodden. The interesting parts came later — where the token is stored, what shape it's in when it sits in `localStorage` versus what shape it's in on the wire, and the fact that "is this token still good?" is a question I answer in two completely different places for two completely different reasons.

## The first version was three lines and wrong

Here's roughly what I shipped first. Pull the token, slap it on a header, forward the request.

```ts
intercept(req: HttpRequest<any>, next: HttpHandler) {
  const token = localStorage.getItem('accessToken');
  if (token) {
    req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }
  return next.handle(req);
}
```

This works until someone opens DevTools, clicks the Application tab, and reads the access token straight out of `localStorage` in plaintext. For a CRM where account managers, agents, and admins all share machines on a sales floor, that's not acceptable. I wanted the token encrypted at rest and only decrypted at the moment it goes onto the wire.

Two things follow from that decision. First, reading the token is now asynchronous — decryption returns a promise. An interceptor's `intercept` returns an `Observable`, so I can't just `await` in the middle of it. Second, `setHeaders` in the synchronous version is gone; I have to bridge a promise into the RxJS pipeline.

## Bridging the async read into the observable

The encryption itself is unremarkable — AES via `crypto-js`, keyed off a per-environment salt:

```ts
@Injectable({ providedIn: 'root' })
export class EncryptionService {
  private secretKey = environment.encryptionSalt;

  encrypt(data: any): string {
    return CryptoJS.AES.encrypt(JSON.stringify(data), this.secretKey).toString();
  }

  decrypt(data: string): any {
    const bytes = CryptoJS.AES.decrypt(data, this.secretKey);
    return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
  }
}
```

I'm not pretending this is bank-grade. The salt ships in the bundle, so a determined attacker with the source can reverse it. What it buys me is that the token isn't sitting in plaintext for a shoulder-surfer or a careless screen-share, and that the value in storage isn't a copy-pasteable bearer token. It raises the floor, not the ceiling.

A thin `LocalStorageService` wraps every read and write so nothing else in the app touches `localStorage` directly. The reads are async because the JSON-validate-and-reset logic lives there too — if a value decrypts to garbage, it gets removed rather than thrown:

```ts
async getDecryptedItem<T = any>(key: string): Promise<T | null> {
  const encrypted = localStorage.getItem(key);
  if (!encrypted) return null;
  const decrypted = await this.encryptionService.decrypt(encrypted);
  if (!this.isValidJson(decrypted)) {
    localStorage.removeItem(key); // corrupt value, don't keep serving it
    return null;
  }
  return JSON.parse(decrypted) as T;
}
```

Now the interceptor. I read the token and the user's email in parallel, wrap that `Promise.all` in `from()` to get an observable, and `mergeMap` into the actual request. The token goes out as `Bearer <decrypted>`; the email rides along as `X-User-Email` because a couple of older backend audit paths key off it.

```ts
intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
  return from(
    Promise.all([
      this.localStorageService.getDecryptedItem('accessToken'),
      this.localStorageService.getDecryptedItem('currentUser'),
    ]),
  ).pipe(
    mergeMap(([decryptedToken, currentUser]) => {
      const headers: Record<string, string> = {};
      if (decryptedToken) headers['Authorization'] = `Bearer ${decryptedToken}`;
      if (currentUser) headers['X-User-Email'] = currentUser;
      if (Object.keys(headers).length) {
        request = request.clone({ setHeaders: headers });
      }
      return next.handle(request);
    }),
    catchError((error: any) => {
      if (error.status === 401 || error.error?.message === 'Invalid token') {
        this.localStorageService.removeItem('accessToken');
        this.localStorageService.removeItem('currentUser');
        this.localStorageService.removeItem('userType');
        localStorage.removeItem('loginData');
        localStorage.removeItem('email');
      }
      throw error;
    }),
  );
}
```

The key on disk is encrypted; the header on the wire is plaintext `Bearer`. That's the whole "stored encrypted, sent decrypted" idea in two lines. The decrypt happens once per request, lazily, at the last possible moment.

It's registered as a multi-provider the classic way, since we're still on the DI-based interceptor wiring rather than the functional `HttpInterceptorFn`:

```ts
{ provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true }
```

The `catchError` block matters more than it looks. When the server says 401, the token I'm holding is dead — keeping it around just means the next request also fails, and the one after that. So I evict it. The user lands on login on the next guarded navigation instead of looping through doomed requests with a stale credential.

## Expiry, checked on the client first

A bearer token is a JWT with an `exp` claim. The cheapest possible expiry check is to decode it client-side and compare `exp` against the wall clock. No network, no server, instant. That's the kind of check you want before you even bother sending a request you know is going to bounce.

But — and this is the part I had to be honest with myself about — a client-side expiry check is a courtesy, not a security control. The client's clock can be wrong. The client can lie. The decode reads the payload without verifying the signature, so a tampered token decodes just fine. Client-side `exp` is good for one thing: avoiding a pointless round trip and getting the user to login a beat sooner. It is worth exactly nothing as a guarantee.

So the real check is on the server, and it's deliberately paranoid. The frontend's `AuthGuard` and the `validateToken` path both call a single GraphQL query, `isTokenValid`, with `fetchPolicy: 'network-only'` so it never serves a cached "yes":

```ts
async validateToken(token: string | null): Promise<boolean> {
  const encryptedAccessToken =
    token ?? (await this.localStorageService.getDecryptedItem('accessToken'));
  if (!encryptedAccessToken) return false;

  const result = await firstValueFrom(
    this.isTokenValidGQL.fetch({
      variables: { token: encryptedAccessToken },
      fetchPolicy: 'network-only',
    }),
  );
  return result?.data?.isTokenValid ?? false;
}
```

## What the server actually does with that token

The `isTokenValid` resolver on the NestJS side does the expiry check *and* everything the client can't be trusted to do. It decodes for `exp`, then verifies the signature with the access secret and zero clock tolerance, then — and this is the part a stateless JWT setup skips — checks Redis to confirm the session hasn't been revoked and the user hasn't gone inactive:

```ts
async isTokenValid(token: string): Promise<boolean> {
  try {
    if (token.startsWith('Bearer ')) token = token.slice(7).trim();

    const decoded = this.jwtService.decode(token) as { exp: number };
    if (!decoded || !decoded.exp) return false;

    const now = Math.floor(Date.now() / 1000);
    if (now > decoded.exp) return false; // same exp check, but on a clock I trust

    await this.jwtService.verifyAsync(token, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      clockTolerance: 0, // signature must verify against the real secret
    });

    // Session whitelist: the jti must still map to this user in Redis
    if (this.isSessionWhitelistEnabled()) {
      const d = this.jwtService.decode(token) as { sub?: string; jti?: string };
      if (!d?.sub || !d?.jti) return false;
      const owner = await this.redisCacheService.get(this.getSessionKey(d.jti));
      if (!owner || owner !== d.sub) return false;
    }

    return true;
  } catch {
    return false;
  }
}
```

The same logical question — "is this token still good?" — gets a different answer depending on who's asking. The client decodes `exp` to save a round trip. The server decodes `exp` *and* verifies the signature *and* checks that the token's `jti` is still whitelisted in Redis, because a token can be cryptographically valid and 10 hours from expiry and still need to be dead — somebody got fired, an admin force-logged-out every session, the user idled past the inactivity window. `exp` alone can't express any of that. The whitelist can.

## RBAC behind it

Authentication answers "is this a real, live session." It says nothing about "is this person allowed to call *this*." That's a separate guard, driven by metadata on the resolver. The passport JWT guard runs first and attaches `req.user`; then a `RolesGuard` reads the `@Roles(...)` metadata off the handler and checks the user's `userType` against it:

```ts
async canActivate(context: ExecutionContext): Promise<boolean> {
  const roles = this.reflector.get<string[]>('roles', context.getHandler());
  if (!roles) return true; // unrestricted handler

  const ctx = GqlExecutionContext.create(context);
  const { user } = ctx.getContext().req;
  if (!user) throw new ForbiddenException('No user found');

  const validUser = await this.usersService.findUserByEmail(user.email);
  if (!validUser || !roles.includes(validUser.userType)) {
    throw new ForbiddenException(
      `Access denied: Requires one of the following roles: ${roles.join(', ')}`,
    );
  }
  return true;
}
```

Two details I'd flag. It re-fetches the user from the database by email rather than trusting the role baked into the JWT — so if an admin demotes someone mid-session, the demotion takes effect on the next request, not whenever their 10-hour token finally expires. And the frontend route guard mirrors the same `expectedUserType` check before navigation, so an agent who types `/admin-only` into the URL bar gets redirected to `/unauthorized` without ever rendering the page. The frontend check is UX; the backend check is the one that counts. If they ever disagree, the server wins, every time.

## What I'd change

Two things bug me. The encryption salt lives in the environment bundle, which means the at-rest encryption is obfuscation with a straight face, not real protection — short-lived tokens and the server-side revocation check are doing the actual security work, and I should stop pretending otherwise in code review. And the interceptor decrypts on *every single request*; under a burst of parallel GraphQL calls that's a lot of redundant AES work on the main thread. A small in-memory cache of the decrypted token, invalidated the moment `setToken` or `clearTokens` runs, would kill that without weakening anything — the encrypted copy still owns the disk.

The thing I got right was refusing to let the client's answer to "is this token valid" mean anything. It decodes `exp` to be polite. The server decodes `exp`, verifies the signature, and asks Redis whether the session is still alive — and that last question is the only one I'd defend in front of a security review.
