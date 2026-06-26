---
title: "Design tokens at scale: theming an app you didn't design up front"
description: "Retrofitting CSS variables, host-context dark mode, a rem reset, and reaching the corners that always get missed."
date: "2026-03-26"
updated: "2026-03-26"
kind: "deepdive"
category: "Frontend"
tags: ["css", "scss", "design-tokens"]
month: "2026-03"
repo: "frontend"
author: "Sachal Chandio"
---

A theme is not a feature you add. It's a constraint you wish you'd had on day one. Telelinkz didn't, and by the time anyone asked for dark mode the Angular app was a few hundred components deep, each one carrying its own little pile of `#ffffff`, `#212967`, and the occasional `#0095ff` that someone eyedropped off a Figma frame in 2023. Retrofitting a theme onto that is a different job than building one. You're not picking colors. You're doing archaeology, then plumbing.

The thesis I'll defend here: **the hard part of theming a mature app isn't the dark palette, it's making every surface read its color from one indirection instead of from a literal.** Once a value can change, dark mode is almost an afterthought. Getting every value to be a variable — including the ones nobody thinks of as colors — is the whole project.

## Step one is grep, not design

Before I wrote a single token I wanted to know how bad it was. The honest answer came from search, not intuition. Hardcoded hex literals were scattered across component CSS, a handful of shared stylesheets in `src/assets/css/`, and inline `[ngStyle]` bindings in templates. The inline ones are the worst because no stylesheet audit finds them; you only catch them when a card stays stubbornly white in dark mode and you go hunting.

So the first deliverable wasn't a palette. It was a map of where color lived. Component SCSS was the easy 80%. The long tail was the shared `saleJourney-common.css` and `filter-table-common-style.css` files that half the app imports, plus chart configs in TypeScript where colors are passed as JS strings to Chart.js and ECharts. Those don't show up in a CSS audit at all.

## The token layer

I settled on plain CSS custom properties, defined per component, named by role rather than by value. The time-off feature has the cleanest version of this because I built it after the lessons landed — a shared SCSS file of mixins that any component pulls in:

```scss
// features/time-off/styles/_tokens.scss
@mixin tokens-light {
  --to-primary: #2563eb;
  --to-surface: #ffffff;
  --to-surface-2: #f8fafc;
  --to-text: #0f172a;
  --to-text-2: #475569;
  --to-border: rgba(15, 23, 42, 0.08);
  --to-overlay: rgba(10, 15, 30, 0.55);
  // ...status, shadows, radii, focus ring
}

@mixin tokens-dark {
  --to-primary: #3b82f6;       // lighter — pure brand blue vibrates on near-black
  --to-surface: #101a2e;
  --to-surface-2: #16223c;
  --to-text: #f1f5f9;
  --to-text-2: #a5b4cd;
  --to-border: rgba(148, 163, 184, 0.12);
  --to-overlay: rgba(2, 6, 16, 0.72);
}
```

Two things I'd argue for. First, **name by role, not by value.** `--to-surface`, not `--white`. A token called `--white` that resolves to `#101a2e` in dark mode is a lie you have to remember every time you read it. `--to-surface` is true in both themes. Second, **the dark palette is not the light palette inverted.** Look at `--to-primary`: it goes *lighter* in dark mode (`#2563eb` → `#3b82f6`), because a saturated mid-blue that sits calmly on white buzzes against `#080d1a`. Borders flip from "dark ink at low opacity" to "light slate at low opacity" because a black border is invisible on a dark surface. If you literally invert lightness you get a theme that technically works and looks like garbage.

## Scoping with `:host-context`

Telelinkz toggles a single class — `dark-theme` — on `<body>`. Every themed component declares both palettes and lets the ancestor class pick:

```scss
:host {
  @include tokens-light;
}
:host-context(.dark-theme) {
  @include tokens-dark;
}
```

`:host-context()` is the right tool here precisely because the theme class lives on an ancestor (`body`) and the component is shadowed/encapsulated below it. It walks *up* the DOM from the host looking for the selector, which is exactly the question "is anything above me dark?" Plain `:host(.dark-theme)` would only match if the class were on the host element itself, which it never is.

The non-obvious payoff: because tokens are redefined at the `:host-context` level, *every* rule inside the component that reads `var(--to-surface)` retheme​s for free. You write the mapping once per component, not once per property. A 300-line component stylesheet needs exactly two theme blocks.

One caveat that bit me: `:host-context` is still unflagged-experimental in spec terms and unsupported in Firefox without it being behind a flag historically. For an internal CRM where I control the browser (Chromium, every time) that's a non-issue. If this were a public marketing site I'd toggle a `data-theme` attribute on `:root` and use attribute selectors instead, which is boringly universal. Know which app you're building.

## The rem reset nobody warns you about

Here's the one that cost me an afternoon. Telelinkz sets `html { font-size: 13px; }` globally — a deliberate choice to fit dense sales tables on screen. So in the app, `1rem = 13px`, not 16.

That's fine until you build a self-contained feature against the design's spacing scale, which is authored assuming the browser default of 16px. Every `0.61rem` I wrote thinking "about 10px" rendered at ~8px. Padding looked cramped, hit targets were small, and it was *uniformly* wrong, which made it hard to spot — nothing looked broken, everything just looked slightly squished.

The token file documents the convention right at the top so the next person doesn't lose the same afternoon:

```scss
// Root font-size is 13px → 1rem = 13px.
--to-radius-sm: 0.61rem; // 8px
--to-radius-md: 0.92rem; // 12px
--to-radius-lg: 1.23rem; // 16px
```

