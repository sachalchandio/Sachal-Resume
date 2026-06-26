---
title: "Building an interactive US coverage map, provider by provider"
description: "Per-state stats, custom tooltips, and animated cross-provider filtering driven by live data."
date: "2025-10-27"
updated: "2025-10-27"
kind: "deepdive"
category: "Data Viz"
tags: ["angular", "dataviz", "maps"]
month: "2025-10"
repo: "frontend"
author: "Sachal Chandio"
---

A sales manager asked me a question I couldn't answer in one screen: where are we actually selling? We had the numbers — every lead carries a US state, every sale carries a provider — but they lived in a table sorted by count, and a table sorted by count tells you Texas is on top and then makes you read fifty rows to feel the shape of the country. Nobody feels a country from a list. So I built the map.

The goal was modest and concrete: a US map where each state's color tracks how many leads came from it, a tooltip that names the state and its count on hover, and beside it a chart that breaks the same window down by carrier — ADT, AT&T, Spectrum, Starlink, the whole roster — with each provider's logo sized by its share. All of it driven off the same date range so the two views never disagree.

## Why I drew the map by hand

The obvious move is ECharts. We already use it elsewhere in the app, it has a geo/map type, you register a GeoJSON feature collection and feed it `[{ name, value }]`. I started there. Then I looked at what it cost: the US states GeoJSON is a few hundred KB, ECharts' map module wants the full albersUsa projection baggage, and I'd be theming a black-box canvas to match a very specific gray-to-navy palette the designer had already picked. For one map. That bundle felt expensive for what is, fundamentally, fifty static shapes that never reproject.

So the map is just an inline SVG. Fifty `<path>` elements, one per state, each bound to a fill and two hover handlers:

```html
<g class="state-group">
  <path
    [attr.fill]="getStateColor('TX')"
    (mouseenter)="enter($event, 'TX')"
    (mouseleave)="leave()"
    d="M381.53 347.83C381.24 ..."
  />
  <text x="540" y="255" class="state-name">TX</text>
  <text x="540" y="265" class="state-value">{{ stateData['TX'].value }}</text>
</g>
```

The `d` strings are real and they are enormous — Texas alone is a few thousand characters of bezier curves. I'm not pretending I typed those. They came from a public SVG of the US and got pasted in once. The point is they're now mine: no runtime projection, no map library, no GeoJSON fetch on load. The whole component is `NO_ERRORS_SCHEMA` and zero dependencies. It renders instantly because there's nothing to compute, only paint.

The tradeoff I'm signing up for: this map will never be anything but the United States. Alaska and Hawaii sit where I parked them. If the business ever sells in Canada, I throw this away and go back to ECharts. I made that bet knowingly. For a US telecom CRM it's a safe one.

## Coloring states without lying with the gradient

The first version shipped with a bug that looked like a feature. I had a 25-shade gray ramp and I divided each state's value by a hardcoded `maxValue = 600` — Texas's count when I built the seed data. It looked great in the demo. Then real data loaded, the busiest state in the actual window had 1,400 leads, every state pinned to the darkest shade, and the map turned into a single block of near-black. A choropleth where everything is the same color is just an expensively rendered rectangle.

The fix is to normalize against the real maximum, recomputed every time data arrives:

```ts
@Input() set counts(rows: { state: string; customerCount: number }[] | null) {
  for (const code of Object.keys(this.stateData)) {
    this.stateData[code].value = 0;          // reset; absent states must read as empty
  }
  for (const row of rows ?? []) {
    const code = (row?.state ?? '').toUpperCase();
    if (this.stateData[code]) {
      this.stateData[code].value = Number(row.customerCount) || 0;
    }
  }
  this.recomputeMax();
}

private recomputeMax(): void {
  this.maxValue = Math.max(1, ...Object.values(this.stateData).map((s) => s.value));
}
```

