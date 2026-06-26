---
title: "The RxJS subscription leak field guide"
description: "Where memory leaks actually hide in an Angular app, and the handful of patterns that stop them — from takeUntilDestroyed to swapping a 100ms interval for a signal effect."
date: "2025-09-12"
updated: "2025-09-12"
kind: "deepdive"
category: "Performance"
tags: ["rxjs", "angular", "memory", "signals"]
month: "2025-09"
repo: "frontend"
author: "Sachal Chandio"
---

A leak in an Angular app almost never announces itself. Nobody files a bug that says "memory grows 4MB per route change." What you get instead is a support ticket from a sales floor: the CRM "gets slow after a while," and a refresh fixes it. That's the tell. If a refresh fixes it and nothing on the server changed, you're leaking something on the client, and nine times out of ten it's a subscription, a listener, or a chart you forgot to throw away.

I spent a week chasing exactly this in the Telelinkz frontend after agents on long shifts started complaining the dashboard chewed through their laptops by mid-afternoon. This is the field guide I wish I'd had going in: where the leaks actually were, how I confirmed them, and the small set of patterns that killed every one.

## How I knew it was a leak and not just a slow app

First, prove it. Open DevTools, Performance Monitor tab, watch "JS heap size" and "DOM Nodes" while you navigate back and forth between two routes ten times. If the heap ratchets up and never comes back down after a forced GC (the little trash-can icon), that's your leak. A healthy app sawtooths — up on navigation, back down on GC. A leaking one climbs a staircase.

The second tell is in the heap snapshot. Take one, navigate away from a component, take another, and compare. If you still see instances of `DashboardComponent` or `Subscriber` objects that should be long gone, something is holding a reference to them. In our case the retainer chain pointed straight at RxJS `Subscriber` nodes rooted in long-lived services. That's the signature of a subscription nobody unsubscribed.

The third, and the one the users actually felt: duplicate handlers. Navigate to the chat view, leave, come back, and a single incoming message would render twice. Then three times. Every visit re-subscribed to the same socket stream without tearing down the old subscription, so N visits meant N live handlers all reacting to one event.

## Offender #1: the 100ms polling service

This was the worst one and it was mine, written early when I didn't know better. A global `PresenceService` that kept the "who's online" indicators fresh by polling:

```ts
@Injectable({ providedIn: 'root' })
export class PresenceService {
  private statuses$ = new BehaviorSubject<AgentStatus[]>([]);

  constructor(private http: HttpClient) {
    // Runs forever. Every 100ms. Whether anyone is looking or not.
    setInterval(() => {
      this.http.get<AgentStatus[]>('/api/presence').subscribe(s => {
        this.statuses$.next(s);
      });
    }, 100);
  }
}
```

Ten requests a second, for the lifetime of the tab, firing whether the presence panel was even on screen. The `setInterval` never cleared because the service is `providedIn: 'root'` and never destroyed. Worse, each tick opened a fresh HTTP subscription, and on a flaky connection those stacked up. Performance Monitor showed CPU that simply never idled — a flat line at 8–12% with the app sitting still.

The naive fix is `clearInterval` somewhere, but there's nothing to hang it on; the service lives forever. The real fix was to stop polling at all. Presence already came over a WebSocket for the chat feature — I just wasn't using it here. But the more interesting rewrite, and the pattern I now reach for, was replacing the interval with a signal `effect()` so work only happens on real change:

```ts
@Injectable({ providedIn: 'root' })
export class PresenceService {
  // Pushed into by the socket layer. No polling.
  private readonly raw = signal<AgentStatus[]>([]);

  // Derived. Only recomputes when `raw` actually changes.
  readonly online = computed(() =>
    this.raw().filter(a => a.status === 'online')
  );

  ingest(statuses: AgentStatus[]) {
    this.raw.set(statuses);
  }

  constructor() {
    effect(() => {
      const count = this.online().length;
      // Side effect runs only on a genuine status change, not on a clock.
      this.badge.setCount(count);
    });
  }
}
```

The difference is philosophical, not just mechanical. The interval asked "has anything changed?" 600 times a minute. The effect is told when something changed and does nothing the rest of the time. CPU at idle dropped to zero. If you have any `setInterval` in an Angular service that exists only to keep some derived value fresh, that's a candidate for this swap — the interval is a workaround for not having reactive state, and signals give you the reactive state.

One caveat so nobody copies this blindly: `effect()` is for side effects, not for producing values you bind in a template. If all you want is derived data, use `computed`. I've seen people reach for `effect` to set another signal and create feedback loops; Angular will yell at you about writes inside effects for good reason.

## Offender #2: notification and chat subscriptions that never tore down

Classic. A component subscribes in `ngOnInit` and forgets `ngOnDestroy`:

```ts
ngOnInit() {
  this.notifications.stream$.subscribe(n => this.toast(n));
  this.chat.messages$.subscribe(m => this.messages.push(m));
}
// no ngOnDestroy. the subscriptions outlive the component.
```

Because `NotificationService` is root-scoped and long-lived, every component that subscribed without cleaning up leaked itself — the `Subscriber` holds a closure over `this`, which holds the whole component and its DOM. That's the retainer chain I saw in the snapshots. And it's why messages rendered N times: each dead component's handler was still alive and still pushing.

The fix I standardized on is `takeUntilDestroyed`, which landed in Angular 16 and removed most of the boilerplate I used to write:

```ts
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

export class ChatComponent {
  private destroyRef = inject(DestroyRef);

  constructor() {
    this.chat.messages$
      .pipe(takeUntilDestroyed())
      .subscribe(m => this.messages.update(list => [...list, m]));
  }
}
```

