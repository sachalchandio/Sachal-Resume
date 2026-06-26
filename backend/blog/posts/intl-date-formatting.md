---
title: "Locale-aware dates without an i18n library, using Intl and Luxon"
description: "Hardcoded timezone formatting in a multi-region app. Letting Intl.DateTimeFormat do the work."
date: "2026-04-18"
updated: "2026-04-18"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "i18n", "luxon", "intl"]
month: "2026-04"
repo: "frontend"
author: "Sachal Chandio"
---

A sale closed in Ohio shows up as `4/3/2026` for the agent who entered it and `4/3/2026` for the manager reviewing it from another desk, and that's correct. The bug was that it sometimes showed up as `3/4/2026`, or `April 3, 2026`, or `4/2/2026` depending on whose laptop the page was rendered on. Same row, same timestamp, four different strings.

Telelinkz runs across regions and we have agents who switch their UI to Spanish. The date pipes I'd written did neither of those things. They formatted everything in one hardcoded display timezone and one implicit locale — whatever `formatDate` decided to fall back to — and the moment a non-default browser hit the page, the output drifted. This is the post about fixing that without pulling in a translation framework to format a date, which is the kind of dependency I try very hard to avoid.

## What was actually wrong

We don't use the stock Angular `date` pipe, and we have a good reason. The backend writes most timestamps as offsetless MySQL `datetime` values that are fixed GMT-5 by contract, a few columns are proper ISO strings with explicit zones, and a few more are date-only `2026-04-03` strings that have to keep their calendar meaning no matter where the viewer sits. There's a shared parse layer that untangles all of that into a Luxon `DateTime`. That part was fine.

The formatting on the other end was where it leaked. My first version reached for Angular's `formatDate` with an explicit pattern and an explicit offset string:

```ts
// the naive version I shipped first
return formatDate(parsedDate.toJSDate(), 'MMM d, y', 'en-US', '-0500');
```

Read that carefully and you can see both problems baked in. The locale is the literal string `'en-US'`. The format `'MMM d, y'` is a fixed English-shaped pattern — month abbreviation, day, year, in that order. Hand that to a Spanish-locale user and they still get `Apr 3, 2026` instead of `3 abr 2026`. Hand it to a region where the convention is day-first and you've quietly told them a lie about what's the day and what's the month. The pattern decided the *shape* of the date, and the shape should be the locale's job, not mine.

So I had two coupled mistakes: the timezone was correct but rigid, and the presentation was hardcoded to one language's conventions. I wanted to fix the second without regressing the first.

## Why Intl, and not an i18n library

The instinct in an Angular shop is to register locale data, set `LOCALE_ID`, maybe pull in `@angular/localize` or `ngx-translate` and run dates through that. I didn't want any of it for this. We weren't translating the *app* here — the app's translation story is separate and already exists. I needed exactly one thing: render a `Date` in a user's locale with that locale's idea of date order, separators, and month names. That capability ships in the browser. It's `Intl.DateTimeFormat`, it's been in every engine we care about for years, and it weighs nothing because it's already there.

The other half is style. I didn't want to invent my own option objects for "medium date" and "short date" and keep them consistent across thirty components. Luxon already ships those presets as plain `Intl.DateTimeFormatOptions` — `DateTime.DATE_MED` is `{ year: 'numeric', month: 'short', day: 'numeric' }`, `DATE_SHORT` is the all-numeric one. They're just objects. You can pass them straight into the native formatter. So the design is: Luxon defines *what level of detail*, Intl decides *how that detail looks in this locale*, and my parse layer owns *which instant in which zone*. Three jobs, three owners, no translation framework in the middle.

## The function

Here's the core of it. `formatAppDateTimeWithIntl` takes the same kind of value the rest of the system passes around, an Intl options object, an optional locale, and an optional `ConfigService`:

```ts
export const formatAppDateTimeWithIntl = (
  value: string | Date | number,
  options: Intl.DateTimeFormatOptions,
  locale?: AppDateTimeLocale,
  configService?: ConfigService,
): string | null => {
  const parsedDate = parseAppDateTime(value, configService);

  if (!parsedDate) {
    return null;
  }

  const timeZone =
    parsedDate.zoneName || getConfiguredFrontendTimezone(configService);

  return new Intl.DateTimeFormat(getIntlLocale(locale, configService), {
    ...options,
    timeZone,
  }).format(parsedDate.toJSDate());
};
```

Three things are deliberate here and each one was a bug I'd already hit.

The locale isn't hardcoded anymore. `getIntlLocale` takes whatever the caller passed and falls back to the configured app locale — `locale ?? getConfiguredLocale(configService)`. A caller who knows the locale can force it; everyone else gets the user's setting. `Intl.DateTimeFormat` accepts a string or an array of locale strings, which is why the type is `string | string[] | undefined` rather than just `string`. That array form matters: you can pass `['es', 'en']` and the engine walks down to the first one it actually supports instead of silently giving you the wrong defaults.

