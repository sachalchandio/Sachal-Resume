---
title: "Don't fetch what you can't see: lazy GraphQL behind a closed sidebar"
description: "The app fired notification, chat and task queries on every route, even with the panel shut."
date: "2026-04-04"
updated: "2026-04-04"
kind: "deepdive"
category: "Performance"
tags: ["angular", "graphql", "performance"]
month: "2026-04"
repo: "frontend"
author: "Sachal Chandio"
---

I was looking at the network tab for an unrelated bug when I noticed the shape of the startup waterfall. Log in, land on the dashboard, and before the dashboard's own data has finished loading there are three GraphQL requests in flight that have nothing to do with the dashboard: `myNotifications`, `myChatThreads`, `myTasks`. Navigate to the sales board — same three again. Open an agent profile — same three. The right sidebar that holds notifications, chat, and tasks was closed the entire time. I'd never opened it. It was firing its queries anyway, on every single route change, all session long.

The sidebar is a slide-in panel on the right edge of the CRM. It's shut by default. Most people who live in this app keep it shut most of the day and flick it open when a notification badge lights up. So the steady-state cost of those three queries was pure waste — we were paying for data nobody was looking at, on every navigation, for every user, forever.

## Why it was happening

The layout component renders the panel like this, roughly:

```html
<!-- main-layout.component.html -->
<router-outlet />

<aside class="right-sidebar" [class.open]="sidebarOpen()">
  <app-notifications-panel />
  <app-chat-panel />
  <app-tasks-panel />
</aside>
```

`sidebarOpen()` is a signal. When it's false, the `.open` class comes off and the panel slides out of view with a CSS transform. That's the whole "closing" mechanism — `transform: translateX(100%)` and `visibility: hidden` once the transition finishes. The panel is off-screen, but it is absolutely still in the DOM. Those three child components are constructed, their `ngOnInit` runs, and each one kicks off its query the moment the layout mounts:

```ts
// notifications-panel.component.ts
ngOnInit(): void {
  this.notificationsRef = this.apollo.watchQuery({
    query: GET_MY_NOTIFICATIONS,
    pollInterval: 60_000,
  });
  this.notifications$ = this.notificationsRef.valueChanges.pipe(/* ... */);
}
```

`watchQuery` with a `pollInterval`. So it isn't even one request per navigation — it's one on init plus a poll every sixty seconds, three panels deep, for a sidebar the user has never touched. The polling was the part that actually annoyed me. A closed panel quietly re-hitting the server every minute on three queries is the kind of thing that doesn't show up in any one trace but adds up to real load when you've got a few hundred agents logged in at once.

The reason it was structured this way is the boring one: the panel started life as always-mounted, the open/close was added later as a pure CSS affordance, and nobody went back to ask whether "hidden" should also mean "not running." CSS hid it from the user. It did nothing to hide it from Apollo.

## What I didn't want to do

The first idea, the lazy one, was to leave the components mounted and just guard the query — pass `sidebarOpen` down into each panel and add `skip: !open` to the query, or gate the `watchQuery` call behind an `if`. It works in the narrow sense. But now every panel has to know about the sidebar's open state, the skip logic is duplicated three times, and the components are still constructed and still sitting in the change-detection tree doing nothing useful. I'd be papering over the symptom — the query — while leaving the actual cause, which is that we're rendering three components the user can't see.

The second idea was `@defer`. Angular's deferred views are built for exactly this neighbourhood, and `@defer (on interaction)` or `(on viewport)` is genuinely good for below-the-fold content. But `@defer` is one-directional: it loads the block when the trigger fires and then it stays loaded. There's no "re-idle it when the sidebar closes again." For a panel that opens and closes dozens of times a day, I didn't want a trigger that fires once and then leaves all three panels permanently mounted and polling for the rest of the session. `@defer` solves "don't load it until first needed." My problem was "don't keep it running when it's not needed," which is a different problem.

The thing that was actually wrong was structural, and the fix should be structural too. A closed sidebar shouldn't contain its children at all.

## The fix: gate the whole subtree on visibility

`@if` on the panel contents. When the sidebar is closed, the child components don't exist — not hidden, not skipped, not deferred. They aren't constructed, so their `ngOnInit` never runs, so no query ever fires. Open the sidebar and Angular constructs them; close it and Angular destroys them.

```html
<!-- main-layout.component.html -->
<aside class="right-sidebar" [class.open]="sidebarOpen()">
  @if (sidebarOpen()) {
    <app-notifications-panel />
    <app-chat-panel />
    <app-tasks-panel />
  }
</aside>
```

That's the entire load-bearing change. The panels go from "always mounted, query on every route" to "mounted only while open." On a normal session where the sidebar spends most of its life shut, that's three queries and their polling intervals gone from every navigation, replaced by three queries that run only across the windows where someone's actually reading the panel.

