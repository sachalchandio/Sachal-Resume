---
title: "Where Angular memory actually leaks"
description: "Intervals, listeners, manual subscriptions, undisposed charts — the four places I always check first."
date: "2025-09-14"
updated: "2025-09-14"
kind: "deepdive"
category: "Performance"
tags: ["rxjs", "angular", "memory"]
month: "2025-09"
repo: "frontend"
author: "Sachal Chandio"
---

A leak in Angular almost never looks like a leak. The page works. Tests pass. Then a support agent leaves the Telelinkz dashboard open all shift, comes back from lunch, and the tab is sitting at 1.4 GB with the fan spinning. Nobody reported it as a bug because nothing was broken — it just got slower the longer you used it.

I spent two days with the Chrome heap snapshot tool chasing this, and the conclusion is boring: Angular doesn't leak. Things you wire up *inside* Angular components leak when you forget to tear them down. There are exactly four places I check first now, and they account for nearly everything I've ever found. Here's the tour, with the actual code from our cleanup pass.

## The detached-node tell

Before the four, one thing worth knowing: the way you confirm a leak is detached DOM nodes. Take a heap snapshot, filter on "Detached", and if a component's host element shows up after the component was destroyed and never gets collected, something is still holding a reference to it. That reference is the leak. Every category below is a different flavor of "something still holds a reference."

I navigated between our sales dashboard and the agent leaderboard about fifteen times, snapshotting each round. The detached node count went up monotonically. That's the smoking gun — a clean component would let those nodes go.

## 1. setInterval that nobody clears

The leaderboard had a live "last refreshed" badge that ticked every second, plus a poll that re-pulled standings every 30s. Written the obvious way:

```ts
ngOnInit() {
  this.clock = setInterval(() => {
    this.secondsAgo = Math.floor((Date.now() - this.lastFetch) / 1000);
  }, 1000);
}
```

No `clearInterval` anywhere. So every time you visited the leaderboard and left, the callback kept running forever, holding `this` — the entire component instance, its injected services, its template — alive. Fifteen visits, fifteen zombie components all incrementing a counter on a DOM tree no one was looking at.

The blunt fix is `clearInterval` in `ngOnDestroy`. The fix I actually shipped was to stop hand-rolling timers and let RxJS own the lifecycle:

```ts
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

constructor() {
  interval(1000)
    .pipe(takeUntilDestroyed())
    .subscribe(() => {
      this.secondsAgo = Math.floor((Date.now() - this.lastFetch) / 1000);
    });
}
```

`takeUntilDestroyed()` with no argument has to be called in an injection context — that's why it lives in the constructor or a field initializer, not in `ngOnInit`. It hooks Angular's `DestroyRef` and completes the stream when the component dies. `interval` unsubscribing means it stops scheduling. No reference, no leak.

When is plain `setInterval` still right? When the timer genuinely outlives the component on purpose — a singleton service polling a token refresh, say. There, you *want* it to keep going, and you clear it when the service is destroyed (which, for a root service, is app shutdown). Don't reach for RxJS just to look modern; reach for it because you want the destroy hook for free.

## 2. window and document listeners with no matching remove

This is the one that bit hardest, because the leak isn't the component — it's `window`. A global object that never gets collected, holding a closure that holds your component.

We had a chart panel that re-laid-out the ECharts canvas on resize:

```ts
ngOnInit() {
  window.addEventListener('resize', () => this.chart.resize());
}
```

That arrow function closes over `this`. `window` lives forever. Therefore the component lives forever, its chart instance lives forever, and after a dozen navigations you've got a dozen dead components all trying to `resize()` a canvas that's been detached from the DOM. Sometimes they'd even throw, which is how I found it — console noise about resizing a disposed chart.

You cannot remove an anonymous function. `removeEventListener` needs the *same reference* you added. So the first correct version is a bound field:

```ts
private onResize = () => this.chart?.resize();

ngOnInit() {
  window.addEventListener('resize', this.onResize);
}

ngOnDestroy() {
  window.removeEventListener('resize', this.onResize);
}
```

`onResize` is one stable reference; add and remove agree on it. But honestly, for DOM events I now prefer Angular's `Renderer2.listen`, which returns an unlisten function and never touches `this` matching:

```ts
private stopResize?: () => void;

constructor(private renderer: Renderer2) {}

ngOnInit() {
  this.stopResize = this.renderer.listen('window', 'resize', () => this.chart?.resize());
}

ngOnDestroy() {
  this.stopResize?.();
}
```

The trap with global listeners is that they survive everything. A normal component leak self-limits to that component. A `window` listener leak grows without bound and drags the whole component graph along with it.

## 3. Manual subscriptions that outlive the component

This is the classic, and it's classic because `.subscribe()` returns a `Subscription` that *you* now own. Forget it and the observable keeps pushing into a dead component.

