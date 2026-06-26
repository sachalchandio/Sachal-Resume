---
title: "Visual access control: showing a restricted route as restricted"
description: "Disabled nav links looked identical to active ones. Adding the affordance without touching the router."
date: "2026-04-06"
updated: "2026-04-06"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "routing", "css", "access-control"]
month: "2026-04"
repo: "frontend"
author: "Sachal Chandio"
---

A QA lead pinged me on a Friday: "Why does the sidebar show me Commission Management if I can't open it?" She'd clicked it, the route guard bounced her back to the dashboard, and she assumed something was broken. It wasn't. The guard did exactly what it was told. The problem was that the link gave her no reason to expect the bounce.

That's the whole bug in one sentence. A link a user can't reach looked identical to one they can. Same color, same hover, same cursor. So people clicked into dead ends, got redirected, and filed it as a glitch.

## The guard was already correct

We already had route-level enforcement. Every protected route in `app-routing.module.ts` carries an `AuthGuard` and a `data.expectedUserType` array:

```ts
{
  path: 'commission-management',
  loadComponent: () => import('...'),
  canActivate: [AuthGuard],
  data: {
    expectedUserType: [UserType.Admin, UserType.Manager],
  },
},
```

A QA user hits that route, the guard reads `expectedUserType`, sees `Qa` isn't in the list, and redirects. Security-wise, fine. Nothing leaks. The deep page never renders.

But the guard runs *after* the click. The nav is rendered well before that, and it has no idea any of this exists. It just paints a `<li>` with an anchor for every menu item, full opacity, full pointer events, identical to every other item. The user can't tell the difference between "you can go here" and "you'll get thrown out if you try."

So this isn't an access-control bug. The access control works. It's an *affordance* bug. The UI is lying about what's clickable.

## Don't move the source of truth

First instinct, and the one I'm glad I didn't ship: read the guard config at runtime and derive the nav state from it. One source of truth, very tidy on paper. In practice Angular's `Routes` array isn't a friendly thing to introspect for "which user types can reach this leaf" — guards are class references, `data` lives at arbitrary depth, lazy children aren't resolved until you navigate. I'd have ended up writing a router-config crawler to power a CSS class. That's a lot of machinery to grey out a link.

The other instinct: `*ngIf` the links away entirely. If you can't go there, you don't see it. We already do that in a couple of spots (call logs is hidden outright for retention users, because for them it's not "locked," it's "not part of your job"). But hiding everything was wrong here. Managers train agents. Support walks people through the app over a screen-share. "It's the greyed-out one under Sales" is a useful sentence. "It's the one that isn't there for you but is there for me" is not. Visible-but-disabled tells you the feature exists and that your role is the reason you can't touch it. That's information, and we wanted to keep it.

So I went with a deliberately dumber design. A small static map in the header component that *mirrors* the guards, plus pure-CSS disabling. The guard stays the only thing that actually enforces anything. The map only decides how a link looks.

Yes, that's duplication. I'll come back to it, because it's the part that bites.

## The permission map

The header component holds a static record keyed by path, each path pointing at the user types allowed to reach it. It's a hand-maintained copy of the `expectedUserType` arrays from the routing module:

```ts
/**
 * Static permission map mirroring expectedUserType from app-routing.module.ts.
 * If a path is not listed here, it is considered accessible (no guard).
 */
private static readonly ROUTE_PERMISSIONS: Record<string, UserType[]> = {
  '/task-analytics': [UserType.Admin, UserType.Manager],
  '/qa-analytics': [UserType.Admin, UserType.Manager, UserType.Qa, UserType.QaManager],
  '/commission-management': [UserType.Admin, UserType.Manager],
  '/user-management': [UserType.Admin, UserType.Manager, UserType.Hr, UserType.ItAdmin],
  '/hr': [UserType.Admin, UserType.Manager, UserType.Hr],
  // ...~40 more
};
```

The lookup is one method. It resolves the current user type, then checks the map:

```ts
isRouteAccessible(path: string): boolean {
  const currentType = this.resolvedUserType();

  // call logs is hidden, not faded, for retention users — special case
  if (
    shouldHideCallLogsForUserType(currentType) &&
    path.startsWith('/interested-customer-leads')
  ) {
    return false;
  }

  const allowedTypes = HeaderComponent.ROUTE_PERMISSIONS[path];
  if (!allowedTypes) return true; // no guard on this route → accessible
  if (!currentType) return true;  // type not resolved yet → don't fade
  return matchesExpectedUserType(currentType, allowedTypes);
}
```

Two of those guard clauses earned their place the hard way. The "no entry in the map" case returns `true` — an unguarded route is reachable by everyone, so the default has to be accessible, not locked. And the "type not resolved yet" case also returns `true`, which I'll explain in a second because it caused the only genuinely embarrassing version of this.

