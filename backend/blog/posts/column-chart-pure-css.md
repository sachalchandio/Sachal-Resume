---
title: "A scrollable column chart with pure CSS, no charting library"
description: "Sometimes you don't need ECharts. Building a horizontal column chart out of CSS grid and a height function."
date: "2026-06-22"
updated: "2026-06-22"
kind: "deepdive"
category: "Data Viz"
tags: ["css", "angular", "dataviz"]
month: "2026-06"
repo: "frontend"
author: "Sachal Chandio"
---

The provider breakdown on the dashboard was a list. AT&T, 412 sales. Spectrum, 388. Frontier, 201. Down and down it went, one provider per row, a thin label and a number, fourteen rows for an account that sold through fourteen carriers. It worked. It was also the least useful shape that data could possibly take.

The problem with a vertical ranked list is that the only comparison it makes easy is rank. You can see that AT&T is above Spectrum. You cannot see that AT&T is *barely* above Spectrum while both of them tower over the bottom eight. The numbers are right there and your eye still can't do the subtraction. A list answers "in what order" and stays silent on "by how much," and "by how much" was the entire question the sales managers were asking it.

I could have reached for ECharts. We already use it everywhere else on that page — the donut, the trend lines, the activity heatmap all ride on it. Adding a bar series would have been ten minutes of config. I didn't, and most of this post is the argument for why.

## What the list was costing in space

Fourteen rows of `label + number` at a comfortable line height is a tall card. On the dashboard, where this thing shares a row with three other tiles, "tall" means it either blows the grid out vertically or gets a scrollbar and becomes a thing you have to *operate* rather than glance at. Vertical scroll on a dashboard tile is a small defeat every time — you've taken a summary and turned it into a list view.

A horizontal layout flips that. Provider columns side by side, each one as tall as its count deserves, and when there are more providers than fit, you scroll *sideways*. Horizontal scroll on a band of columns reads as "there's more over here," which is exactly true and doesn't fight the vertical rhythm of the rest of the page. The card stays one fixed height. The data overflows along the axis nobody else on the page is using.

And the bars do the comparison for you. That's the whole point of a bar. Two columns next to each other, one twice as tall, and you've understood the ratio before you've read either number.

## Why not just use the chart library

ECharts would render this. It would also render it *fine*. So the case against it isn't that it can't — it's that every one of its strengths is dead weight for this particular job.

A charting library earns its size when you need axes, tooltips that track the cursor, zoom-and-pan, a legend that toggles series, animated transitions between datasets, responsive reflow on a dozen breakpoints. This widget needs none of that. There's no x-axis worth labeling — the labels *are* the columns. There's no continuous y-axis; the height is the only quantity and the number is printed right on it. No second series, so no legend. No zoom. The "tooltip" is just the count, which is already visible, so there's nothing to reveal on hover.

Strip a bar chart down to "logo, name, count, and a height that means something" and what's left is a flexbox and an arithmetic. Pulling in a canvas renderer and an option object with forty keys to draw four `<div>`s is the kind of thing you do on autopilot and regret when you're chasing why the dashboard bundle is what it is. ECharts isn't free — it's a real chunk of JS, it initializes against a DOM node, it wants a resize observer, and it renders to canvas, which means the column labels aren't selectable text and aren't in the accessibility tree without extra work. For a tile this simple, hand-built HTML is *less* code, lighter, and the logos and names come out as real DOM that the browser already knows how to make accessible.

I'm not anti-library. The heatmap on that same page would be miserable to hand-roll and ECharts is the right call there. The judgement is per-widget: does the job need the machinery, or does the machinery need a job. This one didn't.

## The grid

Each column is the same three-row stack: logo on top, the height-driven bar in the middle, name and count at the bottom. The cleanest way to keep all the logos aligned on one line, all the names on another, regardless of how tall the middle bar is, was CSS grid with named rows.

```scss
.provider-chart {
  display: grid;
  grid-auto-flow: column;          // new providers add columns, not rows
  grid-auto-columns: 4.5rem;       // every column the same width
  grid-template-rows: auto 1fr auto; // logo | bar (flex) | label
  gap: 0.75rem;
  align-items: end;                // bars grow up from a shared baseline
  overflow-x: auto;                // the scroll
  padding-bottom: 0.5rem;          // room for the scrollbar
}
```

`grid-auto-flow: column` is the line doing the real work. It says: when I hand you children, lay them out left to right and make a new column for each, never wrap to a new row. Combined with `grid-auto-columns: 4.5rem`, every provider gets an identical-width column and the whole band just keeps extending rightward past the edge of the card, where `overflow-x: auto` catches it and gives you the scroll.

`grid-template-rows: auto 1fr auto` is what keeps the three bands honest. The logo row and the label row are `auto` — as tall as their content, no more. The middle row is `1fr`, so it eats all the leftover vertical space, and that's the track the bar lives and grows in. Because every column shares the same three-row template, the logos sit on one line and the names sit on one line across the entire chart even though the bars between them are all different heights. `align-items: end` pins everything to the bottom of its cell so the bars rise from a common baseline instead of floating.

A single column's markup, in the Angular template:

```html
<div class="provider-chart">
  @for (p of providers(); track p.code) {
    <div class="provider-col">
      <img class="provider-col__logo" [src]="p.logoUrl" [alt]="p.name" />
      <div class="provider-col__bar"
           [style.height.%]="barHeight(p.count)">
        <span class="provider-col__count">{{ p.count }}</span>
      </div>
      <span class="provider-col__name">{{ p.name }}</span>
    </div>
  }
</div>
```

