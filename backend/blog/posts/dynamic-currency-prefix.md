---
title: "Currency prefixes without hardcoding the dollar sign"
description: "A hardcoded $ broke the moment a second currency showed up. Abstracting the symbol and separator."
date: "2025-11-07"
updated: "2025-11-07"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "i18n", "forms"]
month: "2025-11"
repo: "frontend"
author: "Sachal Chandio"
---

The commission input had a dollar sign baked into it. One character, `$`, sitting in the template as a `matTextPrefix`. It worked fine for about a year because every team using Telelinkz was in the US and nobody questioned it. Then a Canadian team came on, flipped their app currency to CAD, and the commission dialog still cheerfully printed `$200` next to a field that was now, semantically, two hundred Canadian dollars. The number was right. The symbol was lying.

That's the kind of bug that doesn't crash anything. It just quietly tells the user something false, which is worse.

## What was actually there

The offending markup was about as innocent as it gets:

```html
<input matInput type="number" formControlName="newCommission" />
<span matTextPrefix>$</span>
```

A literal `$` inside the Material form field's prefix slot. There was a second copy of the same assumption a few lines down in a different dialog, and a third buried in a helper that built a display string by concatenating `'$'` onto a formatted number. Classic. The locale assumption wasn't in one place I could fix; it had spread because copying `$` is faster than thinking about it.

Telelinkz already supported four currencies at the data layer — USD, EUR, CAD, PKR — selectable per app instance. The amounts were never converted; a commission of 200 is 200 regardless of which currency the team operates in. So this was purely a display problem. I didn't need exchange rates or a money library. I needed the right glyph in front of the right number.

## The decision: don't reach for `Intl.NumberFormat` and call it done

The obvious move is `new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(200)`. And for formatting a finished amount, I do use exactly that elsewhere. But a `matTextPrefix` is not a formatted string — it's the bit that sits *before* the user's live input in a number field. I needed the prefix on its own, decoupled from the value, and I needed it to be stable as the user typed.

There was also a subtlety I only noticed by staring at the outputs. `Intl` gives you `CA$` for Canadian dollars and `$` for US dollars in `en` locales, which is correct and what I wanted. But for PKR it gives `PKR` or `Rs` depending on locale, glued directly against the digits — `Rs1,200` reads badly. I wanted a thin space between the symbol and the number for that one case, and no space for the symbol-hugging currencies. That's not a thing `Intl` exposes as a knob. It's a presentation choice, and presentation choices belong to me, not to the formatter.

So I made the currency's display identity an explicit object: a symbol, and a separator that goes between symbol and number.

```ts
export interface CurrencyDisplayMetadata {
  code: SupportedCurrency;
  symbol: string;
  separator: string;
}

const CURRENCY_DISPLAY_METADATA: Record<
  SupportedCurrency,
  CurrencyDisplayMetadata
> = {
  USD: { code: 'USD', symbol: '$',   separator: ''  },
  EUR: { code: 'EUR', symbol: '€',   separator: ''  },
  CAD: { code: 'CAD', symbol: 'CA$', separator: ''  },
  PKR: { code: 'PKR', symbol: 'Rs',  separator: ' ' },
};
```

Four rows. That's the whole locale table for display purposes. Adding a fifth currency is adding a fifth row, and the type system makes me — `Record<SupportedCurrency, …>` won't compile if I add a currency to the union and forget its metadata. I'd rather have the compiler nag me than discover a missing symbol in production.

## The helper

The accessor is deliberately boring:

```ts
function resolveDisplayCurrency(currency?: string): SupportedCurrency {
  return normalizeCurrency(currency ?? getCurrentAppCurrency());
}

export function getCurrencyDisplayMetadata(
  currency?: string,
): CurrencyDisplayMetadata {
  return CURRENCY_DISPLAY_METADATA[resolveDisplayCurrency(currency)];
}
```

Call it with no arguments and it reads the current app currency. Pass a code and it gives you that one. `normalizeCurrency` clamps anything unrecognized back to `USD` so a bad value in storage can't blow up the lookup — `CURRENCY_DISPLAY_METADATA[undefined]` would hand back `undefined` and then `.symbol` would throw, and a thrown error inside a template expression in Angular is a genuinely annoying thing to debug. The default is load-bearing.

On top of that I added two thin conveniences, because most call sites only want one field:

