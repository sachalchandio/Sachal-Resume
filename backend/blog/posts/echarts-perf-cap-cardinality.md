---
title: "Rendering ten times the data: capping cardinality in ECharts"
description: "Heatmaps and bar charts choke past a hundred points. Top-N capping and precomputed index maps."
date: "2025-10-11"
updated: "2025-10-11"
kind: "deepdive"
category: "Data Viz"
tags: ["echarts", "performance", "angular"]
month: "2025-10"
repo: "frontend"
author: "Sachal Chandio"
---

The operations heatmap on the analytics page took most of a second to paint, and when it finally did, it was unreadable. A wall of tiny colored squares — every operation we'd ever logged against every day in the range — packed so tight you couldn't tell where one cell ended and the next began. The bar chart underneath it was worse in a different way: forty-some bars crammed into a fixed-width card, labels rotated 90 degrees and still overlapping, the whole thing a gray smear. Someone on the sales-ops side asked me, not unkindly, what they were supposed to *do* with it.

Nothing. The honest answer was nothing. We'd been adding providers and operation types for months, and the charts had quietly crossed the line from "dense" to "noise" without anyone deciding they should. The data hadn't gotten more useful. There was just more of it.

## The two problems are not the same problem

It's worth separating them, because I conflated them at first and wasted an afternoon tuning the wrong thing.

One problem is *rendering cost*. ECharts is canvas by default, and canvas is fast, but a heatmap series is one rendered rect per `(x, y)` pair. Fifty operations across a sixty-day window is three thousand cells, each with its own `itemStyle` lookup and a tooltip slot. Re-render that on every filter change — and our dashboard re-renders the whole option object on every filter change, because that's how the Angular wrapper was wired — and you feel it. Not a freeze, but a hitch. A few hundred milliseconds where the card goes blank and then snaps back.

The other problem is *legibility*. This one has nothing to do with the framework. Even if ECharts painted three thousand cells instantly, a human cannot read three thousand cells. There is no monitor wide enough to give an operation-by-day heatmap with fifty rows enough vertical space for the row labels to not collide. The chart was slow *and* it was useless, and those are two separate bugs that happen to share a root cause: too many things on screen.

The root cause points at the same fix for both. Show fewer things. The trick is choosing *which* fewer.

## Top-N, not sampling

The naive way to thin a chart is to sample — take every third operation, or the first thirty in whatever order the query returned them. I've seen that done and it's worse than the disease, because now the chart is both incomplete *and* arbitrary. The operation someone is looking for is missing for no reason they can see.

The version that actually helps is to rank by the thing the viewer cares about and keep the top slice. For the heatmap, "busiest operations" — sum the activity across the window and keep the thirty with the most. For the bar chart, the top 25 by count. The long tail of operations that fired twice last month is exactly the part nobody is scanning for, and folding it away is the point, not a regret. You're not hiding data so much as admitting that rank 47 was never going to earn its row.

So before anything goes into a series, I rank and slice:

```ts
const HEATMAP_MAX_OPS = 30;
const BAR_MAX_OPS = 25;

// total activity per operation across the whole window
const totals = new Map<string, number>();
for (const row of rows) {
  totals.set(row.operation, (totals.get(row.operation) ?? 0) + row.count);
}

const topOperations = [...totals.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, HEATMAP_MAX_OPS)
  .map(([op]) => op);
```

`topOperations` is now the y-axis. Thirty rows, ordered busiest-first, and the heatmap reads top-to-bottom as a ranking, which is a bonus I didn't plan — the most active operation is always the top row, so the eye lands on it first.

I keep the cutoff a named constant rather than a magic `30` buried in the mapping, because the right number is a judgement call that depends on the card height, and I knew I'd be tuning it. Thirty was where the row labels stopped colliding on a 1440p screen at our card width. On a denser layout it'd be lower. It's a layout constant pretending to be a data constant, and naming it keeps that honest.

## The indexOf that was eating the build loop

Once the rows are capped, you have to place each data point at the right `[x, y]` coordinate in the heatmap grid. My first pass did the obvious thing and it was quietly O(n·m):

```ts
// before — indexOf inside the hot loop
const data = rows.map((row) => [
  dates.indexOf(row.date),            // walks `dates` every call
  topOperations.indexOf(row.operation), // walks `topOperations` every call
  row.count,
]);
```

