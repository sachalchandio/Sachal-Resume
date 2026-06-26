---
title: "Optional injection: pipes that work with or without a service"
description: "A pipe that hard-requires a global service can't be reused in isolation. Making the dependency optional."
date: "2026-04-03"
updated: "2026-04-03"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "di", "pipes"]
month: "2026-04"
repo: "frontend"
author: "Sachal Chandio"
---

The error was `NullInjectorError: No provider for AppDateTimeService!`, and it came from a test I'd written for a component that had nothing to do with dates. The component rendered a sale's customer name and a `| dateFormat` next to the created timestamp. Trivial. The component spec stood up a `TestBed` with the bare minimum — just the component, no real providers — and the moment Angular tried to instantiate `DateFormatPipe`, the whole tree collapsed because the pipe demanded a service the test had never heard of.

That's the smell. A date-formatting pipe should be one of the most reusable things in the codebase. Drop it in a template, get back a string. Instead mine had taken a hard dependency on the entire app's configuration layer, and that dependency rode along into every context where the pipe appeared — including ones where the service had no business being.

## Why the pipe needed a service at all

We don't format dates with the stock Angular `date` pipe. Telelinkz has a real timezone problem: the backend writes most timestamps as offsetless MySQL `datetime` values that are, by contract, fixed GMT-5 (Ohio time), while a few columns are proper ISO strings with explicit zones, and a few more are date-only `2026-04-03` strings that must keep their calendar meaning regardless of where the viewer sits. Hand that mess to `{{ value | date }}` and you get silent off-by-one-day bugs depending on the browser's local zone.

So there's a shared parse layer that knows all of these rules. The DI-friendly face of it is `AppDateTimeService`, which leans on `ConfigService` for the configured display timezone and locale:

```ts
@Injectable({ providedIn: 'root' })
export class AppDateTimeService {
  constructor(private readonly configService: ConfigService) {}

  formatWithIntl(
    value: string | Date | number,
    options: Intl.DateTimeFormatOptions,
    locale?: AppDateTimeLocale,
  ): string | null {
    return formatAppDateTimeWithIntl(value, options, locale, this.configService);
  }
  // parse, toMillis, formatWithPattern, formatRelative, ...
}
```

The pipe, naturally, injected that service:

```ts
@Pipe({ name: 'dateFormat', standalone: true })
export class DateFormatPipe implements PipeTransform {
  constructor(private readonly appDateTimeService: AppDateTimeService) {}

  transform(value: string | Date | number): string {
    if (!value) return '';
    return this.appDateTimeService.formatWithIntl(value, DateTime.DATE_MED)
      ?? 'Invalid date';
  }
}
```

Clean enough on its own. The problem is what it drags in. `AppDateTimeService` needs `ConfigService`. `ConfigService` needs `AppSettingsService`. So the real requirement of "render this date" had quietly become "wire up the settings stack." In the running app that's free — everything is `providedIn: 'root'`, the graph resolves itself. In a test, a Storybook story, or any component you mount in isolation, it's a wall.

## The constraint I was actually under

I want to be precise about what I wasn't willing to do, because that's what ruled out the easy fixes.

I wasn't going to make every component spec import a full `AppConfigModule` just to render a date. That's the tail wagging the dog — a hundred unrelated tests paying a setup tax for a pipe they use incidentally. And I wasn't going to fork the pipe into a "real" one and a "dumb" one, because two pipes named almost the same thing is how you end up with half the templates formatting Ohio time and the other half formatting whatever the browser feels like. One pipe, one behavior, everywhere.

The thing the service does is not magic. Underneath it, the parse-and-format logic already lived as plain functions — `formatAppDateTimeWithIntl(value, options, locale?, configService?)` — and crucially the `configService` argument was already optional. When it's missing, the helpers fall back to static accessors on `ConfigService` that read the same app settings without needing an injected instance:

```ts
export const getConfiguredFrontendTimezone = (configService?: ConfigService): string =>
  configService?.getCurrentTimezoneIana() ?? ConfigService.getCurrentTimezoneIana();
```

So a working code path that needs no DI at all already existed. The pipe just wasn't using it. The service was the *preferred* way to format a date, and I'd accidentally made it the *only* way.

## Optional injection

The fix is one Angular decorator and one `??`. Make the service optional, and when it isn't there, call the standalone function directly.