I kept the `[class.open]` binding because it still drives the slide transition on the `<aside>` shell itself — the chrome of the panel, its border and background, animates in and out. The contents just pop into existence at the start of the open transition. In practice you don't see the pop because the panel slides in from off-screen and the content is already there by the time the edge clears the viewport.

For the panels themselves, the only thing I had to be honest about was teardown. A `watchQuery` subscription has to die with the component, or destroying and recreating the panel leaks a subscription every open/close cycle. I was already using `takeUntilDestroyed`, but it's worth stating because the whole approach depends on the component actually cleaning up when it's destroyed:

```ts
// notifications-panel.component.ts
private readonly destroyRef = inject(DestroyRef);

ngOnInit(): void {
  this.notifications$ = this.apollo
    .watchQuery({ query: GET_MY_NOTIFICATIONS, pollInterval: 60_000 })
    .valueChanges.pipe(
      map((res) => res.data.myNotifications),
      takeUntilDestroyed(this.destroyRef),
    );
}
```

When `@if` flips to false, the component is destroyed, `destroyRef` fires, the `valueChanges` subscription is torn down, and the poll stops. No orphaned interval ticking away in the background. That last part is the bit that makes the whole thing safe: if the poll didn't stop on destroy, I'd have just moved the leak around instead of fixing it.

## The unread badge problem

Here's the catch, and it's the reason "just don't render it" isn't always a free lunch. The notification bell in the top bar shows an unread count. That badge has to be live whether or not the sidebar is open — the entire point of the badge is to tell you to open the panel. If the only thing querying notifications is a component that doesn't exist until you open the panel, the badge goes dark and you never know to open it. Classic chicken and egg.

So I didn't move *all* notification fetching behind the `@if`. I split it. The cheap, always-on signal — the unread count — lives in a small service that the top bar reads, and it polls a deliberately lightweight query:

```ts
// notification-count.service.ts
@Injectable({ providedIn: 'root' })
export class NotificationCountService {
  private readonly apollo = inject(Apollo);

  readonly unreadCount = toSignal(
    this.apollo
      .watchQuery({ query: GET_UNREAD_COUNT, pollInterval: 120_000 })
      .valueChanges.pipe(map((res) => res.data.unreadNotificationCount)),
    { initialValue: 0 },
  );
}
```

`GET_UNREAD_COUNT` returns a single integer. Not the notification list — just `unreadNotificationCount`. It polls every two minutes instead of every one, because a badge that's a couple of minutes stale is fine and a badge that's instant is not worth double the requests. The heavy query — the full notification list with bodies, timestamps, actor avatars, the works — stays inside the panel component behind the `@if`, and only runs when someone actually opens the thing to read it.

That division is the real lesson, more than the `@if` trick. There were two different jobs hiding inside one query: "is there anything worth your attention" and "show me everything in detail." The first has to be cheap and always-on. The second is expensive and almost always unwanted. Bundling them meant paying detail-query prices to answer a yes/no question, on every route, with the answer scrolling off-screen into a closed panel. Chat and tasks didn't need an equivalent because neither had an always-visible indicator in the top bar — there was nothing to keep alive, so those two went fully behind the gate.

## What it cost

The tradeoff I accepted is a small latency hit the first time you open the panel each... well, each time you open it. With the old always-mounted version, opening the sidebar was instant because the data was already cached from the init query. Now opening it constructs the components and fires the queries fresh, so there's a brief loading state — a spinner for the few hundred milliseconds it takes the three queries to land. For a panel you open intentionally and then read, that delay is invisible against the act of reading. I'd take a 300ms spinner on deliberate open over three perpetual background polls every day of the week.

There's a softer cost too: state doesn't persist across close/open. If you'd scrolled halfway down the notification list, closed the panel, and reopened it, the old version kept your scroll position because the component never went away. The new version rebuilds from the top. Nobody has complained, and honestly re-opening to the newest notifications at the top is arguably more correct than restoring a stale scroll position into a list that may have changed. But it's a behavior change, and if the panel held something like a half-filled form you'd have to think harder — `@if` destroying the subtree means destroying its transient state along with it.

The numbers, since that's the whole point: a typical navigation-heavy session — someone bouncing between the sales board, agent profiles, and reports for an hour, sidebar shut the whole time — went from firing those three panel queries on every route plus polling them in the background, down to one lightweight count query polling every two minutes. On the startup path specifically, three requests came off the critical waterfall, which let the dashboard's own data breathe.

If there's a thing to carry out of this, it's that "hidden" and "not running" are not the same word, and CSS only ever gives you the first one. A `display: none` panel, an off-screen `translateX`, a collapsed accordion, a tab that isn't the active tab — all of them are still mounted, still subscribed, still polling, unless you reach for `@if` and actually take them out of the tree. The query that costs you the most is the one you forgot was firing, because you couldn't see it. Check the network tab on a route you think is cheap. Mine wasn't.
