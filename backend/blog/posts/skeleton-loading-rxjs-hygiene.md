---
title: "Skeleton loading and RxJS unsubscribe hygiene on the sales report"
description: "Making a data-heavy page feel fast and not leak while it streams."
date: "2025-09-03"
updated: "2025-09-03"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "rxjs", "ux"]
month: "2025-09"
repo: "frontend"
author: "Sachal Chandio"
---

The sales report on the homepage is a bar chart of agents ranked by call conversion rate. Five bars, an avatar perched on the tip of each, a date-range picker in the header. Once it started pulling live numbers off the analytics service instead of the hardcoded `getFallbackSalesAgents()` list I'd been demoing with, two problems showed up that the fake data had been hiding.

First, the page flickered. Empty, then a spinner, then bars snapping into place — the layout jumped every time the query came back. Second, every time someone nudged the date range, I was wiring up another subscription, and on a page that sits open all shift that adds up. Neither is the kind of thing anyone files a ticket for. They just make the app feel cheap and, eventually, slow.

This is the cleanup pass. Skeleton loading so the page has shape before the data lands, and a hard look at the subscriptions feeding it.

## Why a spinner wasn't enough

The first version was honest and ugly. A boolean `isLoading`, an absolutely-positioned overlay with a spinning border, done:

```html
@if (isLoading) {
  <div class="loading-overlay">
    <div class="loading-spinner"></div>
    <p class="loading-text">{{ t("homepage.widgets.salesReport.loading") }}</p>
  </div>
}
```

The overlay itself was fine — I deliberately made it `position: absolute` and confined it to the content area so it wouldn't blow out the card's height. The problem is what's underneath. While loading, the `agent-bars-container` is empty, so it collapses. The spinner floats in a short box. Then data arrives, five bars 14.87rem tall pop in, and the whole card grows by a couple hundred pixels. Anything below it on the dashboard lurches down.

A spinner tells you something is happening. It doesn't tell the layout how big to be. That's the actual job here: reserve the space, hint at the shape, and let the real content swap in without anyone's eyes having to re-find where things are.

So the loading state isn't a spinner anymore. It's five fake bars at the real height.

## The skeleton

The template branches three ways now — loading-with-overlay is gone in favor of an `@else` that renders skeleton bars with the same structure as the real ones:

```html
@if (!isLoading) {
  <div class="agent-bars-container">
    @for (agent of salesAgents; track agent; let i = $index) {
      <!-- real bar, avatar, dots -->
    }
  </div>
} @else {
  <div class="agent-bars-container">
    @for (item of getSkeletonItems(); track $index; let i = $index) {
      <div class="agent-bar-wrapper">
        <div class="performance-bar-container">
          <div class="agent-profile">
            <div class="agent-avatar skeleton-avatar"></div>
          </div>
          <div
            class="performance-bar regular-bar skeleton-bar"
            [style.height]="getSkeletonBarHeight(i)"
          >
            <div class="bar-dots">
              @for (dot of [].constructor(3); track $index) {
                <div class="dot"></div>
              }
            </div>
          </div>
        </div>
      </div>
    }
  </div>
}
```

