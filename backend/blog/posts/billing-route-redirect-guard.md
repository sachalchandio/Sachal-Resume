---
title: "A canActivate guard that keeps billing users out of the sales tasks"
description: "One small guard to stop a role from landing somewhere it shouldn't, with a test to keep it honest."
date: "2026-05-24"
updated: "2026-05-24"
kind: "deepdive"
category: "Security"
tags: ["angular", "guards", "rbac", "testing"]
month: "2026-05"
repo: "frontend"
author: "Sachal Chandio"
---

A billing user logged in, clicked Tasks, and saw a board full of sales tasks that had nothing to do with her. Not her queue. Not her team's. Just the sales side of the house, rendered in full, because `/task` defaulted to the sales view and she had a token that let her through the front door.

Nothing leaked from the API — the GraphQL resolvers scope billing data and sales data separately, and she couldn't have loaded a sales task's detail even if she'd clicked one. But the board listed them. Names, order numbers, the disposition column. For a role whose entire job is the billing queue, landing on someone else's sales board is the kind of thing that gets screenshotted and forwarded to a manager with a "should I be seeing this?"

So the bug isn't a data leak. It's a routing default that sends the wrong role to the wrong place.

## How /task decides what you see

The task module has one body component at the root and two sibling routes hanging off it:

```ts
const routes: Routes = [
  { path: '', component: TaskBodyComponent },
  { path: 'billing',   component: BillingTaskComponent },
  { path: 'task-mgmt', component: TaskManagerComponent },
];
```

`TaskBodyComponent` is the thing that picks a view. It reads the user type off the auth signal and flips a `showBilling` boolean. Sales group users (agent, manager, QA, QA manager, admin) default to task management. Everyone else — billing being the everyone-else here — defaults to billing.

That default existed already. The problem was *when* it ran versus *what rendered first*. The component sets `showBilling = true` as a field initializer, then an `effect` corrects it once the user type resolves. On a hard refresh to `/task`, the signal isn't populated synchronously; it arrives a tick later. For that tick, a billing user got the field-initializer default of the sales-flavored body before the effect could swap her over. Worse, the toggle lives inside the component, so the URL stayed `/task` the whole time — there was nothing in the address bar, and nothing in the route tree, that said "this person belongs on billing."

I had two layers that could fix this and I used both, for different reasons.

## Two fixes, two jobs

The first is in the body component itself: when a non-sales, non-admin user lands on the bare `/task` URL, redirect them to `/task/billing` and swap the URL so back-button doesn't bounce them into the sales board again.

```ts
private async redirectBillingUsersFromTaskRoot(
  userType: UserType | null,
): Promise<boolean> {
  if (
    !this.shouldRedirectToBillingView(userType) ||
    this.hasRedirectedFromTaskRoot ||
    this.router.url !== '/task'
  ) {
    return false;
  }

  this.hasRedirectedFromTaskRoot = true;
  return this.router.navigate(['/task/billing'], { replaceUrl: true });
}
```

The `hasRedirectedFromTaskRoot` latch matters because this runs from both `ngOnInit` and the `effect`, and without it you can fire two navigations in the same tick and get an ugly flicker. `replaceUrl: true` keeps `/task` out of history so the redirect is invisible.

That handles the "you typed /task" case. But the body component redirect does nothing for someone who navigates straight to `/task/task-mgmt` — a stale bookmark, a copied link in Slack, a hand-typed URL. That route renders the sales task manager directly; the body component never gets a say. This is where the guard earns its place.

`TaskViewGuard` is a `canActivate` that sits on the two sibling routes and reads a `view` marker out of `route.data`:

```ts
@Injectable({ providedIn: 'root' })
export class TaskViewGuard implements CanActivate {
  constructor(
    private authService: AuthenticationService,
    private router: Router,
  ) {}

  async canActivate(
    route: ActivatedRouteSnapshot,
    state: RouterStateSnapshot,
  ): Promise<boolean> {
    const userType = await this.authService.getCurrentUserType();
    const isSalesUser = this.isSalesGroupUser(userType);
    const requiredView = route.data['view'];

    if (requiredView === 'billing' && isSalesUser) {
      // sales users can read the billing dashboard, but not the raw billing list
      if (state.url.includes('/dashboard')) return true;
      if (route.queryParams['from'] === 'dashboard') return true;
      this.router.navigate(['/task/task-mgmt']);
      return false;
    }

    if (requiredView === 'task-mgmt' && !isSalesUser && userType !== UserType.Admin) {
      // a billing user reaching for the sales board — send them home
      this.router.navigate(['/task/billing']);
      return false;
    }

    return true;
  }

  private isSalesGroupUser(userType: UserType | null): boolean {
    return !!userType && TASK_MANAGEMENT_USER_TYPES.includes(userType);
  }
}
```

