---
title: "Unifying two date-picker styles into one"
description: "Sale Status used native inputs while Sales Report used a Material range picker. Consolidating without a refactor."
date: "2026-06-20"
updated: "2026-06-20"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "material", "forms", "ux"]
month: "2026-06"
repo: "frontend"
author: "Sachal Chandio"
---

Two screens in the same app asked the same question — "what date range do you want?" — and answered it in two completely different shapes. The Sales Report had a proper `mat-date-range-picker`: one field, one calendar, click a start, click an end, done. The Sale Status screen had two bare `<input type="date">` boxes sitting side by side, with the browser's native calendar widget, which on Chrome looks nothing like Material and on Firefox looks nothing like Chrome.

Nobody filed a bug. That's the tell. This is the kind of inconsistency users feel without being able to name it — they hit the report, learn the range picker, switch to status, and their hands reach for the thing that isn't there. It's friction with no error message.

## The pain, and why it had sat there

The native inputs weren't broken. They emitted valid `yyyy-mm-dd` strings, the query fired, the cards updated. From a "does it work" standpoint there was nothing to fix, which is exactly why it had survived three or four feature passes untouched. Native date inputs are the path of least resistance: zero dependencies, no module to import, the browser does the calendar for free.

The cost shows up later. The native widget can't be themed to match the rest of the app. Its locale and first-day-of-week follow the OS, not your app, so a user in one timezone sees Monday-first and another sees Sunday-first on the same screen. And the two-input layout has no concept of a *range* — nothing stops you picking an end date before the start date, so you either validate it yourself or let a nonsensical query through. We were letting it through.

So the actual job wasn't "make it work." It was "make this screen pick a range the same way the report does," and do it without dragging the rest of the screen into the change.

## Constraints I gave myself

The Sale Status screen is busy. Summary cards across the top, a period selector (`TODAY`, `THIS_WEEK`, `THIS_MONTH`, and a recently added `CUSTOM`), and drill-down tables underneath that react to whatever the current range is. The custom range only matters when the period is `CUSTOM`; the rest of the time it's hidden.

I didn't want to touch any of that. The cards already read their values from the same query result, the drill-downs already subscribed to the same range stream. If I rewrote how the range got *into* the component but kept the output identical — same two date values flowing out the bottom — everything downstream would never know the picker changed. That was the whole bet: swap the input mechanism, keep the contract.

Concretely, the contract was two properties the rest of the component already consumed: `customStartDate` and `customEndDate`. Whatever I did up top had to keep feeding those two, in the same `Date` shape, at the same time.

## What I rejected

The first instinct was to copy the report's template wholesale — the `mat-form-field`, the `mat-date-range-input`, the two `[formControl]`s — and paste it in. That works, but the report wired its controls a particular way and I'd be cloning that wiring into a second place. Two copies of the same range-picker glue drift the moment one of them gets a tweak. I've watched it happen.

The second idea was a shared `<app-date-range>` component to wrap the Material picker once and drop it into both screens. Right call eventually, wrong call for this PR. Extracting a component means designing its inputs and outputs, deciding whether it owns its own `FormGroup` or takes one, and re-testing both screens. That's a refactor with its own review surface, and I was trying to fix a visual inconsistency, not open a new front. I left a note to do the extraction later and kept the blast radius to the one file.

So the chosen approach: use the same `MatDateRangePicker` as the report, but drive it from a small reactive form local to this component, and map that form straight onto the `customStartDate` / `customEndDate` the screen already used. No native inputs, no copy-pasted wiring, no new shared component yet.

## Before

The old template was two inputs and two handlers:

```html
<input
  type="date"
  [value]="customStartDate | date:'yyyy-MM-dd'"
  (change)="onStartChange($event)"
/>
<input
  type="date"
  [value]="customEndDate | date:'yyyy-MM-dd'"
  (change)="onEndChange($event)"
/>
```

```ts
onStartChange(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  this.customStartDate = v ? new Date(v) : null;
  this.reload();
}

onEndChange(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  this.customEndDate = v ? new Date(v) : null;
  this.reload();
}
```

