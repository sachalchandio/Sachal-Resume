---
title: "A four-quadrant opportunity matrix from geography and sales"
description: "Turning a flat demographics table into something a manager can act on."
date: "2026-06-21"
updated: "2026-06-21"
kind: "deepdive"
category: "Data Viz"
tags: ["angular", "dataviz", "analytics"]
month: "2026-06"
repo: "frontend"
author: "Sachal Chandio"
---

The demographics dashboard had numbers on it. It didn't have an answer.

It was a table, state by state, with a lead count and a population figure and a couple of percentages, sortable by whichever column you clicked last. Everything you'd want was technically on the page. But when a regional manager opened it, the question in their head was always the same — *where should my closers be spending next month* — and the table didn't say. It said California has the most leads. California has the most everything. That's not insight, that's just the size of California.

So I sat with the actual question for a while before touching code, because the chart you build is downstream of the question you let yourself ask. The manager doesn't want a ranking. They want a *map of where the upside is* — which states are already working and worth feeding, which are big and underpenetrated and worth a push, which are tapped out, and which to quietly ignore. That's a two-by-two. It's been a two-by-two since the BCG growth-share matrix in 1970. I just had to figure out what my two axes were.

## Picking the two axes

A quadrant chart is only as good as the two numbers you put on its axes, and the trap is to reach for two numbers you already have. We had raw lead count and raw population. Plot those against each other and you get a diagonal smear — big states top-right, small states bottom-left — because both axes are really just measuring *size*. You've drawn population twice and learned nothing.

The axes have to be *derived* and they have to be *independent*, or the quadrants collapse onto the diagonal. What I landed on:

- **X axis — penetration.** Leads per capita, basically. How much of this market have we already touched? `leadCount / population`, normalized.
- **Y axis — momentum.** How the recent lead distribution is trending against the static baseline. A state can be lightly penetrated *and* heating up, which is the whole point — those are the ones you want to find.

Penetration comes from our live lead-state distribution. Momentum needs a reference to trend *against*, and that's where the static population dataset earns its keep — it's the denominator that turns "we have 400 leads here" into "we've touched 0.3% of a market this size," which is a completely different sentence. One axis is dynamic and recomputes on every filter change; the other leans on a fixed reference table I check in as JSON. Mixing a live signal with a static baseline felt wrong for about a day until I realized that's exactly what makes the chart readable: the baseline doesn't move, so when a point drifts, you know it's the *sales* that moved, not the ground shifting under it.

Then the quadrants get names, because "high-X low-Y" is not something a human carries out of a meeting:

- **Star** — high penetration, high momentum. Working and growing. Don't touch, just feed it.
- **Scale-up** — low penetration, high momentum. The money quadrant. Big market, heating up, room to run.
- **Mature** — high penetration, low momentum. Saturated. Harvest, don't invest.
- **Watch** — low penetration, low momentum. Cold. Park it.

## Positioning a point in the grid

The core of it is dull, and dull is correct. Every state becomes a point, and a point lands in a quadrant by comparing its two derived values against a threshold. I went with the median rather than the midpoint of the range, because one outlier state would otherwise drag the dividing line and shove everyone into one quadrant.

```ts
interface StateMetric {
  state: string;
  leadCount: number;
  population: number;
  penetration: number; // x, normalized 0..1
  momentum: number;    // y, normalized 0..1
  quadrant: Quadrant;
}

type Quadrant = 'star' | 'scaleUp' | 'mature' | 'watch';

function classify(x: number, y: number, xMid: number, yMid: number): Quadrant {
  if (x >= xMid && y >= yMid) return 'star';
  if (x < xMid && y >= yMid) return 'scaleUp';
  if (x >= xMid && y < yMid) return 'mature';
  return 'watch';
}
```

The thresholds are the medians of the cohort being shown, not constants:

```ts
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const xMid = median(metrics.map((m) => m.penetration));
const yMid = median(metrics.map((m) => m.momentum));

const classified = metrics.map((m) => ({
  ...m,
  quadrant: classify(m.penetration, m.momentum, xMid, yMid),
}));
```

That the dividing lines are *relative to the current selection* is a deliberate choice with a sharp edge I'll come back to. Filter to the Midwest and "high penetration" now means high relative to the Midwest, not nationally. For "where do I deploy my Midwest team" that's the right frame. For "how does the Midwest compare to everywhere" it's quietly misleading, and I had to put that distinction in front of users before they assumed the lines meant something absolute.

## Drawing it in ECharts

It's a scatter. ECharts does scatters fine; the work is making it *read* as four labeled rooms rather than a galaxy of dots. The dividing lines are `markLine`s, the quadrant labels are `graphic` text pinned to the corners, and each point is colored by its quadrant so the eye groups them before reading any label.

```ts
const option: EChartsOption = {
  animation: false,
  grid: { left: 56, right: 24, top: 32, bottom: 48 },
  xAxis: {
    name: 'Market penetration',
    min: 0, max: 1,
    splitLine: { show: false },
  },
  yAxis: {
    name: 'Momentum',
    min: 0, max: 1,
    splitLine: { show: false },
  },
  series: [
    {
      type: 'scatter',
      symbolSize: (d: number[]) => 8 + Math.sqrt(d[2]) * 0.4, // d[2] = leadCount
      data: classified.map((m) => ({
        value: [m.penetration, m.momentum, m.leadCount],
        name: m.state,
        itemStyle: { color: QUADRANT_COLORS[m.quadrant] },
      })),
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: { type: 'dashed', color: 'var(--border-strong)' },
        data: [{ xAxis: xMid }, { yAxis: yMid }],
      },
    },
  ],
};
```

