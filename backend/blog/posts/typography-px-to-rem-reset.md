---
title: "A typography reset: px to rem, one font family, consistent sizes"
description: "Dense sale screens read badly until the type was systematized. A reset that paid off immediately."
date: "2025-01-22"
updated: "2025-01-22"
kind: "deepdive"
category: "Frontend"
tags: ["css", "typography", "angular"]
month: "2025-01"
repo: "frontend"
author: "Sachal Chandio"
---

The sale detail screen had three different font sizes for what was, visually, the same kind of label. `13px` in one card, `0.8rem` in the next, `14px` in a chip three rows down. Nobody chose that. It accreted. Each component was written by whoever needed it that week, against whatever Figma frame was open, and the values they typed in were whatever made *that one screen* look right in isolation. Put forty of those screens next to each other in a dense grid and the type stops reading as a system and starts reading as noise.

That's the thing about typography on a data-heavy app: the cost isn't on any single screen. It's on the dense ones where twenty labels sit in a column and your eye is trying to find the rhythm. A sale list where the agent column is `13px`, the status chip is `14px`, and the timestamp is `0.85rem` doesn't look broken. It looks *slightly* off, everywhere, in a way nobody can name. Agents don't file bugs about it. They just find the screen a little harder to scan than it should be, all day, forever.

I'd been ignoring it for months. The thing that finally forced it was a `px`-vs-`rem` bug.

## The bug that made me stop ignoring it

A user bumped their browser zoom — or rather, their OS had a display-scaling setting on, the way a lot of people on smaller laptops do. Half the app scaled with it. The other half didn't. The cards reflowed and grew; the table text inside them stayed pinned at its hardcoded `13px`, because `px` doesn't care about the user's font preferences and `rem` does. So you got a card that had grown to accommodate larger text wrapped around text that refused to grow, and the result was a layout with the proportions of a ransom note.

I traced it and the root cause was boring and total: roughly half the font declarations in the app were `px`, the other half were `rem`, and the split was random. Whoever wrote the component picked one. There was no convention, so there was no way the two halves could ever agree on what "one size larger" meant.

That's when it stopped being an aesthetics complaint and became a correctness problem. `px` font sizes ignore the user's root font preference and accessibility settings. On an internal tool you can *almost* get away with that — until someone scales their display and the app tears down the middle.

## The constraints I was working inside

A few things were non-negotiable before I touched anything.

It's a live CRM. Telecom agents are dialing through it all day. I don't get a font-freeze sprint; I get to do this in the cracks, and it has to be safe to land incrementally without the app looking like two apps mid-migration.

The grid is dense on purpose. The whole point of these screens is fitting a lot of sale rows on one viewport without scrolling. Whatever I did could not blow the type up and push columns into wrapping. Density was a feature, not an accident I was free to "fix."

And there was a deliberate decision underneath all of it that I wanted to *keep*, not undo: the root font-size is `13px`, not the browser default `16px`.

```scss
:root {
  font-size: 13px;
}
```

That's there so the dense tables fit. `13px` base means everything authored in `rem` lands a notch tighter than a default app, which is exactly what a sale grid wants. The mistake wasn't the `13px`. The mistake was that half the app didn't know it existed, because half the app was hardcoded in `px` and the other half wrote `rem` values as if the root were `16`.

So the reset had a clear shape: **make `rem` the only unit, make `13px` the one root everyone computes against, collapse the font families to one, and normalize the pile of ad-hoc sizes down to a small scale.** Four moves, one pass.

## The unit decision, and the one I rejected

The naive fix — the one I started typing before I stopped — was to just convert every `px` to its `rem` equivalent against the default `16px` and call it done. `13px` becomes `0.8125rem`, `14px` becomes `0.875rem`, mechanical find-and-replace.

It's wrong for two reasons. First, the root isn't `16`, it's `13`, so `0.8125rem` would render at `~10.6px`. Every converted value gets silently shrunk. Second, and worse, it bakes the noise in. You'd have `0.8125rem` and `0.875rem` and `0.8rem` all surviving as distinct values, because they *were* distinct in `px`. Converting the unit doesn't fix the inconsistency; it launders it into a unit that's harder to eyeball.

The other tempting move: scope a `font-size: 16px` reset somewhere so the `rem` math gets clean and `1rem` means `16px` like the rest of the internet assumes. I rejected that too. Resetting the root rescales the entire app at once, and on a dense grid that's a global zoom that pushes columns into wrapping — the exact thing the `13px` was protecting against. Fighting inheritance to get prettier numbers wasn't worth losing the density I'd deliberately built.

So: keep `13px` as the root, convert everything to `rem` *against 13*, and define a small set of named sizes so the conversions land on a scale instead of forty arbitrary points. The trick that made the `rem` math bearable was writing the px intent in a comment, every time:

```scss
:root {
  // Root is 13px on purpose (dense tables). 1rem = 13px.
  // All --fs-* are rem so they honor user zoom / scaling.
  --fs-xs:   0.77rem; // 10px
  --fs-sm:   0.85rem; // 11px
  --fs-base: 1rem;    // 13px
  --fs-md:   1.08rem; // 14px
  --fs-lg:   1.23rem; // 16px
  --fs-xl:   1.54rem; // 20px
  --fs-2xl:  1.85rem; // 24px
}
```

