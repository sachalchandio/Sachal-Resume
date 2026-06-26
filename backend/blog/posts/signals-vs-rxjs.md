---
title: "Angular signals vs RxJS: when I reach for which"
description: "Synchronous state versus async streams, effect() versus subscribe, and how they interoperate in a real app."
date: "2025-12-15"
updated: "2025-12-15"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "signals", "rxjs"]
month: "2025-12"
repo: "frontend"
author: "Sachal Chandio"
---

Signals didn't kill RxJS. They took over one job RxJS was always slightly wrong for, and left the rest alone. That's the whole post, but the interesting part is the line between the two — because if you draw it wrong you end up with either a `BehaviorSubject` for every boolean or an `effect()` doing async work it has no business doing.

Here's the line I actually use on Telelinkz, our telecom sales CRM frontend (Angular standalone components, Apollo, Material, ECharts):

- **Signals** for synchronous component state — the stuff that has a *current value* and gets read during render.
- **RxJS** for asynchronous streams and events — anything that happens *over time*: HTTP, WebSocket, debounced input, intervals, anything you'd describe with a verb.

Everything else is figuring out where those two meet.

## The thing RxJS was always slightly wrong for

Before signals, component state lived in `BehaviorSubject`. You'd have a `selectedAgentId$`, a `loading$`, a `filters$`, and your template was a thicket of `| async`. It worked. But a `BehaviorSubject` is a stream that *pretends* to have a current value — `.getValue()` exists but using it feels like cheating, and reading it imperatively outside a subscription is exactly the footgun everyone warns you about.

The tell is when you write this:

```ts
// the "I just want the current value" dance
const id = this.selectedAgentId$.getValue();
if (id) this.doSomethingWith(id);
```

That's not a stream. That's a variable wearing a stream costume. Component selection state is synchronous — it has a value *right now*, you read it during render, and "the value changed" doesn't need backpressure or cancellation or a `switchMap`. Signals are that variable, with change tracking that the template understands natively.

So the dashboard filter bar went from this:

```ts
private readonly _period$ = new BehaviorSubject<Period>('THIS_MONTH');
period$ = this._period$.asObservable();

setPeriod(p: Period) {
  this._period$.next(p);
}
```

to this:

```ts
readonly period = signal<Period>('THIS_MONTH');

setPeriod(p: Period) {
  this.period.set(p);
}
```

In the template, `period$ | async` became `period()`. No subscription, no async pipe, no "what if it's still null on first render." A signal always has a value — that's the contract — so the `null`-while-loading state that the async pipe forces on you just disappears.

Computed state is where it actually starts paying for itself. The dashboard shows a date range derived from the selected period, and before, deriving one observable from another meant `combineLatest` and a `map` and remembering to share the subscription. Now:

```ts
readonly period = signal<Period>('THIS_MONTH');
readonly customRange = signal<{ from: Date; to: Date } | null>(null);

readonly dateRange = computed(() => {
  const p = this.period();
  if (p === 'CUSTOM') return this.customRange() ?? defaultRange();
  return rangeForPeriod(p); // pure, synchronous
});
```

`dateRange` recomputes only when `period` or `customRange` change, it's lazy (nothing runs until something reads it), and it's glitch-free — you never see an intermediate state where `period` updated but `dateRange` hasn't caught up yet. Getting that same guarantee out of `combineLatest` is possible but you have to think about it. With `computed` you get it for free.

## Where RxJS stays, permanently

The moment time enters the picture, I'm back in RxJS, and I'm not apologetic about it.

The clearest example: agent search in the sale-assignment dropdown. User types, we hit a GraphQL query, and we do *not* fire a request per keystroke. This is the canonical RxJS pipeline and signals have no good answer for it:

```ts
readonly searchControl = new FormControl('');

readonly agents$ = this.searchControl.valueChanges.pipe(
  debounceTime(250),
  distinctUntilChanged(),
  switchMap((term) =>
    this.agentGql.watch({ search: term ?? '' }).valueChanges.pipe(
      map((r) => r.data.agents),
    ),
  ),
);
```

`debounceTime`, `distinctUntilChanged`, `switchMap` — each one is a real requirement (don't spam, don't repeat, cancel the in-flight request when a newer term arrives). `switchMap`'s cancellation is the part people forget they're getting: type "joh", then "john", and the request for "joh" is torn down before it can resolve and overwrite your results with stale data. Try reproducing that with signals and you'll hand-roll a worse version of `switchMap` involving a request-id counter. I've seen it. I've written it. Don't.

Same story for our live sale feed over WebSocket (Apollo subscription backed by Redis pub/sub on the NestJS side). It's a push stream with no current value until the server sends one — that's an Observable, full stop. Events, sockets, HTTP, anything debounced or throttled or retried: RxJS owns that and signals don't try to take it.

## The polling service that became an effect()

Here's the conversion that made the line click for me.

We had a `SaleStatsPollingService` that refetched the dashboard summary every 30 seconds *and* whenever the selected period changed. The original was pure RxJS and it had a subtle bug:

```ts
// before — the bug is in here somewhere
this.period$
  .pipe(
    switchMap((period) =>
      timer(0, 30_000).pipe(map(() => period)),
    ),
    switchMap((period) => this.fetchStats(period)),
  )
  .subscribe((stats) => this.statsSubject.next(stats));
```

It works, but read it twice. The `period$` is driving an interval that re-emits the period, which feeds a fetch. The structure is fighting itself — `period` is *state* (synchronous, current value), and I'd wrapped it in a stream so I could glue it to a *timer* (genuinely async). Two different kinds of thing, mashed into one pipe, and the seam is where bugs live. In our case a fast period switch could leave you fetching for the new period on a timer still scoped to the old one. Rare, annoying, hard to reproduce.

Splitting it along the signal/RxJS line fixed both the bug and the readability:

```ts
readonly period = signal<Period>('THIS_MONTH');
readonly stats = signal<SaleStats | null>(null);

constructor() {
  // the async part: a plain 30s tick, no state baked in
  const tick = toSignal(timer(0, 30_000), { initialValue: 0 });

  effect((onCleanup) => {
    const period = this.period();  // synchronous state — tracked
    tick();                        // async heartbeat — also tracked, forces re-run

    const sub = this.fetchStats(period).subscribe((s) => this.stats.set(s));
    onCleanup(() => sub.unsubscribe());
  });
}
```

Now the two concerns are honestly separated. `period` is a signal because it's state. The 30-second heartbeat is a timer because it's time, and `toSignal` bridges it in as a dependency. The `effect` re-runs when *either* changes — period switch or tick — and `onCleanup` tears down the previous in-flight fetch every time, which is the cancellation I was hand-wiring with nested `switchMap` before. The reactive graph does the bookkeeping I kept getting wrong.

I want to be honest about the tradeoff, because this is also where the advice goes wrong if you take it too far. Running an HTTP subscription *inside* `effect()` is borderline. Effects are meant for syncing reactive state to the non-reactive world — DOM, logging, localStorage — not for being your data-fetching engine. The cleanup discipline above is load-bearing; forget `onCleanup` and you leak a subscription on every tick. For this service the ergonomics won and I keep it under tight watch. But if the fetching logic grows another branch, I'm pulling it back out into a proper RxJS pipeline and using `toSignal` only at the very end to expose the result. Which is the next thing.

## The interop boundary, in one direction mostly

The two meet at exactly two functions: `toSignal` and `toObservable`. Ninety percent of my interop is `toSignal`, and the asymmetry is on purpose.

The pattern I reach for constantly: do the async work in RxJS where it belongs, then hand the *result* to the template as a signal so I'm not sprinkling `| async` everywhere.

```ts
readonly period = signal<Period>('THIS_MONTH');

private readonly period$ = toObservable(this.period);

readonly dashboard = toSignal(
  this.period$.pipe(
    switchMap((period) => this.dashboardGql.fetch({ period })),
    map((r) => r.data.dashboard),
  ),
  { initialValue: null },
);
```

`toObservable` turns the period signal into a stream so I can `switchMap` off it (cancellation again — switching period cancels the stale dashboard request). `toSignal` turns the answer back into a signal so the template reads `dashboard()` with no async pipe and no `null` ceremony past the initial value. State in as a signal, async in the middle as a stream, state out as a signal. That sandwich is most of my reactive code now.

One gotcha that cost me an afternoon: `toSignal` subscribes immediately and *eagerly*, unlike the lazy `| async` which only subscribes when the view binds. If the source has side effects on subscribe — and an Apollo `watchQuery` does, it fires the network call — you get the request earlier than you expect, sometimes before guards you assumed had run. And `toObservable` is backed by an `effect`, so it only works inside an injection context; call it in a random method and you get `NG0203` and a confusing afternoon. Create your interop at field-initializer or constructor time, not lazily.

## Rules of thumb I'd actually defend

If you take one mental model: **does it have a current value you read during render, or does it happen over time?** Current value is a signal. Happens over time is an Observable. Almost everything sorts cleanly on that one question.

A few sharper edges from doing this for real:

- If you catch yourself calling `.getValue()` on a `BehaviorSubject`, that state wanted to be a signal. Convert it.
- If you catch yourself reimplementing `debounceTime`, `switchMap`, or `distinctUntilChanged` with signals and a flag, stop — that's RxJS waving at you. Cancellation and time are not a signal's job.
- Derive with `computed`, not `combineLatest`, when every input is already synchronous state. It's lazy and glitch-free and you stop thinking about subscription sharing.
- `effect()` is for pushing reactive state *out* to the imperative world. Doing async work in it is occasionally worth it, never the default, and always needs `onCleanup`.
- Interop flows mostly one way: async in RxJS, result out via `toSignal`. Reach for `toObservable` only when you specifically need an operator — usually `switchMap` for cancellation.

The trap, if there is one, is treating this as a migration — ripping every `BehaviorSubject` out because signals are new. Most of mine stayed Observables because they were modeling time correctly the whole time. The win wasn't replacing RxJS. It was finally giving the synchronous half of the app a primitive that fit it, so the streams could go back to doing what streams are good at.