Every `indexOf` is a linear scan. With sixty dates and thirty operations, each data point pays up to ninety comparisons just to figure out where it lives, and you do that for every row that survived the cap. It's not catastrophic at this size — we're talking low thousands of operations — but it's pure waste, and it's the kind of waste that scales with exactly the dimensions we keep growing. Add providers, widen the date range, and the quadratic term is the one that bites.

The fix is the boring correct one: build a lookup map once, then read from it.

```ts
// after — precomputed index maps, O(1) lookups
const dateIndex = new Map(dates.map((d, i) => [d, i]));
const opIndex = new Map(topOperations.map((op, i) => [op, i]));

const data = rows
  .filter((row) => opIndex.has(row.operation)) // drop the rows we capped away
  .map((row) => [
    dateIndex.get(row.date)!,
    opIndex.get(row.operation)!,
    row.count,
  ]);
```

Two things happened in that diff besides the speed. The `filter` on `opIndex.has` is now doing real work — it's how the capped-away operations get dropped from the data entirely. With `indexOf`, a missing operation returned `-1`, which ECharts cheerfully interpreted as a coordinate, so capped operations were leaking back in as a phantom row at index `-1`. I'd actually shipped that. Nobody noticed because it rendered just off the visible grid, but it was there in every option object, a ghost row of data the chart was carrying and never showing. The map made the membership test explicit and the ghost went away.

## Telling ECharts to stop trying so hard

With cardinality capped, the rendering cost mostly took care of itself — fewer cells is fewer cells. But two ECharts options earned their place for the re-render hitch on filter changes.

```ts
const heatmapOption: EChartsOption = {
  animation: false,
  series: [
    {
      type: 'heatmap',
      large: true,
      data,
      // ...
    },
  ],
  // ...
};
```

`animation: false` is the one that mattered most, and it's almost embarrassing how much. By default ECharts animates every series into place on `setOption` — a few hundred milliseconds of easing. That's lovely for a single chart you load once. It is actively annoying on a dashboard where the whole option rebuilds every time someone flips a filter, because now every filter flip costs an animation you didn't ask for, and the chart *feels* slow precisely because it's spending time looking smooth. Killing the animation made filtering feel instant. The render was always fast; the easing was the lag.

`large: true` switches the series to a path optimized for high point counts. At thirty-by-sixty it's marginal — honestly I can't measure the difference at our size — but it's free and it's the correct flag for a heatmap that's allowed to grow, so it documents intent more than it buys speed today. If I ever raise the cap, it's already there.

I did *not* reach for `progressive` rendering, which chunks drawing across frames. That's the tool for genuinely large series — tens of thousands of points — and using it here would be solving a problem I'd just deleted. Capping cardinality and then progressively rendering the small result is admitting you don't trust your own cap.

## Tooltips that read like a human wrote them

The last fix is the smallest and the one people noticed most. Raw counts in a tooltip are noise once they're more than three digits. `5341` makes you stop and parse the magnitude; `5.3K` you read at a glance. So every value that surfaces in a tooltip or an axis label goes through a formatter:

```ts
function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${value}`;
}
```

Wired into the tooltip, with the operation name and date pulled from the axes we built:

```ts
tooltip: {
  formatter: (p: any) => {
    const [x, y, count] = p.data as [number, number, number];
    return `${topOperations[y]}<br/>${dates[x]}: <b>${formatCount(count)}</b>`;
  },
},
```

That's the whole thing. It doesn't make the chart faster. It makes the chart *answer the question* — "how busy was this operation on this day" — in a glance instead of a squint, which was the original complaint underneath the performance one. A fast chart you still can't read is just a faster way to fail.

## What capping costs you

Top-N hides the tail, and sometimes the tail is where the story is. A fraud pattern, a misconfigured provider firing a weird operation twice an hour — those live in the rows you cropped, and a busiest-first heatmap will never surface them because by definition they aren't busy. I'm comfortable with that here because this chart's job is "what's the shape of normal activity," not anomaly detection; we have other places that watch the tail. But if you cap a chart whose entire purpose is to catch the rare thing, you've capped away the reason it exists. Know which kind of chart you have before you reach for the slice.

The other cost is that "top 30" is now a number I own. It's not derived from anything — it's the count that fit the card on the screens I tested. New layout, denser display, a stakeholder who wants forty rows on a 4K monitor, and it's wrong again, silently, the same way the original was. I left a comment on the constant saying as much, which is the cheapest honesty available: this isn't the right number, it's the number that was right in October on the screen I had. The day the labels start colliding again, that's where to look first.