The key is that the skeleton lives inside the same `agent-bars-container` with the same `performance-bar-container` (which is the thing that's `14.87rem` tall). The container holds its height whether it's holding a real bar or a fake one. No collapse, no jump.

The component side is deliberately dumb. No state, no service calls — just enough to make the skeleton look like data instead of five identical gray rectangles:

```ts
// Skeleton loading methods
getSkeletonItems(): number[] {
  return Array(5).fill(0); // Show 5 skeleton items
}

getSkeletonBarHeight(index: number): string {
  // Vary skeleton bar heights for more realistic loading appearance
  const heights = ['80%', '60%', '90%', '45%', '70%'];
  return heights[index % heights.length];
}
```

Those varied heights matter more than they look. A row of equal-height placeholders reads as a loading widget — your eye registers "UI chrome," not "content arriving." Five bars of different heights read as a chart that hasn't filled in yet. It's a cheap trick and it works.

The shimmer is pure CSS, a moving gradient on a 400%-wide background:

```scss
.skeleton-bar {
  background: linear-gradient(
    90deg,
    var(--sr-border) 25%,
    var(--sr-surface-3) 37%,
    var(--sr-border) 63%
  );
  background-size: 400% 100%;
  animation: skeleton-shimmer 1.2s ease-in-out infinite;
}

@keyframes skeleton-shimmer {
  0%   { background-position: 100% 0; }
  100% { background-position: 0 0; }
}
```

Because the colors are theme tokens (`--sr-border`, `--sr-surface-3`), the skeleton goes dark with the rest of the app for free. The `:host-context(.dark-theme)` block redefines those variables and the shimmer follows. No second set of skeleton styles for dark mode, which is the only reason I bothered theming the placeholders at all.

One thing I'd flag if you copy this: `track agent` on the real list and `track $index` on the skeleton. The skeleton items are interchangeable, so index tracking is correct and the cheapest option. For the real bars I track the agent object because identity matters when the list reorders by conversion rate — track by index there and Angular reuses DOM nodes across different agents, which fights the height transitions.

## The unglamorous half: who's actually subscribed

With the visual side calm, the date picker. The header has a hidden Material range picker; the user picks a range, and on a 500ms debounce I refetch just the sales report — not the whole dashboard:

```ts
private setupDateRangeSubscription(): void {
  this.dateRangeSubscription = this.dateRangeForm.valueChanges
    .pipe(debounceTime(500), distinctUntilChanged())
    .subscribe((dateRange) => {
      if (dateRange.fromDate && dateRange.toDate) {
        this.loadDataForDateRange(dateRange.fromDate, dateRange.toDate);
      }
    });
}
```

`valueChanges` is a stream that lives as long as the form does, which is as long as the component does. If you subscribe and walk away without tearing it down, the subscriber sticks around holding a reference to the component, and the component can't be collected. One leaked subscriber per mount. The sales report mounts and unmounts as you move around the dashboard, so it adds up over a shift exactly the way users describe — "fine in the morning, sluggish by three."

The fix here is the boring one and I'll defend it: hold the `Subscription`, kill it in `ngOnDestroy`.

```ts
private dateRangeSubscription: Subscription | null = null;

ngOnDestroy(): void {
  document.removeEventListener('click', this.closeDropdownOnClickOutside);
  if (this.dateRangeSubscription) {
    this.dateRangeSubscription.unsubscribe();
  }
}
```

Note the second line in there — the dropdown menu wires a `document` click listener to close on click-outside, and that leaks too if you forget it. Subscriptions get all the attention, but a raw `addEventListener` on `document` is the same class of bug: a long-lived object holding a reference to a short-lived component. I almost missed it because it isn't an Observable. The audit isn't "find the subscribes," it's "find everything that outlives the component and points back at it."

## Two patterns, and when I reach for each

The search component on the same page does it differently, and on purpose. It has several subscriptions — the debounced input, a couple of dialog-data fetches — so it uses the `takeUntil(destroy$)` pattern:

```ts
private readonly destroy$ = new Subject<void>();

ngOnInit() {
  this.searchControl.valueChanges
    .pipe(
      debounceTime(150),
      distinctUntilChanged(),
      takeUntil(this.destroy$),
    )
    .subscribe((query) => { /* ... */ });
}

ngOnDestroy() {
  this.realTimeSearchService.endCurrentSession();
  this.destroy$.next();
  this.destroy$.complete();
}
```

One `destroy$`, every stream piped through `takeUntil(this.destroy$)`, one `next()` in `ngOnDestroy` tears all of them down at once. You can't forget to unsubscribe from stream number four because there's no per-stream bookkeeping to forget — the operator does it. That's the right call the moment a component has more than one subscription.

The sales report has exactly one Observable subscription, so I left it on the manual `Subscription` handle. Adding a `Subject`, a `takeUntil`, and a two-line `ngOnDestroy` ritual to manage a single stream is ceremony for ceremony's sake. If I add a second subscription to that component, I'll switch it over to `takeUntil` in the same commit — but I'm not going to pretend one subscription needs the machinery for five.

The honest modern answer is `takeUntilDestroyed()` from `@angular/core/rxjs-interop`, which ties the teardown to the injection context and deletes the `ngOnDestroy` boilerplate entirely. I'm migrating toward it, but not in this PR. Mixing a half-converted component into an unrelated UX change is how you turn a clean diff into a thing reviewers have to untangle.

## The effect that almost undid all of it

The part I'd genuinely do differently is how the data lands. The component reads the service's signals inside an `effect()`:

```ts
effect(() => {
  const loading = this.analyticsService.isSalesReportLoading();
  this.isLoading = loading;
  const salesData = this.analyticsService.salesData();

  if (Array.isArray(salesData) && salesData.length > 0) {
    // map, sort by conversion rate, paginate
  } else {
    this.allSalesAgents = this.getFallbackSalesAgents();
  }
});
```

This works, and the skeleton-to-data swap is smooth because `isLoading` flips inside the same reactive pass that sets the agents. But there are two effects in the constructor both reading `isSalesReportLoading()` and both writing `this.isLoading`, which is one too many — they're racing to set the same field, and it took me a confused ten minutes to figure out why a `console.log` was firing twice per load. The fallback logic is also doing too much: it treats an all-zeros response as "empty, show fake data," which is great for a demo and a genuine trap in production, because a real slow day with zero conversions looks identical to no data and silently shows fictional agents. That's a bug waiting for the first quiet Sunday. I've got it flagged to collapse into one effect and to distinguish "loaded, all zeros" from "not loaded yet" with a real empty state instead of fallback fiction.

Skeleton loading is the cheap, visible win — an afternoon of work, and the page stops flinching. The subscription hygiene is the part nobody sees and the part that decides whether the app is still pleasant to use at hour seven. Here's where it bites: the leak never shows up on your machine, because you reload constantly while developing. It shows up on the one user who opens the dashboard at 9am and doesn't refresh until lunch.