Two handlers doing the same thing with different field names. Each one parses the string back into a `Date`, mutates a property, and kicks `reload()`. No guard that end comes after start. And the `| date:'yyyy-MM-dd'` round-trip exists only to feed a native input a format it accepts — pure ceremony for the widget's sake.

## After

One reactive form, one `valueChanges` subscription, the Material range picker in the template.

```ts
import { FormGroup, FormControl } from '@angular/forms';

range = new FormGroup({
  start: new FormControl<Date | null>(null),
  end: new FormControl<Date | null>(null),
});

ngOnInit() {
  this.range.valueChanges
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe(({ start, end }) => {
      // Material only emits a complete range once both ends are set,
      // so we don't fire a half-range query on the first click.
      if (!start || !end) return;
      this.customStartDate = start;
      this.customEndDate = end;
      this.reload();
    });
}
```

```html
<mat-form-field appearance="outline">
  <mat-label>Custom range</mat-label>
  <mat-date-range-input [formGroup]="range" [rangePicker]="picker">
    <input matStartDate formControlName="start" placeholder="Start" />
    <input matEndDate formControlName="end" placeholder="End" />
  </mat-date-range-input>
  <mat-datepicker-toggle matIconSuffix [for]="picker"></mat-datepicker-toggle>
  <mat-date-range-picker #picker></mat-date-range-picker>
</mat-form-field>
```

The two handlers collapsed into one subscription. The `customStartDate` / `customEndDate` properties still exist and still get set — the rest of the component is untouched, which was the point. The cards, the period selector, the drill-downs: none of them changed, because the values they read still arrive the same way.

The `if (!start || !end) return;` line is doing more than it looks. With the native pair, picking a start date immediately mutated state and reloaded — you'd fire a query with a start and a stale or empty end. The range picker emits as you go, but it only hands you a populated `end` after the second click, so guarding on both being present means the query fires once, on a complete range, instead of twice on a half-formed one. The naive version I'd have written a year ago skipped that guard and double-queried; you'd see the loading spinner flicker twice and not know why.

I imported `MatDatepickerModule`, `MatFormFieldModule`, and `MatInputModule` into the standalone component's `imports` array — the report already pulled these in, so they were in the bundle regardless. No new weight.

## Tradeoffs I accepted

I did not extract the shared component. After this change, the report and the status screen each instantiate their own `mat-date-range-picker` with near-identical template blocks. That's duplication, and I knew it going in. The judgment was that one more copy is cheaper *right now* than designing a wrapper's API under the same PR — and crucially, two identical copies are far easier to extract later than one Material picker and one native pair were. I made the future refactor smaller by making both screens speak the same dialect first.

I also accepted that I'm now mapping the form's `start`/`end` onto the component's `customStartDate`/`customEndDate` instead of binding the form straight through. A purist would say the form *is* the source of truth, drop the two extra properties, and have `reload()` read from `this.range.value`. They'd be right. But those two properties were load-bearing — referenced in the template, in `reload()`, and in the period-switch logic that pre-fills a range when you flip to `CUSTOM`. Rewiring all of that is the refactor I was explicitly avoiding. So the form feeds the properties, the properties feed everything else, and there's one assignment of indirection I'm choosing to live with until the extraction.

One real gotcha: when the user switches the period selector *away* from `CUSTOM` and back, I reset the form with `this.range.setValue(...)` to pre-populate the last range. That fires `valueChanges`. If you set both ends in one `setValue` call it emits once with both populated and sails straight past the guard into a `reload()` you didn't ask for. The fix was `setValue(..., { emitEvent: false })` on the programmatic resets, so only genuine user picks trigger a query. That's the line that'll bite you if you copy this pattern — `valueChanges` doesn't know the difference between a human and your own code unless you tell it.

The screens match now. Same calendar, same field, same behavior when you pick a start after an end (the picker just won't let you). Nobody will file a bug thanking me for it, which is about the highest praise this kind of work gets.