Two details in there I'd defend. The reset-to-zero loop is load-bearing: the API only returns states that have leads, so without zeroing first, a state that dropped to nothing this period would keep last period's color. And `Math.max(1, ...)` is the guard for an empty window — divide by the real max and an all-zero dataset divides by zero, which paints the whole map `NaN`-colored, which is to say transparent. One leads to a blank country and a confused manager.

Picking the shade is then a clamp:

```ts
getColorByValue(value: number): string {
  const gradient = this.grayGradient;        // 25 shades, light → near-black
  if (!value || value <= 0 || this.maxValue <= 0) return gradient[0];
  const normalized = value / this.maxValue;  // 0..1 against the actual max
  const index = Math.floor(normalized * (gradient.length - 1));
  return gradient[Math.max(0, Math.min(index, gradient.length - 1))];
}
```

If I rebuilt this I'd quantize differently. Linear normalization means a handful of giant states stretch the scale and flatten everyone else — California and Texas eat the top shades and Ohio through Georgia all land in the same muddy middle. The honest version is quantile bucketing: sort the states, cut them into N groups of equal population, color by which group you're in. That gives the small states room to differentiate. I kept linear because the manager's first question was "where's the heat," and linear answers that loudly. Quantile answers "how do the middle states rank against each other," which nobody had asked yet.

## The tooltip is a div, not an SVG thing

SVG has no z-index and no easy text-with-background. Drawing a tooltip inside the `<svg>` means hand-laying a `<rect>` plus `<text>` and fighting paint order against fifty states. I didn't. The tooltip is an absolutely-positioned HTML `<div>` that lives next to the SVG and gets driven by hover:

```ts
enter(evt: MouseEvent, stateCode: string) {
  const info = this.stateData[stateCode] ?? { name: stateCode, value: 0 };
  const rect = (evt.target as SVGPathElement).getBoundingClientRect();
  this.tipX = rect.x + rect.width / 2;   // center of the state's bounding box
  this.tipY = rect.y + rect.height / 2;
  this.hoveredState = info;
}
```

```html
<div id="tooltip"
     [style.display]="hoveredState ? 'block' : 'none'"
     [style.left.px]="tipX" [style.top.px]="tipY">
  <h3>{{ hoveredState?.name }}</h3>
  <p>Value: {{ hoveredState?.value }}</p>
</div>
```

`getBoundingClientRect()` on the path gives me the state's box in viewport pixels regardless of the SVG's internal `viewBox`, so the tooltip lands on the state even though the map is scaled. The sharp edge here, and the one that took me longest to notice: anchoring to the bounding-box center is wrong for the big crescent-shaped states. Florida's panhandle drags its bounding box west, so the tooltip for Florida pops up over the Gulf. For a v1 it's fine — you're hovering the state, you know which one — but it's the kind of thing that reads as sloppy once you spot it. The real fix is a precomputed centroid per state, which is a table I haven't bothered to build.

## The provider chart, and why logos beat labels

Beside the map sits the carrier breakdown: a horizontal-scrolling column chart, one column per provider, tallest on the left. Each column is a bar whose height is its share of the tallest, a logo, the provider name, and the raw count. Forty-odd providers, so it scrolls.

The data shaping is small and the order matters:

```ts
private build(data: ProviderDistributionRow[]): void {
  const total = data.reduce((s, d) => s + (d.customerCount || 0), 0);
  this.total = total;
  this.rows = data
    .map((d) => ({
      ...d,
      pct: total > 0 ? (d.customerCount / total) * 100 : 0,
      logo: resolveProviderLogo(d.providerCode, d.providerName),
      logoFailed: false,
    }))
    .sort((a, b) => b.customerCount - a.customerCount);
  this.maxCount = Math.max(1, this.rows[0]?.customerCount ?? 0);  // tallest after sort
}

barHeight(count: number): number {
  return Math.max(3, (count / this.maxCount) * 100);   // min 3% so tiny providers stay visible
}
```

