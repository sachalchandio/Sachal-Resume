---
title: "Adding a role tier without breaking auth"
description: "New roles, route metadata, guards, async-pipe gating, and per-item checks — extending RBAC without a rewrite."
date: "2026-05-03"
updated: "2026-05-03"
kind: "deepdive"
category: "Security"
tags: ["rbac", "authz", "angular", "nestjs"]
month: "2026-05"
repo: "both"
author: "Sachal Chandio"
---

Telelinkz did not start with QA managers, retention agents, billing managers, and medical billers. It started with four roles — admin, manager, QA, agent — and a year of "can you also give the X team access to Y" requests turned that into ten. Every one of those requests is a small invitation to break authorization for the nine roles that already existed. The thing that kept it from turning into a pile of `if (user.type === 'A' || user.type === 'B' || ...)` scattered across forty resolvers was a rule I made early and kept: access is *declared*, not *coded*. The declaration lives next to the thing it protects, and exactly one place reads it.

That sounds tidy in a sentence. The interesting part is the seams — where the tidy model leaks, where I cheated, and the bug that taught me a bulk check and a per-item check are not the same thing.

## The backend: one guard, metadata, and a fresh DB read

On the NestJS side every protected resolver field gets a decorator that does two things at once — attaches the allowed roles as metadata and wires up the guards:

```ts
export function Roles(...roles: string[]) {
  return applyDecorators(
    SetMetadata('roles', roles),
    UseGuards(GqlAuthGuard, RolesGuard),
  );
}
```

So a resolver reads like a sentence: `@Roles(UserType.ADMIN, UserType.MANAGER, UserType.QA_MANAGER)`. The roles are *data*. The guard is the only code that interprets them:

```ts
async canActivate(context: ExecutionContext): Promise<boolean> {
  const roles = this.reflector.get<string[]>('roles', context.getHandler());
  if (!roles) return true; // no decorator → not role-gated

  const ctx = GqlExecutionContext.create(context);
  const user = ctx.getContext().req.user;
  if (!user) throw new ForbiddenException('No user found');

  // deliberately re-fetch, don't trust the JWT's stale userType
  const validUser = await this.usersService.findUserByEmail(user.email);
  if (!validUser || !roles.includes(validUser.userType)) {
    throw new ForbiddenException(
      `Access denied: Requires one of the following roles: ${roles.join(', ')}`,
    );
  }
  return true;
}
```

When I add `QA_MANAGER`, I add the enum value and then sprinkle it into the `@Roles(...)` lists that should now include it. No guard change. No new guard. The guard never knew the old roles and it doesn't need to know the new one — it just asks "is this user's type in the list the resolver declared?"

Two decisions in there are worth defending because both have a cost.

The guard re-reads the user from the database on every call instead of trusting `userType` off the JWT. That's an extra query per protected field. I keep it anyway, because a JWT is a snapshot from login and roles change while people are logged in — somebody gets promoted to QA manager at 2pm and I do not want them stuck with agent permissions until their token expires, and worse, I do not want a *demoted* user keeping elevated access for the life of their token. The DB is the source of truth for "what can you do right now." If that query ever shows up in a profiler I'll cache it in Redis with a short TTL and a bust-on-role-change, but it hasn't, so I haven't.

The roles are plain strings via `SetMetadata('roles', ...)`, not a typed symbol. That's a wart. A typo like `@Roles('QA_MANGER')` compiles fine and silently locks everyone out of that field, and you find out from a support ticket, not the compiler. I get away with it because the `UserType` enum is the argument I pass, so `@Roles(UserType.QA_MANAGER)` is checked — the looseness is only at the metadata layer. If I were starting over I'd make the decorator generic over the enum.

## The frontend: route data, one guard, and the async pipe

Angular mirrors the same idea. A route declares who may enter via `data`, and `AuthGuard` is the single reader:

```ts
{
  path: 'frontier',
  loadChildren: () => import('./modules/providers/frontier/frontier.module')
    .then((m) => m.FrontierModule),
  canActivate: [AuthGuard],
  data: {
    moduleName: 'frontier',
    expectedUserType: INTERNET_PROVIDER_ACCESS_USER_TYPES,
  },
}
```

The win is that `expectedUserType` is a *named constant*, not an inline array. There are roughly two dozen internet-provider routes — Spectrum, Frontier, AT&T, Xfinity, on and on — and they all point at the same `INTERNET_PROVIDER_ACCESS_USER_TYPES`. When retention agents needed access to those providers, I added two roles to one array and all two dozen routes updated at once:

```ts
export const INTERNET_PROVIDER_ACCESS_USER_TYPES: UserType[] = [
  UserType.Admin,
  UserType.Manager,
  UserType.Agent,
  UserType.QaManager,
  ...RETENTION_USER_TYPES, // CUSTOMER_RETENTION + CUSTOMER_RETENTION_MANAGER
];
```

The guard itself is dull, which is the point. It validates the token, fetches the current user type, and asks one question:

```ts
const expectedUserType: UserType[] | undefined = route.data['expectedUserType'];
// ...token checks elided...
if (!expectedUserType || matchesExpectedUserType(userType, expectedUserType)) {
  return true;
}
return this.redirectToUnauthorized(state);
```

Note `!expectedUserType` returns `true` — a route with no `expectedUserType` is open to any authenticated user. That's a deliberate default but it's also the kind of default that bites you: forget the `data` block on a sensitive new route and it's wide open to every logged-in account. I've started treating a missing `expectedUserType` on anything non-trivial as a review smell.

### Gate the UI with the async pipe, not a snapshot

Route guards stop people from *navigating* somewhere. They do nothing for the button that shouldn't render. For that I gate templates on an observable through the async pipe rather than reading a value once in `ngOnInit`:

```html
<button *ngIf="canManageBilling$ | async" (click)="openBillingPanel()">
  Billing actions
</button>
```

The reason is subtle and I learned it the annoying way. If you snapshot `this.userType` in the constructor, you've captured whatever was true at component creation. The user's role can resolve *after* that — auth state streams in, a refresh lands, the session service updates — and your snapshot is now a lie that never corrects itself until the component is destroyed. The async pipe re-evaluates on every emission and Angular tears down the subscription for you. No stale flag, no manual `unsubscribe`.

The thing to be honest about: **none of this UI gating is security.** Hiding the billing button is a courtesy so people don't click things that'll 403. The actual enforcement is the `@Roles(...)` guard on the server. If the only thing standing between a user and an action is an `*ngIf`, you have a hole, because the network tab exists. Treat frontend gating as ergonomics and the backend guard as the wall.

## Where role lists stop being enough

Two cases broke the "user is in the allowed list" model, and both are worth knowing because they're where new roles actually hurt.

**The retention special case.** When customer retention came along, those roles weren't even in the generated GraphQL `UserType` enum yet — the backend had them, the codegen lagged. So they live as cast constants on the frontend:

```ts
export const CUSTOMER_RETENTION = 'CUSTOMER_RETENTION' as UserType;
```

and `matchesExpectedUserType` does something I'm not proud of but would do again under deadline:

```ts
export function matchesExpectedUserType(
  userType: UserType | null | undefined,
  expectedUserTypes: readonly UserType[] | undefined,
): boolean {
  if (!userType || !expectedUserTypes?.length) return false;
  if (expectedUserTypes.includes(userType)) return true;

  // retention users inherit QA's route access without editing 30 route configs
  return isCustomerRetentionUserType(userType)
    && expectedUserTypes.includes(UserType.Qa);
}
```

A retention user matches any route that allows QA. That let me ship retention access without touching thirty `data` blocks. The cost is a piece of policy that lives in a guard helper instead of in the route declaration, which is exactly the thing this whole architecture was supposed to avoid. It's a documented exception, not a pattern — and the moment a *second* role wanted that kind of inheritance, that's my signal to build a real role hierarchy instead of bolting on another `||`.

**Per-item checks, not one bulk check.** This is the bug that changed how I think about authorization. The role lists answer "may this user use this *feature*." They do not answer "may this user touch this *specific row*." Opening a user profile is the clean example:

```ts
export function canOpenProfile(
  targetUserId: string | null | undefined,
  currentUserId: string | null | undefined,
  isPrivileged: boolean,
): boolean {
  const target = String(targetUserId ?? '').trim();
  if (!target) return false;
  if (isPrivileged) return true;            // admin/manager → anyone
  const current = String(currentUserId ?? '').trim();
  return current.length > 0 && current === target; // else only yourself
}
```

A QA user is "allowed to view profiles" as a feature. Whose profile is a different question, answered per target. The disaster shape is when those two collapse into one: you check the feature once at the top of a bulk operation — "yes, this user may delete files" — and then loop over a list of ids the caller handed you and delete every one, including the rows that belonged to someone else. The single up-front check passed. The per-row check never happened. A new role makes this worse, not better, because each tier you add widens the set of "allowed to use the feature" users who can now reach rows that aren't theirs. When an operation takes a *set* of ids, the authorization has to run inside the loop, on each id, and return a partial result — not run once and trust the set.

## What I'd tell myself before role number eleven

Declare access as data and read it in one place — the `@Roles(...)` decorator on the backend, `data.expectedUserType` on the frontend. Adding a tier should be editing lists, never writing branching logic.

Name your role groups. `INTERNET_PROVIDER_ACCESS_USER_TYPES` updating two dozen routes from one edit is the entire payoff. Inline arrays are how you end up missing the twenty-third route.

Re-read the user's role from the source of truth at check time. A JWT's `userType` is a claim from login, and roles outlive the claim.

Gate UI with the async pipe so it tracks the role as it actually resolves, and never mistake that gating for enforcement — the wall is the server guard.

And the one that actually cost me: a feature check is not a row check. The bigger your role table grows, the more users pass the feature check, and the more it matters that the per-item check still runs on every id in the batch. The day "is this user allowed to do this" and "is this user allowed to do this *to this thing*" became the same line of code is the day something got deleted that shouldn't have.
