---
title: "Role-based routing via route data, not twenty guards"
description: "New user types shouldn't mean editing every guard. Declaring access on the route and checking it once."
date: "2026-05-23"
updated: "2026-05-23"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "routing", "guards", "rbac"]
month: "2026-05"
repo: "frontend"
author: "Sachal Chandio"
---

The ticket said "add a Retention team and a QA Manager role." Two new user types. Sounds like an afternoon.

Then I opened the routing module and remembered how the access control worked. Every protected route pointed at its own guard, and each guard had a hard-coded list of who was allowed in. `AdminGuard`. `ManagerGuard`. A few `canActivate` functions that inlined `if (userType === 'AGENT' || userType === 'MANAGER')`. To add two roles I'd have to find every one of those checks and edit it, get every list right, and hope I didn't miss the one provider route that nobody had touched in a year. With around thirty provider modules plus the analytics and audit screens, "every one of those checks" was a real number, not a figure of speech.

So I didn't do that. I moved the decision out of the guards and onto the routes themselves.

## The shape of the idea

A route already carries a `data` bag. Angular hands it to you in the `ActivatedRouteSnapshot`. That bag is the natural place to say *who is allowed here*, because it lives right next to the thing it describes — the route. The guard stops being "the Admin guard" and becomes "the guard that reads the rule and enforces it." One guard. The rule is data.

```ts
{
  path: 'task-analytics',
  loadComponent: () => import('...').then((m) => m.TaskAnalyticsComponent),
  canActivate: [AuthGuard],
  data: {
    expectedUserType: [UserType.Admin, UserType.Manager],
  },
}
```

`expectedUserType` is an array of `UserType` enum values. The guard reads it and compares it against the logged-in user's type. If the array is missing, the route is open to anyone who is authenticated. That default matters — most of the app is reachable by every internal role, and I didn't want to annotate two hundred routes just to say "yes, everyone."

Adding the Retention role becomes: append it to the arrays of the routes Retention should see. No new guard class. No new `canActivate` function. A data change.

## The one guard

Here's the relevant part of `AuthGuard`. It does the session and token work first — that's not the interesting bit — and then reads the route's expectation.

```ts
async canActivate(
  route: ActivatedRouteSnapshot,
  state: RouterStateSnapshot,
): Promise<boolean | UrlTree> {
  const expectedUserType: UserType[] | undefined = route.data['expectedUserType'];

  const accessToken = await this.authService.getAccessToken();
  if (!accessToken) return this.redirectToLogin(state);

  const isValid = await this.authService.validateToken(accessToken);
  if (!isValid) return this.redirectToLogin(state);

  const userType = await this.authService.getCurrentUserType();

  if (!expectedUserType || matchesExpectedUserType(userType, expectedUserType)) {
    return true;
  }

  return this.redirectToUnauthorized(state);
}
```

Two outcomes that matter: a missing `expectedUserType` means "authenticated is enough," and a present one means "your type has to be in the list." When it isn't, the guard returns a `UrlTree` to `/unauthorized` with the attempted URL as a query param, instead of returning `false` and dumping the user on a blank page. Returning a `UrlTree` is the Angular-blessed way to redirect from a guard, and it keeps the address bar honest.

The actual comparison lives in a small pure function rather than inline in the guard, and that turned out to be the most useful decision in the whole change:

```ts
export function matchesExpectedUserType(
  userType: UserType | null | undefined,
  expectedUserTypes: readonly UserType[] | undefined,
): boolean {
  if (!userType || !expectedUserTypes || expectedUserTypes.length === 0) {
    return false;
  }

  if (expectedUserTypes.includes(userType)) {
    return true;
  }

  // Retention users inherit everything a QA user can see.
  return (
    isCustomerRetentionUserType(userType) &&
    expectedUserTypes.includes(UserType.Qa)
  );
}
```

Notice the last clause. Retention came in as a near-clone of QA permissions — wherever a QA user was allowed, Retention should be too. The naive version of this would have been to crawl every route and add the two Retention types alongside every `UserType.Qa`. I started doing exactly that, got about ten routes deep, and stopped. Inheritance belongs in one place, not sprayed across thirty route definitions. So Retention is treated as "QA, plus its own explicit grants," and that rule lives in `matchesExpectedUserType` and nowhere else. When the product owner later asked whether Retention could see one screen QA couldn't, the explicit grant went on that route's array and the inheritance handled the rest.