The comments are load-bearing. `0.92rem` is meaningless on its own; `0.92rem // 12px` tells you the intent and lets you sanity-check the math (`0.92 × 13 ≈ 12`). I considered scoping a `font-size: 16px` reset onto the feature's host to get clean numbers back, but that would have rescaled every nested Material component and child that inherited the 13px assumption. Cheaper to convert the scale once and write the px in a comment than to fight inheritance. The lesson generalizes: **a non-default root font-size is a global decision, and any "self-contained" piece you bolt on inherits it whether you remember it or not.**

## The surfaces a naive pass forgets

This is the part I actually want you to take away. When you theme an app, you instinctively style the things you look at: cards, buttons, text, backgrounds. You finish, it looks great, you ship. Then the bug reports come from the corners. Here's the checklist I now run, every one of which we got wrong at least once:

**Charts.** Chart.js and ECharts don't read your CSS variables. Their axis labels, grid lines, tooltips, and legends are configured in JavaScript, so they sit completely outside the cascade. A page can be perfectly dark with a chart in the middle still rendering black-on-white axis text. The fix is to read the theme in TS and re-feed the chart, and — this is the part people miss — to *react to theme changes at runtime*, because the user can flip the toggle while the chart is mounted:

```ts
private isDarkTheme = document.body.classList.contains('dark-theme');

ngOnInit() {
  const observer = new MutationObserver(() => {
    const isDark = document.body.classList.contains('dark-theme');
    if (isDark !== this.isDarkTheme) {
      this.isDarkTheme = isDark;
      this.updateChartColors();   // re-set label/grid/tooltip colors, then chart.update()
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  this.destroy$.subscribe(() => observer.disconnect());
}
```

A `MutationObserver` on `body`'s class is the bridge between "color lives in CSS" and "color lives in a JS config object." It's ugly that the chart needs to know what theme it's in at all, but the alternative — pulling computed CSS var values out at runtime with `getComputedStyle` — was flakier in practice and didn't buy enough to justify it.

**Overlays, modals, dropdowns.** Anything that escapes the component's DOM into a CDK overlay or a portal at the document root is *outside* your `:host-context` subtree. The class is on `body`, the overlay is a sibling of your app root, so the context match still works if the toggle is high enough — but component-scoped tokens defined on `:host` do **not** reach an overlay that renders elsewhere. Dropdown menus and tooltips were a recurring offender; they need their own themed tokens at the overlay level, not borrowed from the component that opened them.

**Scrollbars.** `::-webkit-scrollbar-thumb` defaults to a light-gray system color that looks like a scratch on a dark surface. Easy to forget because you don't see it until content overflows. Themed it explicitly via `scrollbar-color` and the webkit pseudo-elements.

**Focus rings and skeletons.** The keyboard focus ring and the loading-shimmer gradient are both "colors" that don't feel like colors. A focus ring tuned for white backgrounds disappears on dark ones. Loading skeletons built from two light grays shimmer invisibly. Both got their own tokens (`--to-ring`, `--to-skeleton-a/b`).

**Print.** Nobody themes print and nobody should — but you have to *think* about it to decide that. A dark-mode page sent to a printer is either a solid black rectangle that drains a toner cartridge, or browser print styles silently override your background and you get dark text on white with your carefully-themed borders gone. For the few printable reports I forced a light palette in a `@media print` block. The decision matters more than the implementation.

**Images and inline SVG.** A logo that's dark-ink-on-transparent vanishes on a dark header. Status icons baked as raster images can't recolor. We had a `--header-line-color: #000000` that needed a dark-mode counterpart, and a couple of decorative images that simply had to be swapped per theme rather than recolored.

## Where this advice is wrong

A few honest caveats, because "tokenize everything" is not free.

Don't tokenize a one-off. If a color appears exactly once, in one component, and will never change with the theme, a literal is fine. A token for it is indirection with no payoff — you've made the reader jump to a definition to learn something a hex code told them directly. Tokens earn their keep at the points of *reuse* and *variance*. A value that has neither doesn't need one.

Per-component token blocks don't scale to a thousand components. The time-off `_tokens.scss` mixin approach is great for a feature; copy-pasting two theme blocks into every component across the whole app is how you get drift — someone tweaks `--to-surface` in one place and not the others. The honest end state is one global token layer at `:root` / `.dark-theme` that everything inherits, with component-local tokens reserved for genuinely component-specific roles. We're mid-migration toward that; the per-feature file was a deliberate stepping stone, not the destination.

And `MutationObserver`-per-chart is a smell. It works, but every chart re-implementing theme-awareness is duplication waiting to rot. A single theme service emitting an observable that charts subscribe to is the better shape. I shipped the observer version first because it was local and provably correct, and I'd rather ship the ugly-correct thing than block on the elegant one. That's a trade I'll defend.

## Rules of thumb I'd tape to the monitor

- The unit of theming is the *role*, not the color. If you can't name what a token is *for* without saying its hex value, it's not a token, it's a constant with extra steps.
- Audit before you palette. `grep` for `#` across your styles and templates is your real scope document. The inline styles and the JS chart configs are where the time goes, not the cards.
- Dark is not inverted light. Re-pick brand, borders, and shadows by eye on the actual background.
- A non-default root font-size poisons every `rem` you write afterward. Write the px in a comment or you'll relearn it the hard way.
- The bugs live in the corners: charts, overlays, scrollbars, focus rings, skeletons, print, images. Anything that renders outside the cascade, or doesn't look like a color, is where a "done" theme isn't.

The day the toggle worked end-to-end, the satisfying part wasn't the dark UI. It was that adding the *next* theme — a high-contrast mode, a per-tenant accent — stopped being a project and became a third block in one file. That's the whole reason you do this. Not for dark mode. For the mode after it.