The comments are load-bearing. `1.08rem` is meaningless on its own; `1.08rem // 14px` tells you the intent *and* lets the next person check the arithmetic (`1.08 × 13 ≈ 14`). Without that comment, the first time someone needs "about 14px" they'll guess a new `rem` value, it'll be subtly off, and the drift starts again. The whole reset is one variable file away from being undone by one well-meaning guess, and the comment is the guardrail.

## One font family, not three

The font situation was its own small archaeology dig. There was a base `font-family` on `body`, and then there were components that set their own — a stray `'Roboto'` here because it came in with a Material example, an `'Open Sans'` there, and a couple of places that just said `Arial, sans-serif` because someone wanted to be safe. On most screens you couldn't tell. But put a `Roboto` label next to an `Open Sans` value in the same card and the difference in the lowercase `a` and the digit `1` is *just* visible enough to register as wrong without being obvious enough to diagnose. Mixed fonts in a data grid are death by a thousand near-misses.

The fix was to pick one stack, set it once at the root, and rip out every component-level override.

```scss
/* before — scattered across components */
.agent-name   { font-family: 'Roboto', sans-serif; }
.sale-meta    { font-family: 'Open Sans', sans-serif; }
.status-chip  { font-family: Arial, sans-serif; }
```

```scss
/* after — one declaration, inherited everywhere */
:root {
  font-family: Inter, 'Segoe UI', Roboto, system-ui, -apple-system, sans-serif;
  font-size: 13px;
}
```

Everything below `:root` inherits `font-family` for free, so the per-component declarations weren't just inconsistent, they were redundant — each one re-stating a thing it could have inherited. Deleting them was almost as satisfying as converting the sizes. A grid where every digit is from the same typeface lines up in a way you feel before you notice; numerals especially, because tabular data lives and dies on whether the `1`s and `7`s sit in the same column position row to row.

## Before and after, in one card

Here's the kind of thing I was deleting, a sale-card header that had collected one of each problem:

```scss
/* before */
.sale-card__title {
  font-family: 'Roboto', sans-serif;
  font-size: 14px;        // px — ignores zoom
  font-weight: 600;
}
.sale-card__meta {
  font-family: 'Open Sans', sans-serif;
  font-size: 0.8rem;      // rem, but computed against 16 in someone's head
}
.sale-card__chip {
  font-size: 13px;        // px again, different unit than its siblings
}
```

Three declarations, three font sizes, two font families, two units. After:

```scss
/* after */
.sale-card__title {
  font-size: var(--fs-md);   // 14px
  font-weight: 600;
}
.sale-card__meta {
  font-size: var(--fs-sm);   // 11px
}
.sale-card__chip {
  font-size: var(--fs-base); // 13px
}
```

Font family is gone from all three — inherited now. Units are uniform. And every size points at a named scale value, so "make the metadata one notch smaller everywhere" is an edit to one variable instead of a grep across the app. The card stylesheet stopped making typographic *decisions* and started making typographic *references*, which is the entire move.

## The migration was grep, then walk

There's no clever tooling here. The honest method was to find every literal and walk the list. Hardcoded `px` font sizes:

```bash
grep -rn "font-size:\s*[0-9]" src/app | grep "px"
```

and the stray families:

```bash
grep -rn "font-family" src/app | grep -v ":root"
```

The first command's list was long and mechanical; the second's was short and weird. Both shrank to near-zero as I went, and "does grep still find anything" became the done-ness test. Anything grep can still find is a thing that didn't join the system.

The long tail, as always, was the stuff that isn't in a stylesheet. A couple of inline `[style.font-size.px]` bindings no CSS audit catches. A chart or two where ECharts sets `textStyle.fontSize` as a number in TypeScript, completely outside the cascade — those can't read a CSS variable, so they got the px pulled into a shared constant at least. You find those by clicking through the app, not by grepping.

## What it cost, and where I'd hedge

The reset wasn't free and I want to be honest about the edges.

Converting `px` to `rem` against a `13px` root means none of the numbers are round. `0.77rem`, `1.08rem`, `1.85rem` — every value needs its comment or it's inscrutable. If I'd been starting a greenfield app I'd have used the `62.5%` trick (`font-size: 62.5%` makes `1rem = 10px` and the math turns trivial: `1.4rem` is obviously `14px`). I didn't, because `62.5%` is itself a global rescale and I was deliberately *not* touching the effective `13px` density. So I ate the ugly numbers and paid for them with comments. Defensible, but it's a tax every reader pays.

And a small scale is a constraint, which is the point and also occasionally a friction. The first time someone genuinely needs a size between `--fs-md` and `--fs-lg`, the system says no, and they either round to one of mine or they argue for a new token. That's working as intended — the whole value is that there are seven sizes, not forty — but it does mean the scale needs an owner who'll say no, or it grows back into the mess it replaced. A design system without someone guarding the seams isn't a system, it's a suggestion.

The part I underestimated was how immediate the payoff would be. I expected the typography reset to be invisible plumbing — correct, unglamorous, nobody notices. Then it landed, and the sale list and the detail forms suddenly read as *one* surface. The numerals lined up. The labels shared a weight and a rhythm. Nothing was redesigned; the layout, the spacing, the colors were all untouched. Only the type was systematized, and that alone made screens I'd looked at a thousand times read as if someone had finally tidied a desk I hadn't realized was cluttered.

The grid was always dense. After the reset it was dense *and* legible, which I'd quietly assumed were in tension and weren't. The seven sizes did that. Not by adding anything — by deleting thirty-three.