```ts
export function getCurrencySymbol(currency?: string): string {
  return getCurrencyDisplayMetadata(currency).symbol;
}

export function getCurrencyCode(currency?: string): SupportedCurrency {
  return getCurrencyDisplayMetadata(currency).code;
}
```

## Driving the template from it

The component method that feeds the prefix is three lines, and the only interesting thing about it is that it joins symbol and separator so the field can stay dumb:

```ts
getCommissionInputPrefix(): string {
  const metadata = getCurrencyDisplayMetadata();
  return `${metadata.symbol}${metadata.separator}`;
}
```

And the template loses its hardcoded character:

```html
<input
  matInput
  type="number"
  step="0.01"
  min="0"
  max="20000"
  formControlName="newCommission"
/>
<span matTextPrefix>{{ getCommissionInputPrefix() }}</span>
```

For a US team that renders `$`. For Canada, `CA$`. For a Pakistani team, `Rs ` with the trailing space, so the input shows `Rs 1200` instead of `Rs1200`. Nothing in the template knows or cares which currency it is. The assumption that used to live in markup now lives in a typed table that one function owns.

## The sharp edge: calling a function in a template binding

I bound the prefix to a method call, `{{ getCommissionInputPrefix() }}`, and I want to be honest that this is the lazy version. Angular's change detection re-invokes that method on every cycle. For a one-character string that's computed from a synchronous lookup, the cost is nothing I will ever measure. But it's the same pattern that, scaled up to a method doing real work, turns into the death-by-a-thousand-calls performance posts everyone has read.

The cleaner version is a `computed` signal, since the app currency is effectively a signal-shaped value:

```ts
readonly commissionInputPrefix = computed(() => {
  const { symbol, separator } = getCurrencyDisplayMetadata();
  return `${symbol}${separator}`;
});
```

```html
<span matTextPrefix>{{ commissionInputPrefix() }}</span>
```

That only recomputes when the currency actually changes. I left the method form in the commission dialog because the prefix is genuinely static for the lifetime of that dialog and converting it earned nothing, but the signal is what I reach for now in anything that re-renders a lot.

## The other edge: the prefix and the formatter have to agree

Here's the trap I walked into and then designed around. The input prefix is built from the metadata. The *display* of a saved commission — the read-only `$200.00` elsewhere on the page — goes through a separate `getCurrencyDisplayParts` function that runs the number through `Intl.NumberFormat` and then prepends `symbol + separator`. Two code paths, one source of truth. If they pulled their symbol from different places, you'd get `CA$` in the input and `$` in the summary on the same screen, which is exactly the sort of inconsistency that makes users distrust the whole number.

The fix was to make both paths read the same metadata object. The formatter pulls `metadata.symbol` and `metadata.separator` from `getCurrencyDisplayMetadata` too:

```ts
const metadata = getCurrencyDisplayMetadata(currency);
// ...
formattedValue: `${sign}${metadata.symbol}${metadata.separator}${numberText}`,
```

The number formatting is `Intl`'s job — grouping, decimal separators, locale-correct digit shaping, all the stuff I have no business reimplementing. The *symbol* is the metadata table's job. Splitting it that way means the live input and the rendered amount can never disagree about the symbol, because there's only one table they both consult.

## What I'd do differently

I'd have built the metadata table the first time I typed `$` into a template, not the day a Canadian team made me. The cost of the abstraction up front was an interface and a four-row record — maybe twenty minutes. The cost of *not* having it was a hunt across three files for hardcoded dollar signs, plus the embarrassment of a customer noticing before I did.

The other thing: I'd resist the temptation to think `Intl` solves locale and therefore I don't have to think about presentation. `Intl` solves *number* formatting. It does not solve "does this particular team want a space after their currency symbol," because that's a taste question, not a standards question, and the standard genuinely doesn't have an opinion. PKR's trailing space lives in my table precisely because no formatter was going to give it to me.

When this bites you: the day you add a currency whose symbol goes *after* the number — some locales write `200 kr`. My table assumes prefix placement everywhere; there's no `position: 'prefix' | 'suffix'` field. The moment Telelinkz needs a suffix currency, the table grows a column and the prefix logic grows a branch. I know that's coming. I just decided not to pay for it until it shows up, because so far every currency I support hugs the front of the number, and building for a customer I don't have yet is its own kind of waste.