Two details there carry more than their weight. `symbolSize` scales with `sqrt(leadCount)` so a state's dot grows with its volume — that smuggles a third dimension onto a two-axis chart without adding clutter, and the `sqrt` keeps California from becoming a beach ball that eats half the grid. And `animation: false`, which I now reach for reflexively on any dashboard chart, because the option object rebuilds on every filter change and the default easing makes every filter flip *feel* like lag even when the render was instant. I wrote a whole separate post talking myself into that flag; I'm not relitigating it here.

The quadrant labels go in as `graphic` elements rather than axis decorations, anchored to percentages of the grid so they survive a resize:

```ts
graphic: ['star', 'scaleUp', 'mature', 'watch'].map((q, i) => ({
  type: 'text',
  // top-right, top-left, bottom-right, bottom-left
  left: i % 2 === 0 ? '72%' : '12%',
  top: i < 2 ? '8%' : '82%',
  style: {
    text: QUADRANT_LABELS[q],
    fill: 'var(--text-muted)',
    font: '600 12px Inter, sans-serif',
  },
})),
```

## The rollup cards and the table underneath

The scatter answers "where," but a manager skimming on their phone wants the headline first and the dots second. So above the chart sit four rollup cards, one per region, each showing the dominant quadrant for that region and a count of states in each. Below it, a sortable table — because the chart is for *seeing the pattern* and the table is for *looking up the number*, and conflating those two jobs is how you get a chart nobody can read and a table nobody can scan.

The regional rollup is a group-by that I do in a `computed`, because all of this is signals now:

```ts
readonly regionRollups = computed(() => {
  const byRegion = new Map<string, StateMetric[]>();
  for (const m of this.classifiedStates()) {
    const region = REGION_OF[m.state] ?? 'Other';
    (byRegion.get(region) ?? byRegion.set(region, []).get(region)!).push(m);
  }

  return [...byRegion.entries()].map(([region, states]) => {
    const counts = countByQuadrant(states); // { star: n, scaleUp: n, ... }
    const dominant = (Object.keys(counts) as Quadrant[])
      .reduce((a, b) => (counts[b] > counts[a] ? b : a));
    return { region, counts, dominant, total: states.length };
  });
});
```

The table is plain Material `mat-table` with `matSort`. The one thing worth saying about it is that the sort default matters more than the sort capability. People rarely re-sort; they trust whatever's on top. So it loads sorted by momentum descending — the heating-up states first — because that's the column most likely to contain an action. Default to the answer, not to the alphabet.

## Where it got sharp

The medians-as-thresholds decision is the one that bit, and it bit twice.

First: with a tiny cohort the median is unstable. Filter down to four states and the dividing line jumps to wherever the second-and-third values happen to sit, and a point that was a "Star" a second ago is suddenly "Mature" because you removed an unrelated state from the selection. Nothing about *that* state changed. Its label changed because its neighbors left the room. I now hide the quadrant labels and gray the dividing lines below a minimum cohort size — I think it's eight states — with a small note that says "too few states to rank." A quadrant chart with five points is a lie with axes.

Second, and subtler: the static population reference goes stale. It's a JSON file. Census-ish figures, checked in, and the day a state's real population drifts enough to flip its penetration across the median, the chart is wrong in a way nothing in the UI flags, because the number *looks* authoritative sitting there in the table. I added a `referenceVintage: "2025"` field to the dataset and surface it as a tiny caption under the chart — `Population reference: 2025` — which is the cheapest honesty available. It doesn't fix the staleness. It just stops the chart from pretending the staleness isn't there, the same way I'd date a hardcoded constant in a comment.

The other thing I underestimated was naming. I shipped the first version with the axes labeled "Penetration" and "Momentum" and the quadrants unlabeled, figuring the dots colored by quadrant were self-explanatory. They were not. A manager looked at the top-left cluster and asked, reasonably, whether top-left was good or bad. The colors meant nothing without the words. Adding the four quadrant names — Star, Scale-up, Mature, Watch — did more for the chart's usefulness than any amount of axis math. The geometry was right for a week before anyone could read it.

## What I'd do differently

The momentum axis is the soft spot. Right now "momentum" is a comparison of current distribution against the static baseline, which is really *penetration velocity dressed up* — it correlates with the X axis more than I'd like, and two axes that secretly agree with each other is the exact failure mode I set out to avoid. The honest fix is a real time component: lead growth over a trailing window, period over period, so the Y axis measures *change* and the X axis measures *level*, and they stop leaning on each other. That needs the backend to hand me a windowed series instead of a snapshot, which is a bigger lift than reshaping a chart, so it's sitting in the backlog wearing the label "do this before anyone makes a real budget decision off the Y axis."

And if I rebuilt the classification, I'd stop pretending the median is the truth. The median is a convenient *default* threshold, but the line between "invest here" and "harvest here" is a business call, not a statistical one. The right shape is a draggable divider — let the regional manager push the threshold to where *their* judgment says the cutoff is, and reclassify live. The math is identical; you're just handing the median's job to a human who knows the territory. The chart's whole purpose is to support a decision, and the most useful thing I could do is admit that the person making the decision knows where the line goes better than `Math.floor(sorted.length / 2)` does.