The `timeZone` comes from the *parsed* date's zone, not from a hardcoded offset string. By the time `parseAppDateTime` is done, the `DateTime` has already been shifted into the configured frontend zone (or kept in its own explicit zone for the ISO-with-offset cases). I read `parsedDate.zoneName` off that and feed it to Intl as a proper IANA name like `America/New_York`, with the configured zone as a backstop. The earlier `-0500` string couldn't express "America/New_York" — it's an offset, not a zone, so it has no opinion about daylight saving. An IANA name does. That alone fixed a class of one-hour-off bugs in spring and fall that I'd been writing off as flaky.

And the options spread — `{ ...options, timeZone }` — means the caller's Luxon preset survives untouched and I only inject the zone. `DATE_MED` stays `DATE_MED`; I'm not rebuilding it.

There's a subtle ordering trap worth calling out. I format `parsedDate.toJSDate()`, a plain `Date`, which is just an absolute instant — it carries no zone of its own. The zone has to come from the formatter options, *not* the Date. If you forget to pass `timeZone` to `Intl.DateTimeFormat`, it renders in the browser's local zone and you're right back where you started, except now it looks like it's working because it's correct on *your* machine.

## Wiring it into the pipes

The two pipes that templates actually use — `dateFormat` and `shortDate` — became thin. Each one picks a Luxon preset and delegates:

```ts
@Pipe({ name: 'shortDate', standalone: true })
export class ShortDatePipe implements PipeTransform {
  constructor(private readonly appDateTimeService?: AppDateTimeService) {}

  transform(value: string | Date | number): string {
    if (!value) {
      return '';
    }

    try {
      const formattedValue =
        this.appDateTimeService?.formatWithIntl(value, DateTime.DATE_SHORT) ??
        formatAppDateTimeWithIntl(value, DateTime.DATE_SHORT);

      return formattedValue || 'Invalid date';
    } catch (error) {
      console.error('ShortDatePipe Error:', error);
      return 'Invalid date';
    }
  }
}
```

`dateFormat` is the same shape with `DATE_MED`. Notice the `??`: the pipe prefers the injected `AppDateTimeService` when it's there, and falls back to the standalone `formatAppDateTimeWithIntl` when it isn't — so the pipe still renders in a bare test or a story where nobody wired up the config layer. That fallback story is its own post; what matters here is that both legs call the exact same Intl-plus-Luxon core, so the locale-aware behavior is identical whether you go through DI or not.

The standalone export is the part I'd push hardest. `formatAppDateTimeWithIntl` is a pure function — value in, string out, no class, no injector. The service is just a DI-friendly facade over it. That means non-template code can format the same way templates do without dragging a pipe into a `.ts` file. The audit log uses it to render before/after change values; the relative-time helper uses the same parse layer underneath. One way to turn an instant into a locale-correct string, reachable from everywhere.

## The sharp edges

A few things bit me that the happy path hides.

`Intl.DateTimeFormat` is not free to construct. Building a formatter does real work — locale resolution, loading the symbol tables — and a pipe that runs on every change detection cycle can construct thousands of them. For our list sizes it's been fine and I didn't reach for a cache, but the day a grid with a few thousand date cells starts feeling sticky, the fix is to key formatters by `locale + options + timeZone` in a `Map` and reuse them. I'm noting it here so future-me doesn't rediscover it as a mystery.

Locale fallback is quieter than you'd like. Ask for a locale the engine doesn't have data for and it doesn't throw — it resolves to something close and formats happily. Usually that's what you want. Occasionally it means a typo in a locale tag produces plausible-but-wrong output that no error surfaces. The array form (`['es-MX', 'es', 'en']`) is the honest way to say what you'll accept and in what order.

And the one that cost me the most: testing this is a trap because your test runner has a locale and a timezone too. A spec that asserts `formatAppDateTimeWithIntl(ts, DateTime.DATE_MED)` equals `'Apr 3, 2026'` passes on my machine and fails in CI if CI's box is set up differently. The fix is to always pass an explicit locale *and* assert against a value whose timezone you've pinned, never against whatever the environment leaks in. If a date test is green only on your laptop, it isn't green.

## What I'd do differently

The thing I'd change isn't the Intl decision — that's held up well, and not importing a translation library to format a date is a call I'd make again every time. It's that I let the *presentation level* live as Luxon presets passed in by each pipe, which means "what does a medium date look like" is decided at thirty-odd call sites that all happen to agree today. The day someone wants medium dates to include the weekday, they're hunting `DATE_MED` references instead of editing one place. If I rebuilt it, I'd expose named intents — `formatShortDate`, `formatMediumDate` — as the public surface and keep the raw options object as an escape hatch, not the front door.

The cleaner lesson is about ownership. The reason the original code was wrong wasn't that it used `formatDate` — it's that it bolted three independent decisions (which instant, which zone, which locale's shape) into one frozen string and let the environment fill in the gaps it forgot. Pull those three apart, give each one an owner, and the formatter stops being a place bugs hide. Hardcode any one of them and you've just deferred the bug to the first user who isn't you.
