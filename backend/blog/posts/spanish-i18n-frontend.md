---
title: "Shipping Spanish across the whole frontend"
description: "Theming and translation reaching the parts that usually get skipped: charts, the notepad, the sale views."
date: "2026-03-09"
updated: "2026-03-09"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "i18n"]
month: "2026-03"
repo: "frontend"
author: "Sachal Chandio"
---

Half the sales floor reads English second. The CRM had been English-only since day one, and the workaround was a senior agent translating column headers out loud to whoever was new. That works until it doesn't — until someone marks a sale "On Hold" thinking it meant something else, and a commission gets held for three weeks over a word.

So: Spanish. Not a marketing landing page in two languages — the actual working surface. The sale views agents stare at all day, the task board, the HR forms, the analytics charts on the homepage. The whole thing, in the language the person using it actually thinks in.

I'll tell you up front what the post is really about, because it surprised me. The translation part was tedious but mechanical. The part that kept biting me was that i18n and theming fail in exactly the same places — the corners nobody looks at. The chart axis labels. The notepad. The paginator that says "1 – 25 of 312". You localize the page, you ship it, it looks done, and then someone scrolls down and there's an English string sitting inside a Spanish screen like a typo.

## Why not ngx-translate

The reflex is to reach for `@ngx-translate/core` or Angular's built-in `$localize`, drop JSON files in `assets/i18n/`, and pipe everything through `| translate`. I didn't, and I want to be honest that part of the reason was taste and part was a real constraint.

The real constraint: I wanted the keys to be type-checked. With a JSON bundle, `{{ 'sales.recordStatus.onHld' | translate }}` is a typo that ships silently and renders the raw key on screen. We had been bitten by exactly that class of bug before. I wanted a missing or misspelled key to be a TypeScript error at compile time, not a customer-facing one.

So the registry is plain TypeScript. Every key lives in a union type, and the translation maps are checked against it:

```ts
export type SupportedAppLanguage = 'en' | 'es';

// app-translations.ts
const APP_TRANSLATIONS = {
  en: {
    'common.close': 'Close',
    ...HOMEPAGE_TRANSLATIONS.en,
    ...SALES_TRANSLATIONS.en,
    ...TASKS_TRANSLATIONS.en,
    // ...the rest
  },
  es: {
    'common.close': 'Cerrar',
    ...HOMEPAGE_TRANSLATIONS.es,
    ...SALES_TRANSLATIONS.es,
    ...TASKS_TRANSLATIONS.es,
  },
} satisfies Record<SupportedAppLanguage, Record<AppTranslationKey, string>>;
```

That `satisfies Record<..., Record<AppTranslationKey, string>>` is the whole point. If `SALES_TRANSLATIONS.es` is missing a key that exists in `AppTranslationKey`, the build fails. If a key is misspelled, it isn't part of the union, so the build fails. Each feature owns its own file — `sales.translations.ts` only handles keys shaped `sales.${string}` via an `Extract`, so the sales translator can't accidentally stomp an HR key:

```ts
type SalesTranslationKey = Extract<AppTranslationKey, `sales.${string}`>;
```

The lookup itself is boring on purpose. One function, a fallback to English, and `{param}` interpolation:

```ts
export function translateAppText(
  language: SupportedAppLanguage | string | null | undefined,
  key: AppTranslationKey,
  params?: Record<string, string | number>,
): string {
  const resolvedLanguage = normalizeAppLanguage(language);
  const template =
    APP_TRANSLATIONS[resolvedLanguage][key] ??
    APP_TRANSLATIONS[DEFAULT_APP_LANGUAGE][key];

  if (!params) return template;

  return Object.entries(params).reduce(
    (msg, [k, v]) => msg.replaceAll(`{${k}}`, String(v)),
    template,
  );
}
```

The English fallback matters more than it looks. When Spanish is only 60% wired in a module, the alternative to a fallback is blanks, and a blank header is worse than an English one — at least the English one is a word.

## How components consume it

No pipe. Each component exposes a one-line `t()` that reads the current language and delegates:

```ts
t(key: AppTranslationKey): string {
  return translateAppText(getCurrentAppLanguage(), key);
}
```

In the template it's just a method call:

```html
<button class="tf-refresh">{{ t("tasks.refresh") }}</button>
<span class="tf-section-label">{{ t("tasks.status") }}</span>
<input [attr.placeholder]="t('tasks.filter.searchByName')" />
```

People will tell you calling a method in a template is a change-detection sin — it runs on every cycle. For a string lookup against an in-memory object it's nothing, and I measured before worrying. The thing I gave up by not using a pipe with an observable is live language switching without a reload. I decided I didn't care, and that decision has a consequence I'll get to.

`getCurrentAppLanguage()` reads a module-level cache backed by `localStorage`, seeded from the user's saved app settings. When the language setting changes, the app component reacts — and here's the naive thing I shipped first, then kept:

```ts
this.appSettingsService.getLanguageChanges().subscribe((language) => {
  applyDocumentLanguage(language); // sets <html lang> + data-locale

  if (this.activeLanguage && this.activeLanguage !== language) {
    window.location.reload();
    return;
  }
  this.activeLanguage = language;
});
```

A full page reload to switch language. It looks lazy and it is, a little. But because `t()` is a plain method and nothing subscribes to a language stream, half the screen would keep rendering the old language if I didn't force a clean slate. I could have made every component reactive to a language signal. For a setting people change roughly once — when they first log in — a reload that takes 800ms is the correct amount of engineering. I'd rather spend that complexity budget on the corners that are actually broken.

## The corners