Our sales feed used Apollo's `watchQuery` plus a Redis-backed live channel surfaced over a WebSocket. The naive version:

```ts
ngOnInit() {
  this.salesQuery.valueChanges.subscribe(({ data }) => {
    this.rows = data.dailySales;
    this.recomputeTotals();
  });
}
```

`valueChanges` is a long-lived stream. It does not complete when you navigate away. So the closure keeps recomputing totals on a component the user left ten minutes ago, and the Apollo cache update keeps the whole thing pinned.

The fix is `takeUntilDestroyed` again — same tool, different leak source:

```ts
this.salesQuery.valueChanges
  .pipe(takeUntilDestroyed(this.destroyRef))
  .subscribe(({ data }) => {
    this.rows = data.dailySales;
    this.recomputeTotals();
  });
```

Note the argument this time. Outside an injection context — here, inside `ngOnInit` — you pass an explicit `DestroyRef` you injected: `private destroyRef = inject(DestroyRef)`. That's the difference that trips people up: no-arg version in the constructor, explicit-ref version everywhere else.

The version I like even more is to not subscribe by hand at all. If the value only feeds the template, the `async` pipe manages subscription *and* unsubscription for you, and you can't forget what you never wrote:

```ts
sales$ = this.salesQuery.valueChanges.pipe(map(r => r.data.dailySales));
```

```html
@for (row of sales$ | async; track row.id) {
  <tr>...</tr>
}
```

Where `async` is wrong: when the subscription has a side effect beyond rendering — writing to a service, firing analytics, the `recomputeTotals()` above. The pipe gives you the value, not a place to hang logic. For those, subscribe explicitly and pipe `takeUntilDestroyed`. And a real gotcha — a manual `Subscription` you do clean up still leaks if you only call `.unsubscribe()` on the parent but kept adding child subscriptions to a different variable. One `Subscription` per teardown path, or just use the operator and stop bookkeeping.

## 4. Chart instances you never disposed

ECharts, and most canvas/WebGL libraries, allocate outside the Angular and DOM worlds. `echarts.init(el)` registers global resize handling, holds GPU buffers, and keeps a reference to the DOM element. Removing the component's template does **not** free any of that. The library doesn't know your framework destroyed the host.

Our agent-performance ring chart and the daily-revenue bars both did this:

```ts
ngAfterViewInit() {
  this.chart = echarts.init(this.host.nativeElement);
  this.chart.setOption(this.buildOption());
}
```

No dispose. Every navigation orphaned an ECharts instance still wired to a detached `<div>`. This was the single biggest contributor in the heap snapshot — each chart instance dragged its option object, its data series, and the canvas backing store. The fix is one line you have to remember to write:

```ts
ngOnDestroy() {
  this.chart?.dispose();
}
```

There's no RxJS trick that saves you here, because the resource isn't an Observable — it's a foreign object with its own teardown contract. The rule generalizes: anything you `init`, `create`, `new`, or `register` from a non-Angular library, you are responsible for closing. Map instances, video players, IntersectionObservers, Web Workers, `URL.createObjectURL` blobs. The framework cleans up what it created. It cannot clean up what you handed to a third party.

## Telling which fix you need

The four categories map to four teardown mechanisms, and picking the wrong one is how people "fix" a leak that's still leaking.

- A **timer** or a **long-lived Observable** that only needs to stop when the component dies — `takeUntilDestroyed`. No-arg in the constructor, pass a `DestroyRef` elsewhere.
- A value that **only renders** — the `async` pipe. Delete the manual subscription entirely.
- A **DOM event listener** — keep the exact reference and `removeEventListener`, or use `Renderer2.listen` and call its returned unlisten function. Anonymous handlers can never be removed.
- A **foreign resource** (charts, maps, observers, object URLs) — its own `dispose()` / `disconnect()` / `revokeObjectURL`, called from `ngOnDestroy`. RxJS won't help.

A couple of rules of thumb that survived this cleanup. If you typed `addEventListener`, `setInterval`, `setTimeout` with a repeat, `.subscribe(`, or `.init(` inside a component, write the teardown in the same commit — not "later," because later you've forgotten it exists. And when you do go leak-hunting, trust detached DOM nodes over your intuition; I was sure the WebSocket was the culprit and it was the resize listener I'd written eighteen months earlier and never thought about again.

Where this advice is wrong: not everything needs tearing down. A `firstValueFrom` or an HTTP call that completes after one emission cleans up after itself — wrapping it in `takeUntilDestroyed` is harmless noise. A `setTimeout` that fires once and is short is not a leak. The skill isn't unsubscribing from everything; it's knowing which subscriptions are immortal. Polls, intervals, global listeners, Apollo `valueChanges`, and anything you `init` are immortal until you say otherwise. Those are the five words I keep in my head — and the leaderboard tab now sits flat at 90 MB all shift.