Called in an injection context (constructor or field initializer) it picks up the `DestroyRef` automatically. If you need it later — inside a method — capture the ref and pass it: `takeUntilDestroyed(this.destroyRef)`.

For older corners of the app still on the manual pattern, the `takeUntil(destroy$)` idiom is fine and worth knowing because you'll read it in every codebase:

```ts
private destroy$ = new Subject<void>();

ngOnInit() {
  this.notifications.stream$
    .pipe(takeUntil(this.destroy$))
    .subscribe(n => this.toast(n));
}

ngOnDestroy() {
  this.destroy$.next();
  this.destroy$.complete();
}
```

The one rule with `takeUntil`: it must be the last operator before `subscribe`. Put a `switchMap` after it and the inner subscription escapes the teardown. I've been burned by that exactly once and it took an embarrassingly long time to spot.

Honestly though, the best subscription is the one you never write. Most of these streams existed only to shove a value into a template. The async pipe does that and unsubscribes for you when the view is destroyed:

```html
<div *ngFor="let m of chat.messages$ | async">{{ m.body }}</div>
```

Where I could move data binding into the template, the leak became structurally impossible. You can't forget to unsubscribe from a subscription you didn't create. That's the version I'd push for first; reach for `takeUntilDestroyed` only when you genuinely need imperative logic in the `.subscribe` callback.

## Offender #3: window resize listeners stacking up

Our charts needed to resize with the viewport, so somebody — me — added a resize listener in `ngOnInit`:

```ts
ngOnInit() {
  window.addEventListener('resize', () => this.chart.resize());
}
```

Two bugs in three lines. The listener is never removed, so every visit to the dashboard adds another one. After ten navigations, one resize event fired ten `chart.resize()` calls. And you *cannot* remove it even if you try, because `() => this.chart.resize()` is a brand-new function reference every time — `removeEventListener` needs the *same* reference you added. This is the single most common `addEventListener` mistake I see.

Store the bound reference, then remove it:

```ts
private onResize = () => this.chart?.resize();

ngOnInit() {
  window.addEventListener('resize', this.onResize);
}

ngOnDestroy() {
  window.removeEventListener('resize', this.onResize);
}
```

The field holds one stable reference for the component's lifetime, so add and remove refer to the same function. If you'd rather stay in RxJS, `fromEvent(window, 'resize').pipe(takeUntilDestroyed())` does the same job and cleans itself up — and you'd want a `debounceTime(100)` in there anyway, because raw resize events fire absurdly fast.

## Offender #4: ECharts instances never disposed

The subtle one. We use ECharts for the sales dashboards, and `echarts.init` allocates a canvas, a render loop, and its own internal listeners. Angular destroying the host component does *not* dispose the chart — ECharts has no idea Angular exists. So every dashboard visit leaked an entire chart engine, canvas and all, and the DOM Node count in Performance Monitor crept up in big jumps that never came back.

```ts
private chart?: echarts.ECharts;

ngAfterViewInit() {
  this.chart = echarts.init(this.el.nativeElement);
  this.chart.setOption(this.buildOption());
}

ngOnDestroy() {
  this.chart?.dispose(); // the line that was missing
  this.chart = undefined;
}
```

`dispose()` tears down the instance and its listeners and frees the canvas. The rule generalizes to anything you `init` from a third-party imperative library — maps, editors, video players, drag-and-drop libs. If the constructor isn't a NestJS-style DI thing that Angular owns, Angular won't clean it up, and there's almost always a `dispose`/`destroy`/`teardown` you're responsible for calling in `ngOnDestroy`. I now grep any new dependency for `dispose` before I trust it in a routed component.

## When this advice is wrong

A few places where "always unsubscribe" is cargo-culting:

- **HttpClient calls that you consume once.** `this.http.get(...).subscribe()` completes after one emission, and a completed observable releases its subscriber. Wrapping every `http.get` in `takeUntilDestroyed` is noise. The leak risk there is only if you keep the subscription open for streaming-style endpoints. (That said, if the component dies mid-flight you may still want to cancel the request — `takeUntilDestroyed` will do that too. It's a judgment call, not a law.)
- **Streams that complete on their own**, like `route.params` inside a guard, or a `timer(0)`. They emit and finish.
- **The async pipe**, obviously — adding manual teardown on top of it is redundant and occasionally harmful if you `complete` a Subject the pipe is still reading.

And the inverse trap: don't assume `providedIn: 'root'` services are safe to subscribe to forever just because *they* never die. The danger isn't the service's lifetime, it's the *subscriber's*. A long-lived service streaming into a short-lived component is the exact recipe that leaked the component. The longer-lived the producer, the more important the consumer's teardown.

## Rules of thumb I actually keep

If a refresh fixes the slowness and the backend is untouched, stop looking at the server. It's a client leak, and it's one of four things: an interval, a subscription, a DOM listener, or a third-party instance you `init`'d.

Prefer the async pipe to a manual subscription; you can't leak what you don't create. When you must subscribe imperatively, `takeUntilDestroyed()` in the constructor is the default, and it has to be the last operator in the pipe. For anything you `addEventListener` or `init`, the cleanup is your job — store the listener reference so you can actually remove it, and call the library's `dispose` in `ngOnDestroy`. And when you catch yourself reaching for `setInterval` to keep a value fresh, stop: that's usually a signal `effect` or `computed` waiting to be written, and it'll do the work only when something genuinely changes instead of 600 times a minute against a clock that doesn't care.

The leak that taught me the most was the 100ms poller, because the fix wasn't "remember to clean up." It was "don't create the thing that needs cleaning up." Most of these are like that once you look hard enough.
