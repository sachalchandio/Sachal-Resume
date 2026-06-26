---
title: "From a 100ms interval to a signal effect: killing the polling that leaked"
description: "A global event service polled ten times a second and never cleaned up. Replacing it with reactive signals."
date: "2025-09-24"
updated: "2025-09-24"
kind: "deepdive"
category: "Performance"
tags: ["angular", "rxjs", "signals", "memory"]
month: "2025-09"
repo: "frontend"
author: "Sachal Chandio"
---

The laptop fan was the first symptom. Not a stack trace, not a red badge in the console — just the fan spinning up every time someone left the Telelinkz dashboard open in a background tab. A sales lead pinged me: "Chrome says this tab is using a lot of energy." I opened the same page, left it alone, and watched the Task Manager row for that process climb. Idle page. No mouse, no network. CPU sitting at a steady few percent that should have been zero, and the memory line drifting up and to the right like a slow lease.

That last part is the tell. CPU you can sometimes wave away as "the framework doing framework things." A memory graph that only goes up is a leak, and a leak means something is alive that should be dead.

## The first guess was wrong

My instinct was Apollo. We lean on `@apollo/client` hard — the live sales feed, the agent presence indicators, a dozen GraphQL subscriptions over a websocket. The mental model wrote itself: a subscription opens, the component navigates away, the subscription never closes, the cache holds references, memory grows. Classic. I spent a good half hour in the Apollo devtools watching active subscriptions, counting them as I navigated between routes. They closed when they should. The websocket count was flat. The cache was being evicted on the GC interval like it's supposed to.

So I took a heap snapshot in the Chrome Performance Monitor, left the tab parked for two minutes, took another, and diffed them. The thing that grew wasn't a GraphQL document or a normalized cache entry. It was a pile of closures and `Subscriber` objects, retained by something with `setInterval` in its retainer chain.

That word — `setInterval` — is what redirected the whole investigation. I grepped:

```bash
git grep -n "setInterval" src/
```

One hit that mattered. Our global `EventBusService`.

## What the service actually did

We had a small service whose job was to let unrelated parts of the app know "something happened" — a sale got recorded, a lead status flipped, a notification arrived — so they could refetch or flash a toast. The original author (me, six months earlier, in a hurry) built it as a polled inbox. Events got pushed into a buffer, and a timer woke up ten times a second to see if there was anything new.

Here's the shape of it, lightly trimmed:

```ts
@Injectable({ providedIn: 'root' })
export class EventBusService {
  private latestEventId = 0;
  private buffer = new Map<number, AppEvent>();
  private readonly events$ = new Subject<AppEvent>();

  constructor() {
    // wake up 10x a second and drain whatever arrived
    setInterval(() => {
      const ids = [...this.buffer.keys()].sort((a, b) => a - b);
      for (const id of ids) {
        this.events$.next(this.buffer.get(id)!);
        this.buffer.delete(id);
      }
    }, 100);
  }

  push(event: AppEvent) {
    this.buffer.set(++this.latestEventId, event);
  }

  on(type: AppEvent['type']): Observable<AppEvent> {
    return this.events$.pipe(filter((e) => e.type === type));
  }
}
```

Two things are wrong here, and they compound.

The interval is the obvious one. It runs forever, 864,000 times a day, almost always to discover that the buffer is empty. Each tick allocates an array from `buffer.keys()`, sorts it, walks it. None of that work is free, and because the service is `providedIn: 'root'` it lives for the entire lifetime of the app. Chrome was right about the energy. A 100ms timer that does real work — even small work — never lets the CPU drop into a deep idle state. The fan was the truth.

But the interval alone doesn't leak memory. The leak was on the consumer side, and the polling design was quietly hiding it.

## The stragglers

Several components subscribed to `eventBus.on(...)` in `ngOnInit` and never unsubscribed. Like this one, on the sales dashboard:

```ts
ngOnInit() {
  this.eventBus.on('SALE_RECORDED').subscribe(() => {
    this.refetchTotals();
  });
}
```

No `ngOnDestroy`. No `takeUntil`. The component gets destroyed when you navigate away — Angular tears down its view — but the subscription it registered on the long-lived `events$` Subject does not get torn down. The Subject keeps a reference to the subscriber, the subscriber's closure keeps a reference to the component instance (`this.refetchTotals`), and now the dead component can't be collected. Navigate to the dashboard and back five times, and you've got five zombie dashboards in memory, all of them still firing `refetchTotals()` every time a sale event comes through. That's the climbing line.

It's a textbook RxJS leak: **subscribing to a service-scoped Observable from a component-scoped lifecycle without cleanup.** The Observable outlives the component, so the component outlives itself.