```ts
import { Pipe, PipeTransform } from '@angular/core';
import { DateTime } from 'luxon';

import {
  AppDateTimeService,
  formatAppDateTimeWithIntl,
} from '../services/app-date-time.service';

@Pipe({ name: 'dateFormat', standalone: true })
export class DateFormatPipe implements PipeTransform {
  constructor(private readonly appDateTimeService?: AppDateTimeService) {}

  transform(value: string | Date | number): string {
    if (!value) return '';

    try {
      const formatted =
        this.appDateTimeService?.formatWithIntl(value, DateTime.DATE_MED) ??
        formatAppDateTimeWithIntl(value, DateTime.DATE_MED);

      return formatted || 'Invalid date';
    } catch (error) {
      console.error('DateFormatPipe Error:', error);
      return 'Invalid date';
    }
  }
}
```

I marked the constructor parameter optional with `?`. In a strict Angular project that's not quite enough on its own — the framework still tries to resolve the token and throws if it can't, so the canonical way is the `@Optional()` decorator, which tells the injector to hand back `null` instead of exploding:

```ts
constructor(@Optional() private readonly appDateTimeService?: AppDateTimeService) {}
```

Either way the contract is the same: if the service is in the graph, use it; if it isn't, `appDateTimeService` is `null`, the optional-chaining `?.` short-circuits to `undefined`, and the `??` falls through to `formatAppDateTimeWithIntl(value, DateTime.DATE_MED)` with no `configService` argument. That helper then reaches for the static `ConfigService` accessors. Same parse rules, same GMT-5 contract, same `DATE_MED` output. The only thing it loses is the injected `ConfigService` instance, and for a read of "what's the configured timezone" the static path returns the identical value.

The pipe now has two legs to stand on. The service leg is the good one — DI-wired, mockable, the path the running app takes. The function leg is the fallback that keeps the pipe from being dead weight in any context where nobody bothered to provide the service.

## The other approaches, and why I passed

I considered making the pipe **not injectable at all** — drop the service entirely and always call the standalone function. It would have worked and it's simpler. But it throws away the reason the service exists: in the real app I *want* the injected `ConfigService`, because a single configured instance is the thing tests can spy on and override, and because going through DI keeps the formatting consistent with everything else that reads config the same way. Degrading gracefully is the goal; degrading *permanently* is just giving up the feature.

I considered `providedIn: 'root'` on a wrapper and `inject()` inside `transform()`. The `inject()` function with `{ optional: true }` is the modern spelling and I'd reach for it in new code:

```ts
private readonly appDateTimeService = inject(AppDateTimeService, { optional: true });
```

That's genuinely nicer than the constructor decorator and does exactly the same thing. I left this one on the constructor because the surrounding pipes in that folder all use constructor injection and consistency inside a directory beats my preference for the newer API. Small thing. Worth being deliberate about.

And I considered the brute-force route — provide `AppDateTimeService` (and its transitive deps) in every test that touches the pipe. That's the version that scales worst. Every new spec that happens to render a date inherits a setup obligation it can't see until it fails, which is exactly the trap I'd just fallen into.

## What I gave up

Optional dependencies cost you something, and it's worth naming. The fallback path is now reachable in production, which means there are two code paths to keep behaving identically, forever. The day someone changes how `AppDateTimeService.formatWithIntl` resolves the timezone but forgets the standalone `formatAppDateTimeWithIntl`, the pipe will format dates one way inside the app and a subtly different way inside a story or a test, and that drift is precisely the kind of bug that hides for months. The mitigation is that both legs funnel into the *same* `parseAppDateTime` core — the service method is a thin facade over the function — so as long as nobody duplicates the parse logic, the two paths can't disagree about what GMT-5 means.

There's also an honesty cost. `@Optional()` makes a dependency disappear from the type system's conscience. The next reader sees a service that might be `null` and has to trust that the `?? fallback` is real and correct, not a swallowed bug. I'd rather that than a pipe that demands its whole world be wired up before it'll print a date — but optional injection should be a decision, not a reflex you reach for to silence a `NullInjectorError`.

The rule I took away: a leaf utility should ask for as little as it can do its job. A pipe is about as leaf as it gets. If yours can't render in an empty `TestBed`, it's not really a utility — it's a tax on every component it touches, and you won't feel the bill until the day you try to test one of them alone.