`providers()` is a signal. The whole thing recomputes and re-renders when the dashboard filters change, no chart `setOption` lifecycle to babysit, no manual dispose on destroy. It's just a `@for`.

## The height function

Heights are relative to the tallest column, not absolute. If I mapped count straight to pixels, one provider with 4000 sales would be a skyscraper and the rest would be a flat smear at the bottom. So the tallest column is always 100% of the track and everyone else is a percentage of *that*.

```ts
import { computed, signal } from '@angular/core';

readonly providers = signal<ProviderCount[]>([]);

private readonly maxCount = computed(() =>
  Math.max(1, ...this.providers().map((p) => p.count)),
);

barHeight(count: number): number {
  const MIN_PCT = 8;   // floor so a tiny bar is still a clickable, labelable bar
  const pct = (count / this.maxCount()) * 100;
  return Math.max(MIN_PCT, pct);
}
```

Two things in there are load-bearing and both came from being burned.

`Math.max(1, ...)` on `maxCount`. The day the filter returns zero sales for every provider — a date range with no data, which happens constantly when someone picks "yesterday" on a Sunday — `maxCount` is the max of an empty-ish set and `count / 0` is `NaN`, and `[style.height.%]="NaN"` gives you columns of indeterminate height, which renders as garbage. Flooring the denominator at 1 means an all-zero chart is just a row of minimum-height stubs, which is the correct way to say "nothing here" rather than a layout explosion.

`MIN_PCT = 8`. Without a floor, a provider with 2 sales next to one with 400 gets a bar that's half a percent tall — a hairline you can't see, can't read the count on, and that looks like a rendering bug. The floor is a small lie about the data (an 8% bar might really be 0.5% of the max) but it's an honest *affordance*: every provider that exists gets a bar you can actually perceive, and the printed number on it keeps the magnitude truthful. The bar says "I'm here"; the number says "but barely." That's the right division of labor.

## The sharp edges

The first one cost me an embarrassing amount of time: **the count label clipping inside short bars.** I put the `<span>` count *inside* the bar, vertically centered, which is gorgeous on tall bars and invisible on short ones — an 8% bar is shorter than the text it's supposed to contain, so the number either clips or overflows into the bar below. The fix was to let short bars push their label *above* the fill instead of inside it. A column knows it's short, so the label flips out:

```scss
.provider-col__bar {
  position: relative;
  background: var(--chart-bar-fill);
  border-radius: 4px 4px 0 0;
  min-height: 1.5rem;              // never shorter than the count text
}

.provider-col__count {
  position: absolute;
  top: 0.25rem;                    // sit at the top of the bar...
  left: 50%;
  transform: translate(-50%, -120%); // ...then float just above it
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
```

`tabular-nums` is a detail I'd defend to anyone. The provider names and counts sit in a row, and with proportional figures a `412` and a `188` don't line up their digits, so the eye gets a subtle jitter scanning across. Tabular figures give every digit the same advance width and the numbers sit in tidy columns. Free, one line, and it's the difference between "looks built" and "looks assembled."

Second edge: **scroll discoverability.** Horizontal overflow is invisible until you happen to scroll. There's no scrollbar arrow screaming "more to the right" the way a vertical list's scrollbar does, because horizontal scrollbars are thin and people ignore them. So I added a fade mask on the right edge of the card — a gradient overlay that's opaque-to-transparent — so the rightmost visible column looks like it's sliding under something, which reads as "continues offscreen." It's a CSS `mask-image` on the scroll container, and it's the cheapest possible "there's more" signal:

```scss
.provider-chart {
  // ...grid props from before...
  mask-image: linear-gradient(to right, #000 92%, transparent);
}
```

It's not perfect — the fade is there even when you've scrolled to the end and there's nothing more to reveal, which is a tiny lie. Doing it *right* means a scroll listener that toggles the mask based on `scrollLeft` versus `scrollWidth`, and I've been down the resize-and-scroll-listener road on this codebase before and it leaks if you're not careful. For a dashboard tile, the always-on fade is the right amount of effort. If it were the main view I'd wire the listener.

Third, and the one that's most "it's a div, not a chart": **logos are images, and images fail.** A new provider gets added to the system before someone uploads its logo, and now there's a broken-image glyph sitting in my nice chart. Charting libraries don't have this problem because they don't render your assets. I do. So every logo gets an `(error)` fallback to a generated initials chip, the same avatar utility we use everywhere else for missing user photos — turns out a missing provider logo and a missing user avatar are the same problem and deserve the same answer.

## Where this approach stops being the right one

The moment this widget needs a real second dimension, hand-rolling stops paying. If someone asks to stack each column by sale status — approved on top of pending on top of cancelled — I can do it with nested flex, but I'm now reimplementing stacked-bar geometry, and the next ask after that is a tooltip breaking down the stack, and the one after that is "can it animate when I change the filter," and three asks in I've hand-built a worse version of the chart library I declined. The honest tripwire is: the day this needs an axis, a legend, or a tooltip that shows something not already on screen, rip it out and use ECharts. Until then it's four divs and an arithmetic, and that's not a compromise — that's the right tool being small.

The thing I'd tell myself starting over: build the height function first and test it against the ugly inputs — all zeros, one giant outlier, a single provider, a hundred providers — before you write a line of CSS. Every sharp edge I hit was the data being meaner than the happy path, and the layout was the easy part. The grid took twenty minutes. The `Math.max(1, ...)` took an afternoon of staring at a chart of `NaN`.