I want to be honest about why I didn't catch this for months. The polling design masked the cost. Because events only flowed on the 100ms tick, and because `refetchTotals` was cheap and idempotent, the zombies didn't produce visibly wrong numbers — they produced *redundant* work that looked like the app being busy. If a leaked subscriber had been doing something visible, like double-rendering a row, someone would have filed a bug in week one. Instead it just got slower and warmer, which is exactly the kind of decay nobody files a ticket for until the fan gets loud.

## The fix, in two parts

The interval had to go, and the stragglers had to clean up after themselves. I did both.

First, the interval. The whole point of the timer was to notice when a new event arrived. That's a state change — exactly what an Angular signal plus `effect()` is for. I made the latest event ID a signal and let an effect run only when it actually changes:

```ts
@Injectable({ providedIn: 'root' })
export class EventBusService {
  private readonly newEventId = signal(0);
  private buffer = new Map<number, AppEvent>();
  private readonly events$ = new Subject<AppEvent>();

  constructor() {
    // runs once on creation, then only when newEventId changes
    effect(() => {
      const upTo = this.newEventId();
      const ids = [...this.buffer.keys()]
        .filter((id) => id <= upTo)
        .sort((a, b) => a - b);
      for (const id of ids) {
        this.events$.next(this.buffer.get(id)!);
        this.buffer.delete(id);
      }
    });
  }

  push(event: AppEvent) {
    const id = this.newEventId() + 1;
    this.buffer.set(id, event);
    this.newEventId.set(id); // <-- this is the only thing that wakes the drain
  }

  on(type: AppEvent['type']): Observable<AppEvent> {
    return this.events$.pipe(filter((e) => e.type === type));
  }
}
```

Now the drain code runs on the leading edge of a real `push`, and at no other time. A parked tab with no events does zero work. The Performance Monitor CPU row for that process dropped to a flat line at idle — the fan stopped.

One detail that bit me here for about ten minutes: an `effect()` reads its dependencies on the *current* tick, so the first version of my drain looped over `buffer.keys()` directly without the `<= upTo` filter, and `upTo` ended up unused — which meant the effect had no tracked dependency on the signal and only ran once, at construction. Angular even warns about effects that don't read a signal, but it was buried. The fix is to actually *use* the signal value inside the effect, which the `filter((id) => id <= upTo)` does. If you write an effect and it only fires once, the first thing to check is whether the body genuinely reads the signal you think it does.

Second, the stragglers. For the components that subscribe imperatively, I added the boring, correct teardown. A `destroy$` Subject and `takeUntil`:

```ts
export class SalesDashboardComponent implements OnInit, OnDestroy {
  private readonly destroy$ = new Subject<void>();

  ngOnInit() {
    this.eventBus
      .on('SALE_RECORDED')
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.refetchTotals());
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
```

For the newer standalone components I went a step further and used `takeUntilDestroyed`, which grabs the injection-context `DestroyRef` and saves the ceremony:

```ts
ngOnInit() {
  this.eventBus
    .on('SALE_RECORDED')
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe(() => this.refetchTotals());
}
```

After this, the same five-navigations-and-back test showed one dashboard in the heap, not five. The diff between two snapshots two minutes apart was noise — a few hundred bytes, not megabytes.

## Why I didn't just convert everything to signals

It's tempting, when signals are the new shiny, to rip out every Subject and replace it with a signal or a `toSignal()`. I didn't, and I'd push back on anyone who tries. The event bus is genuinely a *stream of discrete events* — a sale happened, then another sale happened. That's what a `Subject` models well. Signals model *state*: the current value of a thing, where you only care about the latest. If I'd shoved the events through a signal, two sales arriving inside the same change-detection tick would collapse into one notification, because a signal only remembers its current value. I'd have traded a performance bug for a correctness bug.

So the split I landed on is: signal for the *trigger* (something changed, wake up), Subject for the *payload delivery* (here is each event, in order). The signal replaced the timer; it did not replace the stream. That distinction is the actual lesson, more than any of the code above.

## When this bites you

Reach for the heap snapshot, not your intuition, the moment a page's memory only climbs. I burned half an hour blaming Apollo because subscriptions-that-leak was the failure mode I'd seen before, and pattern-matching beat measurement. The retainer chain in the snapshot pointed straight at the culprit in about ninety seconds once I actually looked.

And the structural rule, the one I now grep for in reviews: **any `setInterval` in application code is a question, not an answer.** Sometimes the honest answer is "I need to poll an external thing on a schedule I don't control," and that's fine. But more often the interval is there because someone needed to react to a change and reached for the bluntest possible tool — *check constantly* — instead of *be told*. Signals, effects, and Subjects are all ways of being told. If you can name the exact state change you're waiting for, you don't need a timer; you need to make that change observable. The interval that polls ten times a second to find nothing is, almost always, a `signal` that nobody created yet.