I keep the role constants in a `user-type-extensions.ts` file so the routing module imports names, not magic strings:

```ts
export const INTERNET_PROVIDER_ACCESS_USER_TYPES: UserType[] = [
  UserType.Admin,
  UserType.Manager,
  UserType.Agent,
  UserType.QaManager,
  ...RETENTION_USER_TYPES,
];
```

Most provider routes just spread that constant into their `data`. The xfinity route and the atnt route and the twenty-odd others read `expectedUserType: INTERNET_PROVIDER_ACCESS_USER_TYPES`, so granting Retention access to every provider was a single edit to one array. That's the payoff stated plainly: the change I dreaded touching thirty files for touched one.

## Hiding what you can't reach

Guarding a route is only half the job. A user who can't open `/task-analytics` shouldn't see "Task Analytics" sitting in the sidebar, taunting them into a redirect to `/unauthorized`. A guard that fires is a failure of the UI to be honest earlier.

So the nav filters itself by the same rule. The header keeps a permission map and only renders the links the current user passes:

```ts
private static readonly ROUTE_PERMISSIONS: Record<string, UserType[]> = {
  '/task-analytics': [UserType.Admin, UserType.Manager],
  '/qa-analytics': [UserType.Admin, UserType.Manager, UserType.Qa, UserType.QaManager],
  '/provider-builder': [UserType.Admin],
  // ...if a path isn't listed, it's open
};
```

Then each nav item asks the same `matchesExpectedUserType` whether to show itself. Same function the guard uses, so the menu and the guard can't disagree about what a QA Manager is allowed to do. The guard is the lock; the nav is the courtesy of not showing a door you can't open. You want both, and you want them to agree.

## The sharp edges

Three things bit me, and one is still a wart I'd fix properly given a free afternoon.

**The nav map duplicates the route data.** Look closely and you'll see it: `expectedUserType` lives on the routes, but the header keeps its *own* `ROUTE_PERMISSIONS` record that has to say the same thing. Two sources of truth for one fact. They drifted exactly once — I added a route's guard array and forgot the nav map, so a QA Manager got a sidebar link that bounced them straight to `/unauthorized`. The honest fix is to derive the nav's allowed-types by reading the `Router` config's `data` at runtime instead of hand-maintaining a parallel map. I haven't done it yet. The comment above the map literally says "mirroring `expectedUserType` from app-routing.module.ts," which is me writing down a known liability and moving on. If you build this pattern, derive the nav from the routes from day one and skip the drift entirely.

**Lazy children don't inherit `data` the way you'd hope.** Route `data` does merge down to child routes, but a lazily loaded feature with its own `Routes` array gets guarded at the parent boundary, not on every leaf. The time-off feature, for instance, declares its `path: ''`, `policies`, and `balances` children with no per-route `expectedUserType` — access is enforced once where the parent route mounts the feature and applies `AuthGuard`. That's fine, but it means "where is this protected?" isn't always answerable by looking at the leaf. You have to walk up. I now put the guard and the `expectedUserType` at the highest route that fully describes the access rule, and leave the children clean.

**`expectedUserType` is client-side and that's all it is.** This guards the *router*, not your data. Every resolver and every GraphQL mutation behind these screens still has to authorize on the server, because anyone can edit route data in their own bundle or just hit the API directly. The route data is a UX and navigation concern — it keeps honest users out of screens that would only frustrate them and clutters nobody's sidebar with dead links. The NestJS side does the real enforcement. I've watched people conflate the two and ship a "secured" admin page whose API was wide open. Don't be that.

## What I'd keep, what I'd change

The core move — access as declarative route data, enforced by exactly one guard — I'd do again without hesitation. The afternoon I feared became a few array edits and one new clause in a pure function, and that function is unit-testable in isolation without spinning up the router at all. Adding the *next* role after QA Manager and Retention was genuinely a five-minute job, which is the whole point.

What I'd change is the duplication. One canonical list of `{ path, allowedUserTypes }` that both the router and the nav consume, generated once, would have saved me the drift bug and the apologetic comment. The lesson that actually transfers: when you find yourself about to edit twenty guards to add one concept, the concept wants to be data, and the enforcement wants to be a single function reading that data. The day you add the twenty-first role, you'll know whether you got it right — because it'll either be one edit or twenty.