`matchesExpectedUserType` is the same helper the guard uses, so the comparison logic — including a couple of role aliases — lives in one place even though the data is duplicated.

Parent menu items needed one more thing. A dropdown like "Reports" should only fade if *every* child under it is off-limits. If you can reach even one report, the parent stays live:

```ts
/** Returns true when at least one child path is accessible */
isAnyChildAccessible(paths: string[]): boolean {
  return paths.some((p) => this.isRouteAccessible(p));
}
```

## The CSS does the actual disabling

This is the part I like, because it's almost nothing. The template binds a class:

```html
<li
  class="child-link"
  [class.restricted-link]="!isRouteAccessible('/commission-management')"
>
  <a class="child-link-text" routerLink="/commission-management">
    {{ t("layout.header.commissionManagement") }}
  </a>
</li>
```

And `.restricted-link` does the work:

```css
.restricted-link {
  opacity: 0.4;
  user-select: none;
  position: relative;
}

.restricted-link > a,
.restricted-link .child-dropdown-triger,
.restricted-link .grandchild_link_text,
.restricted-link .grandchild_link_triger {
  pointer-events: none;
  cursor: not-allowed;
  color: inherit;
}
```

`opacity: 0.4` reads instantly as "dimmed / not for you" — it desaturates without me having to define a second muted color per theme, which matters because this app has a light and a dark theme and I did not want to maintain disabled variants of every link color. `pointer-events: none` makes the anchor unclickable and un-hoverable; the route guard is no longer the thing catching these clicks, because the click never happens. `cursor: not-allowed` confirms it on hover. `user-select: none` keeps people from selecting the text and getting a fake sense it's interactive.

The dropdown trigger selectors matter for parent items. A faded parent shouldn't expand on click either, so the same `pointer-events: none` applies to `.child-dropdown-triger` and the nested grandchild triggers, not just plain anchors.

Worth saying plainly: this is a visual affordance, not a security control. `pointer-events: none` is a CSS property. Anyone can open devtools, delete the class, and click the link — and then the guard redirects them, exactly as before. The CSS is for honest users who'd otherwise be confused. The guard is for everyone. Those are two different jobs and I kept them separate on purpose.

## The sharp edge: the flash of "everything is locked"

Here's the bug I shipped first.

The user type isn't known synchronously on boot. It comes from the auth signal, and if that hasn't populated yet, it falls back to a stored value we read asynchronously. My initial `isRouteAccessible` treated "no type yet" as "not allowed" — fail closed, felt responsible. The result: for a few hundred milliseconds on every hard refresh, an admin saw their *entire* sidebar greyed out, then it all snapped to life once the type resolved. It looked like the app was broken or the session had died.

The fix is the line I flagged earlier:

```ts
if (!currentType) return true; // not yet known → don't fade
```

While the type is unknown, assume accessible and don't fade anything. The guard is still there if an unauthorized click somehow slips through during that window, so failing *open* on the cosmetic layer costs nothing real and removes the flash entirely. Once `resolvedUserType` lands, we call `markForCheck()` and the restricted links settle into place. On `OnPush` that re-evaluation matters — without the explicit mark, the dimming wouldn't reliably repaint when the async type arrived.

That's the general principle I took away: a presentation layer should fail open, an enforcement layer should fail closed. I'd inverted them. Greying out a real admin is a worse user experience than briefly showing a link a guard will catch anyway.

## What I'd change

The duplication is real and it will rot. `ROUTE_PERMISSIONS` is a hand-copied mirror of every `expectedUserType` in the routing module, and nothing stops the two from drifting. The day someone tightens a guard and forgets the map, a link looks clickable, the user clicks, and we're right back to the Friday ping that started this — except now it's worse, because the affordance is actively lying instead of merely absent. There's no test asserting the two stay in sync, and that's the first thing I'd add: a unit test that walks the route config, pulls every `data.expectedUserType`, and fails if it doesn't match the map. The map could even be generated from the routes at build time so there's literally one source. I didn't do it yet because the route config isn't trivially walkable for nested lazy children, which is the same reason I didn't read guards at runtime in the first place. The shortcut and the debt have the same root cause, which is honest at least.

The other thing: a tooltip on the dimmed links saying *why* — "Requires Manager access" — would close the loop. Right now you can see it's locked but not what unlocks it. `pointer-events: none` kills the hover, so the tooltip would have to live on the parent `<li>` rather than the anchor. Small, and on the list.

If you take one thing from this: when a guard redirects a user, ask whether the UI ever told them the redirect was coming. Enforcement and affordance are different layers, and a correct guard sitting behind a link that looks perfectly clickable is still a bug — just one that files itself under "flaky" instead of "broken."
