---
title: "Dark mode without touching 50 components: CSS variables and tokens"
description: "Per-component dark colors don't scale. Retrofitting design tokens onto an app that didn't start with them."
date: "2026-03-14"
updated: "2026-03-14"
kind: "deepdive"
category: "Frontend"
tags: ["css", "scss", "design-tokens", "dark-mode"]
month: "2026-03"
repo: "frontend"
author: "Sachal Chandio"
---

The trigger was a single design tweak. Someone wanted the dark surfaces a touch warmer — less of that flat slate-black, a little more blue in it. A five-minute change, in theory.

It was not five minutes. The dark surface color `#0f172a` was typed by hand into about forty component stylesheets. Some had `#0F172A`. Some had `#101a2e` because whoever wrote that component eyeballed it. A few used `rgba(15, 23, 42, 1)`. There was no single place to change. There was no concept of "the dark surface color" at all — just the same hex string, copy-pasted, drifting.

I ran the count once I started paying attention:

```bash
grep -rln "#ffffff\|#fff\b\|#0f172a" src/app/components/standalone | wc -l
# 168
```

168 component stylesheets with at least one hardcoded surface or text color, and that's only the `standalone` folder. Dark mode itself "worked" — each component had its own `:host-context(.dark-theme)` block that re-stated every color in dark. Which is the worst possible place to be: it looks done, so nobody wants to touch it, but every new component is another forty-line block of hand-tuned hex that someone has to get right by eye.

## What I was actually working against

A few constraints shaped the whole thing.

I couldn't do a big-bang rewrite. This is a live CRM that telecom agents are dialing through all day; I get to refactor in the cracks between feature work, not in a two-week freeze. So whatever I did had to be incremental — old hardcoded components and new tokenized ones had to coexist without the page looking like two different apps stitched together.

The dark switch was already a body class. `app.component.ts` toggles `.dark-theme` on a wrapper, and that wasn't going to change — too much already keyed off it. So tokens had to flip on the *presence of an ancestor class*, not on a media query or a separate stylesheet.

And there was a font-size landmine I'd been ignoring. The root was set to `13px`:

```scss
:root {
  font-size: 13px;
}
```

Which means every `rem` in the entire app was secretly `× 13`. Every spacing value people wrote as `px` was implicitly fighting that. I'll come back to why this mattered for the token work, because it bit me mid-refactor.

## The approach, and the one I threw away first

My first instinct — and the version I half-built before deleting it — was a SCSS map. One `$colors` map, light and dark variants, and a `theme()` function that components call:

```scss
// the version I do not recommend
$colors: (
  light: (surface: #ffffff, text: #0f172a),
  dark:  (surface: #101a2e, text: #f1f5f9),
);

.card {
  background: theme(surface); // resolves at build time
}
```

It compiles. It's DRY in the source. And it's the wrong tool, because SCSS variables resolve at build time. To make `theme(surface)` produce a *different* value under `.dark-theme`, every selector has to be emitted twice — once light, once inside a `.dark-theme &` wrapper. You've just moved the duplication from hand-typed hex into generated CSS, doubled your bundle, and you still can't change a color at runtime. The moment you want a "system" mode that follows the OS, or a per-user theme, you're stuck recompiling.

CSS custom properties are the opposite. They cascade and they resolve at *runtime*. You declare the variable once, override it under one selector, and every `var(--x)` downstream just picks up the new value. No selector duplication. The component stylesheet doesn't even know dark mode exists — it reads `var(--to-surface)` and that's it.

So the whole scheme collapses to: define the palette as custom properties in two mixins, and gate the dark mixin behind `:host-context(.dark-theme)`.

```scss
// _tokens.scss — the single source of truth
@mixin tokens-light {
  --to-surface: #ffffff;
  --to-surface-2: #f8fafc;
  --to-text: #0f172a;
  --to-text-2: #475569;
  --to-border: rgba(15, 23, 42, 0.08);
  // ...status colors, shadows, radii, the page background
}

@mixin tokens-dark {
  --to-surface: #101a2e;   // the warmer black, in ONE place now
  --to-surface-2: #16223c;
  --to-text: #f1f5f9;
  --to-text-2: #a5b4cd;
  --to-border: rgba(148, 163, 184, 0.12);
  // ...
}
```

Every token is prefixed `--to-` (it started life in the time-off feature, hence `to`, and the name stuck as the app-wide convention). A component opts in with three lines at the top of its stylesheet:

```scss
@use '../../styles/tokens' as to;

:host { @include to.tokens-light; }
:host-context(.dark-theme) { @include to.tokens-dark; }
```

`:host-context()` is the part that makes this clean in Angular. It matches when *any ancestor* of the component's host carries `.dark-theme` — which is exactly the body-class setup I already had. The component declares the variables on its own `:host`, and the dark override lands when the wrapper class is present, with no JavaScript and no theme service injected anywhere.

## Before and after, in one component

Here's the shape of what I was deleting. A sale-detail card, the kind there are dozens of:

```scss
/* before */
.sale-card {
  background: #ffffff;
  color: #0f172a;
  border: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
}
:host-context(.dark-theme) .sale-card {
  background: #101a2e;
  color: #f1f5f9;
  border-color: rgba(148, 163, 184, 0.12);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
```

Eight lines stating the same card twice. After:

```scss
/* after */
.sale-card {
  background: var(--to-surface);
  color: var(--to-text);
  border: 1px solid var(--to-border);
  box-shadow: var(--to-shadow-sm);
}
```

The dark block is gone — not moved, gone. The values live in `tokens-dark` now, so warming up the dark surface is one edit to one line in `_tokens.scss`, and all 168 stylesheets that read `var(--to-surface)` move together. The card stylesheet has nothing dark-specific left in it, which is the actual win: new components are correct in dark mode by default because they never hardcoded anything.

I also folded the repeated patterns into mixins so the card itself becomes one line:

```scss
.sale-card { @include to.card; }
```

where `card` is just the `surface / border / radius / shadow` quartet. People stop reinventing the elevation.

## The font-size normalization, which I almost skipped

While I was in here, the `13px` root had to go. Not because of dark mode directly, but because the tokens carry `rem`-based shadows, radii, and focus rings — `--to-radius-lg: 1.23rem` is a `16px` corner *only if* `1rem == 13px`. The comment at the top of the file literally says `Root font-size is 13px → 1rem = 13px`. That's a trap baked into the math.

I moved the root to the normal `16px` so `1rem` means what everyone expects, and re-derived the few token values that had been hand-computed against 13. The reason I almost skipped it: changing the root font scales the *entire app* at once, and on a dense data grid like the sale list, a few percent of growth pushes columns into wrapping. I had to do a pass on the table layouts after. Worth it — every future `rem` someone writes is now correct without a mental `× 13` — but it is not the free change it looks like, and if you've got a `13px` (or `62.5%`) root, budget for the layout fallout before you flip it.

## The parts that always get missed

Tokens are easy where CSS owns the color. The misses are everywhere a color is set from somewhere other than a stylesheet.

**Charts.** ECharts is configured in TypeScript — the axis labels, the legend text, the tooltip background are all properties on a JS option object, not CSS:

```ts
// this never sees your CSS variables
const option = {
  xAxis: { axisLabel: { color: '#475569' } },
  tooltip: { backgroundColor: '#ffffff', textStyle: { color: '#0f172a' } },
};
```

A chart styled like that stays light-mode forever inside a dark page — white tooltip, invisible labels. CSS variables don't reach into a canvas. The fix is to read the resolved token value out of the DOM and feed it in:

```ts
const css = getComputedStyle(this.host.nativeElement);
const text = css.getPropertyValue('--to-text-2').trim();
const surface = css.getPropertyValue('--to-surface').trim();

const option = {
  xAxis: { axisLabel: { color: text } },
  tooltip: { backgroundColor: surface, textStyle: { color: css.getPropertyValue('--to-text').trim() } },
};
```

Now the chart pulls from the same palette, and when the theme flips you re-read and call `setOption` again. One source of truth, even for the canvas.

**The notepad.** The agent notepad renders user content with its own background, and it had a hardcoded paper-white. In dark mode it sat on the page like a lightbox. It hadn't surfaced because nobody opens the notepad while reviewing theming — it's a tool you use, not a screen you audit. It got a `var(--to-surface-2)` and a token border like everything else.

**The sale views.** The detail and status panels were the densest hardcoded offenders — lots of small colored chips for dispositions and statuses, each with its own hex. Those moved onto the status tokens (`--to-success-soft`, `--to-danger-soft`, and friends) via a `chip($tone)` mixin, so a "sold" chip and a "callback" chip differ by one argument instead of six copied lines.

The way I found these was crude and effective: grep for hex literals across the whole `src`, then walk the list. Anything that grep can still find is a thing that won't follow the theme.

```bash
grep -rn "#[0-9a-fA-F]\{6\}" src/app | grep -v _tokens.scss
```

## What I'd tell myself before starting

Custom properties were the right call and I wouldn't change the core of it. But two things I underestimated.

The grep-and-walk migration is genuinely long-tail. The first fifty components are a rhythm; the last ten are the weird ones — a third-party widget, an inline `style` binding, a color set in TypeScript. Those don't show up in the easy search and you find them by clicking through the dark app in good light and catching the one panel that glows. Budget for that tail; it's most of the real time.

And the font-size change is the part that looks cosmetic and isn't. Going from `13px` to `16px` is a global zoom, and on dense tables it has opinions. If I did it again I'd land the token system first on the `13px` root with the rem math adjusted, ship it, *then* normalize the root as a separate change with its own layout pass — so that if a column wraps somewhere, I know exactly which commit to blame. Bundling the two meant every "is this broken?" question had two suspects instead of one.

Here's the test that tells you it actually worked: adding the next component, nobody writes a single dark-mode rule. They `@include to.card`, they reach for `var(--to-text)`, and it's correct in both themes the first time. The day a new screen shipped dark-mode-perfect without anyone thinking about dark mode — that's when I knew the 168 were finally worth deleting.