Here's where it got interesting. I'd wire a module, click through it, declare it done. Then I'd find an island of English. Always the same kinds of places.

**The paginator.** Angular Material's `MatPaginator` renders its own labels — "Items per page", "Next page", and the range "1 – 25 of 312" — from a `MatPaginatorIntl` service that has zero idea your app speaks Spanish. It just sat there in English under every translated table. The fix is a custom intl provider:

```ts
export function createAppMatPaginatorIntl(): MatPaginatorIntl {
  const intl = new MatPaginatorIntl();
  const labels = PAGINATOR_LABELS[getCurrentAppLanguage()];

  intl.itemsPerPageLabel = labels.itemsPerPage; // "Elementos por pagina:"
  intl.nextPageLabel = labels.nextPage;         // "Pagina siguiente"
  intl.getRangeLabel = (page, pageSize, length) =>
    getRangeLabel(page, pageSize, length, labels.of); // "1 - 25 de 312"
  return intl;
}
```

This is a thing you only find by scrolling to the bottom of a long table. It's not in your templates, so grep doesn't catch it. It's not in your translation files, so the translator never sees it. It's a corner.

**The charts.** The homepage runs on ECharts, and ECharts text — axis labels, tooltip headers, legend entries — lives in a config object you pass to `setOption`, not in the DOM. So none of it goes through `t()` and none of it shows up when you scan the template. The status-distribution chart had "Records Status Distribution" baked into the option. You localize it by building the option from translated strings and resetting it.

Which leads straight into the theming version of the same bug, because the charts also didn't know about dark mode. ECharts doesn't read your CSS variables. If the page background flips to slate and the chart's `axisLabel` color is still `#475569`, you get dark-on-dark text you can barely read. The chart has to be told, twice — once for color, once for language — and the trigger for both is the same.

I already had dark mode toggling a class on `body`:

```ts
private setDarkMode(isDark: boolean): void {
  this.renderer[isDark ? 'addClass' : 'removeClass'](this.document.body, 'dark-theme');
  // CSS reacts to .dark-theme; charts can't, so tell them directly
  this.document.dispatchEvent(
    new CustomEvent('themeChanged', { detail: { isDarkMode: isDark } }),
  );
}
```

The custom event is the bridge. CSS picks up `.dark-theme` for free; the charts subscribe and re-render:

```ts
document.addEventListener('themeChanged', () => this.renderCharts());
```

```ts
// inside renderCharts(), colors resolved from the current theme
const colors = isDark
  ? { axisLabel: '#ffffff', tooltipText: '#e2e8f0' }
  : { axisLabel: '#475569', tooltipText: '#1e293b' };

this.statusChart.setOption({
  xAxis: { axisLabel: { color: colors.axisLabel, fontWeight: 500 } },
  // ...
}, true); // notMerge: true — replace, don't deep-merge stale colors
```

That trailing `true` cost me an afternoon. Without `notMerge`, `setOption` deep-merges into the old config, and bits of the previous theme's colors survive in nested arrays. The chart ends up half-dark. Replace the whole option or don't bother.

**The notepad.** Every agent has a sticky notepad. It's a small thing with a lot of surfaces — paper background, ruled lines, the little punch-holes, scrollbar, a font selector. All hand-colored, all wrong in dark mode. I gave it a scoped set of variables and a dark override using `:host-context`, so the component carries its own palette and the global theme flips it:

```scss
:host {
  --notepad-bg-primary: #ffffff;
  --notepad-text-primary: #000000;
  --notepad-paper-lines: #e2e8f0;
  --notepad-scrollbar-thumb: #0071f4;
}

:host-context(.dark-theme) {
  --notepad-bg-primary: #1e293b;
  --notepad-text-primary: #f8fafc;
  --notepad-paper-lines: #334155;
  --notepad-scrollbar-thumb: #3b82f6;
}
```

`:host-context(.dark-theme)` walks up the DOM looking for the class on an ancestor — `body` in our case — and rewrites the variables for that subtree. The component's own rules never reference a hex value, only `var(--notepad-*)`, so light/dark is purely a question of which block won. Same shape as the chart problem: the component can't see the global theme on its own, so you hand it a hook.

## The pattern, stated plainly

Translation and theming are the same audit run twice. Both pass cleanly on everything that lives in your component templates as plain text and CSS, and both quietly skip three categories:

- Strings that live in config objects, not the DOM — chart options, toast configs, anything you pass to a third-party `setOption`-style API.
- Labels owned by a library — `MatPaginatorIntl`, date pickers, anything Material renders from its own service.
- Self-contained widgets with hand-tuned styling — the notepad, custom scrollbars, the punch-holes nobody thinks of as "content."

None of these show up when you grep your templates for untranslated text or hardcoded hex. That's why they're the last to get done and the first that users notice.

## What I'd do differently

The reload-on-language-change is fine, but I'd build the language switch to flow through the same `themeChanged`-style event from the start instead of bolting reactivity on later. The charts already prove the pattern works: one dispatched event, every non-DOM consumer re-renders. Language is just another consumer that happens to need it, and I treated it as special when it isn't.

The bigger thing: I'd write the corner audit as a test, not a habit. Right now "did we miss a string" is me clicking through screens in Spanish looking for English, which is exactly as reliable as it sounds. A test that renders each route under `es`, dumps visible text, and flags anything matching a list of known-English words wouldn't be perfect, but it would catch the paginator the day someone adds a new table — instead of three sprints later, when an agent screenshots it in Slack with a single question mark.

The word that started this was "On Hold." It now reads "En Espera," and the chart behind it has axis labels you can read in the dark. Small wins, in the corners, are still the ones people see first.