The bug from the top of this post is the second `if`. A billing user (`isSalesUser` is false, and she's not admin) requesting the `task-mgmt` view gets `canActivate` returning `false`, which aborts that navigation, and a `router.navigate(['/task/billing'])` puts her where she belongs. The sales component never instantiates. No flash, because the guard runs before the route activates, not after it renders.

A few decisions in there are deliberate.

**The guard returns a `Promise`.** `getCurrentUserType()` is async — it reads a cached value when it has one and falls back to resolving from the auth service when it doesn't. Returning the promise from `canActivate` makes the router wait for the real answer instead of guarding on a half-populated `null`. Angular's router is fine with a `Promise<boolean>`; it just holds the navigation until it settles. If I'd made this synchronous and read a signal that wasn't ready yet, `isSalesUser` would be `false` for everyone mid-boot and I'd be redirecting admins to billing for a split second. Async is the boring correct call.

**`view` lives in `data`, not in the path.** I could have hardcoded the path check — "if the URL ends in task-mgmt." But putting a `view: 'task-mgmt'` marker in `route.data` means the guard keys off intent declared next to the route, not off string-matching a URL that someone will eventually restructure. It reads better in the routing module too: each protected route carries its own `expectedUserType` and `view`, side by side.

**Admin is an explicit escape.** `userType !== UserType.Admin` in the second branch lets admins reach both views. They support both teams and need to see what each side sees. Leaving them out of `TASK_MANAGEMENT_USER_TYPES` would have been wrong; carving them out here is the narrowest fix.

The one genuinely fiddly part is the first branch — the `?from=dashboard` and `/dashboard` carve-outs. Sales users are allowed to *view* the billing dashboard (the rollup numbers), they're just not dropped onto the raw billing task list as a default. So when a sales user clicks through from the dashboard, we tag the navigation with `from=dashboard` and the guard lets it pass. Without that, a manager clicking a billing widget would get yanked back to task-mgmt and the click would feel broken. It's a small asymmetry that exists because "can see the dashboard" and "lives on this view" are two different permissions wearing the same route prefix.

## The test, because this is exactly what rots

Here is the thing about role-isolation logic: it works the day you write it, and then it silently stops working eight months later when someone adds a new user type, or renames `task-mgmt`, or "simplifies" the guard and inverts a boolean. Nothing throws. No build fails. The board just quietly starts showing the wrong people the wrong tasks again, and you find out from a screenshot.

So I wrote a test for the redirect specifically — not the happy path, the bounce.

```ts
describe('TaskViewGuard', () => {
  let guard: TaskViewGuard;
  let auth: jasmine.SpyObj<AuthenticationService>;
  let router: jasmine.SpyObj<Router>;

  beforeEach(() => {
    auth = jasmine.createSpyObj('AuthenticationService', ['getCurrentUserType']);
    router = jasmine.createSpyObj('Router', ['navigate']);
    TestBed.configureTestingModule({
      providers: [
        TaskViewGuard,
        { provide: AuthenticationService, useValue: auth },
        { provide: Router, useValue: router },
      ],
    });
    guard = TestBed.inject(TaskViewGuard);
  });

  it('redirects a billing user off the sales task-mgmt route', async () => {
    auth.getCurrentUserType.and.resolveTo('BILLING' as UserType);

    const route = { data: { view: 'task-mgmt' }, queryParams: {} } as any;
    const state = { url: '/task/task-mgmt' } as RouterStateSnapshot;

    const result = await guard.canActivate(route, state);

    expect(result).toBe(false);
    expect(router.navigate).toHaveBeenCalledWith(['/task/billing']);
  });

  it('lets a manager onto the sales task-mgmt route', async () => {
    auth.getCurrentUserType.and.resolveTo(UserType.Manager);

    const route = { data: { view: 'task-mgmt' }, queryParams: {} } as any;
    const state = { url: '/task/task-mgmt' } as RouterStateSnapshot;

    expect(await guard.canActivate(route, state)).toBe(true);
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
```

Two assertions on the failing case carry the weight. `result` has to be `false` — that's what tells the router to abort the activation, and it's the half that actually keeps the sales component from instantiating. And `router.navigate` has to have been called with `/task/billing` — that's the part the user feels. Either one alone is a half-fix: return `false` without redirecting and the user lands on a blank route; redirect without returning `false` and you've kicked off two competing navigations. The test pins both.

I mock `getCurrentUserType` with `resolveTo` rather than wiring a real auth service, because the guard's contract is "given this user type, do you redirect," and I don't want the test to depend on how identity gets resolved. That's a different unit with its own tests. The guard's job is one decision, and I test exactly that decision.

## What I'd do differently

The duplication bothers me. `isSalesGroupUser` exists in the guard *and* in `TaskBodyComponent`, both delegating to `TASK_MANAGEMENT_USER_TYPES`, and the "who defaults to billing" logic is expressed twice — once as a redirect in the body component, once as a guard on the routes. Two layers solving overlapping problems is how you end up with one of them being fixed and the other forgotten. If I rebuilt this, the guard would be the single source of truth for "can this role be here," and the body component would stop trying to redirect at all — it'd just render whatever view the resolved route handed it. Right now the body redirect is load-bearing for the bare `/task` case only because the guard isn't on the root path. Put a guard there too and the body component gets dumber, which is the right direction.

The other thing: `route.queryParams['from'] === 'dashboard'` is a soft signal. It's a marker the app sets on itself, easy to forge by hand, and it isn't a security boundary — it's a UX convenience so a legitimate click-through isn't punished. That's fine as long as everyone understands the API is the actual boundary and this guard is about not putting people somewhere confusing. The day someone treats a query-param check as access control is the day this gets dangerous. It isn't, and the comment in the code says so, but soft signals have a way of being mistaken for hard ones.

If you take one thing from this: a `canActivate` that redirects is only doing half its job until there's a test asserting *both* the `false` return and the destination. Role boundaries don't fail loudly. They fail the next time someone touches the routing table, and the only thing standing between that edit and a billing user staring at the sales board is a test that fails in CI instead of in a screenshot.