Sort first, then read `rows[0]` as the max — once it's sorted, the tallest is just the head, no second pass. And the `Math.max(3, ...)` floor is there because a provider with four sales against a leader with two thousand computes to 0.2% height, which is a bar you cannot see and cannot hover. Three percent is a deliberate small lie: it says "this exists" louder than the true ratio does. I'm fine with that lie because the real count sits right under the bar in plain text.

The logos were the part I expected to be trivial and wasn't. New providers get added to the CRM constantly, and I am not shipping a release every time sales onboards a carrier. So logos are best-effort with a graceful fallback:

```ts
const LOGOS: Record<string, string> = {
  ATT: 'assets/images/att-emblem.png',
  ATANDT: 'assets/images/att-emblem.png',   // the data is not consistent about &
  SPECTRUM: 'assets/images/spectrum-sales-id-examples.png',
  STARLINK: 'assets/images/starlink-logo.png',
  // ...
};

const normalize = (s: string) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function resolveProviderLogo(code: string, name?: string): string | null {
  return LOGOS[normalize(code)] ?? LOGOS[normalize(name || '')] ?? null;
}
```

When `resolveProviderLogo` returns null — or when the asset 404s, which the template catches with `(error)="row.logoFailed = true"` on the `<img>` — the column falls back to a colored initials chip. The chip color is hashed from the provider key so it's stable across renders; "Brightspeed" is always the same teal, not a different color every reload:

```ts
export function providerColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return CHIP_COLORS[h % CHIP_COLORS.length];
}
```

That fallback is the whole reason the chart survives contact with production. A new carrier shows up as `BH` on a blue circle until someone adds its PNG, and nothing breaks. The `ATT` / `ATANDT` double-mapping in the table is me admitting the source data isn't clean — the same carrier arrives as "AT&T", "ATT", and "AT and T" depending on which form created the sale, and normalizing punctuation away catches most of it.

## Animation, and keeping the two views honest

The bars animate, and I got that for almost free. The fill is an absolutely-positioned span whose height is a bound percentage, and CSS does the rest:

```scss
.prov_col_fill {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  background: var(--bar-fill);
  transition: height 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}
```

When the date range changes and `barHeight()` returns new numbers, Angular updates the inline `height` style and the browser tweens it over 400ms. No animation library, no `requestAnimationFrame` loop. The `cubic-bezier(0.22, 1, 0.36, 1)` is an ease-out that overshoots slightly — bars shoot up and settle, which reads as "the data just changed" far better than a linear slide. Filtering across the whole carrier roster by moving the date window is, mechanically, just this transition firing on forty columns at once.

The thing I'd warn anyone about: the map and the provider chart are two components, and early on they each owned their own date range. They drifted. The map showed last-365-days of leads, the chart showed last-30 of sales, and the totals looked wrong because they were measuring different things. Both now default to the same trailing-365 window, but the deeper fix — which I haven't fully landed — is to lift the date range to the parent `app-new-demographics` and pass it down, so there is one source of truth and "filtering" means changing one value, not two. Right now they merely agree by convention. Two views that agree by convention will eventually disagree by accident, and the day they do, someone reports it as a data bug and you spend an afternoon discovering it was a UI bug all along.

Both services use `fetchPolicy: 'network-only'`, which I set after watching Apollo serve a cached state-distribution from the previous range. Caching the query by its variables sounds right until the variable is a date range nobody revisits — the cache hit rate is near zero and the staleness rate is exactly when you change the date, which is the only time it matters. The real cache lives on the server, keyed properly, and the client should just ask.

If I were starting over, the one structural thing I'd change is the centroid table for tooltips and the parent-owned date range — both are the difference between "demo that impresses" and "tool the manager trusts after the third week." The map itself, fifty hand-pasted paths and a 25-stop gradient, I'd build exactly the same way again. Sometimes the boring static thing is the right call, and the library is the premature one.
