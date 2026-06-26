---
title: "Signals-driven conditional sale forms"
description: "Conditional fields that appear and disappear cleanly, using Angular signals instead of a tangle of subscriptions."
date: "2024-12-11"
updated: "2024-12-11"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "signals", "forms"]
month: "2024-12"
repo: "frontend"
author: "Sachal Chandio"
---

A Spectrum sale form has a field for "Xumo Boxes." It only exists if the agent picked a TV package. There's a "Mobile Details" textarea that only exists — and is only required — if they picked a mobile package that isn't NONE. There's a "TPV Number" that shows up the instant the agent ticks "Did you do a TPV?" and has to vanish, *and forget its value*, the moment they untick it. Multiply that by sixteen providers, each with its own list of show-this-if-that rules, and you have the part of Telelinkz that quietly accumulated the most accidental complexity.

The naive version of this works. It's also the kind of code that rots in a specific, predictable way, and I want to walk through how it rotted before showing what I replaced it with.

## The version I shipped first

Every provider's new-sale component held one big plain object — `spectrumSaleInput`, `xfinitySaleInput`, and so on — bound straight to the template with `[(ngModel)]`. Conditional fields were two coordinated pieces: an `@if` in the template that decided whether the field rendered, and an imperative handler on the parent `<select>` that mutated the object when its value changed.

So the TV box count looked like this in the template:

```html
@if (
  spectrumSaleInput.tv !== "NONE" &&
  spectrumSaleInput.tv !== "UNDETERMINED"
) {
  <div class="form-group">
    <label for="xumo_box">Xumo Boxes <span>*</span></label>
    <select
      id="xumo_box"
      [(ngModel)]="spectrumSaleInput.xumo_box"
      (ngModelChange)="onFormChange()"
    >
      @for (n of xumoBoxNumbers; track n) {
        <option [value]="n">{{ n }}</option>
      }
    </select>
  </div>
}
```

And the TV `<select>` itself had a handler whose entire job was to keep the hidden field's *value* honest, because hiding a field in the DOM does nothing to the data behind it:

```ts
onTvPackageChange(selectedTV: string): void {
  this.spectrumSaleInput.tv = selectedTV;

  if (selectedTV === 'NONE' || selectedTV === 'UNDETERMINED') {
    // hide the field AND wipe its value, or a stale count leaks into the payload
    this.spectrumSaleInput.xumo_box = null;
  } else if (!this.spectrumSaleInput.xumo_box) {
    this.spectrumSaleInput.xumo_box = this.xumoBoxNumbers[0];
  }
  this.onFormChange();
}
```

The mobile field had its own near-identical twin, `onMobilePackageChange`, clearing `mobileDetails`. TPV had `onTPVChange`, clearing `tpvNumber`. Each one re-implemented the same idea — "when the parent changes, reconcile the dependent field" — by hand, in a slightly different shape, with the truth of *whether the field is visible* duplicated between the handler's `if` and the template's `@if`. Two copies of the same condition that had to agree, with nothing forcing them to.

That's the rot. Not that it's slow — it's plenty fast. It's that the condition `tv !== 'NONE' && tv !== 'UNDETERMINED'` lived in at least three places per field: the template's visibility check, the handler's reset check, and a fourth copy buried in `formValidationChecksForSpectrum()`, the eighty-line guard that ran on submit and threw on the first missing required field:

```ts
if (
  this.spectrumSaleInput.mobile !== 'NONE' &&
  (!this.spectrumSaleInput.mobileDetails ||
    this.spectrumSaleInput.mobileDetails.length === 0)
) {
  this.snackBar.open('Mobile details are required when mobile package is selected', 'Close', {
    duration: 3000,
    panelClass: ['error-snackbar'],
  });
  throw new Error('Mobile details are required when mobile package is selected.');
}
```

So "mobile details are required when a mobile package is selected" was stated once in the template (does it render), once in a handler (do we wipe it), and once in the validator (do we reject without it). Change the rule — say, NONE shouldn't suppress it anymore — and you have to find all three and keep them in sync. I missed the third copy exactly once, on the Xfinity form, and we shipped a form that hid a required field and then rejected the submit for the field the agent couldn't see. That bug is what sent me looking for a different shape.

## What I actually wanted

One source of truth per rule. The visibility of a field, its required-ness, and the reset of its value should all derive from the *same* expression, computed once, so they can't drift apart. That's a textbook job for derived state, and in Angular 17+ derived state is `computed()`.

The insight that unlocked it: a conditional field isn't really about a click handler. It's about a *predicate over the current form state*. "Show Xumo Boxes" is just `tv is a real package`. If the form's state is a signal, that predicate is a `computed`, and a `computed` is referentially the same value everywhere I read it — template, validator, reset logic. No copies.

## The refactor

I didn't rip the plain `Input` object out — it still maps cleanly to the GraphQL mutation variables and the `localStorage` draft we persist on every keystroke. I lifted the *fields that drive conditions* into signals and left the rest as is. Pragmatic, not pure.

```ts
// the parent selections, as signals
readonly tv = signal<string>('UNDETERMINED');
readonly mobile = signal<string>('UNDETERMINED');
readonly isTPV = signal<boolean>(false);

// one predicate per conditional field — the single source of truth
readonly showXumoBox = computed(
  () => this.tv() !== 'NONE' && this.tv() !== 'UNDETERMINED',
);
readonly showMobileDetails = computed(
  () => this.mobile() !== 'NONE' && this.mobile() !== 'UNDETERMINED',
);
readonly showTpvNumber = computed(() => this.isTPV());
```

The template stops repeating the boolean and reads the named predicate, which also makes it legible — `@if (showXumoBox())` says what it means in a way `tv !== 'NONE' && tv !== 'UNDETERMINED'` never did:

```html
@if (showXumoBox()) {
  <div class="form-group">
    <label for="xumo_box">Xumo Boxes <span>*</span></label>
    <select id="xumo_box" [(ngModel)]="spectrumSaleInput.xumo_box">
      @for (n of xumoBoxNumbers; track n) {
        <option [value]="n">{{ n }}</option>
      }
    </select>
  </div>
}
```

The three imperative handlers — `onTvPackageChange`, `onMobilePackageChange`, `onTPVChange` — collapse into setting one signal. The `<select>` just does `(ngModelChange)="tv.set($event)"`. The value-reset logic, the part that wipes `xumo_box` when TV goes to NONE, moves into a single `effect` that watches the predicates and reconciles the payload:

```ts
constructor() {
  // when a field becomes hidden, clear its value so it never leaks into the mutation
  effect(() => {
    if (!this.showXumoBox()) this.spectrumSaleInput.xumo_box = null;
    if (!this.showMobileDetails()) this.spectrumSaleInput.mobileDetails = '';
    if (!this.showTpvNumber()) this.spectrumSaleInput.tpvNumber = null;
  });
}
```

That effect is the *only* place a hidden field's value gets cleared, and it's driven by the *same* `computed` the template uses to hide it. Hidden and cleared can no longer disagree, because they read one value.

The validator stops re-deriving the condition too. Instead of `if (mobile !== 'NONE' && !mobileDetails)`, it asks the predicate:

```ts
if (this.showMobileDetails() && !this.spectrumSaleInput.mobileDetails) {
  throw new Error('Mobile details are required when mobile package is selected.');
}
```

Now the rule lives in exactly one expression, `showMobileDetails`, and visibility, reset, and validation all consult it. The three-copies-that-must-agree problem is gone by construction, not by discipline.

## Generalizing it past Spectrum

Spectrum and Xfinity were where I proved the pattern, and they were also where I noticed I was about to copy-paste `showXumoBox`/`showMobileDetails` into fourteen more components with only the field names changed. So I pulled the shape into a tiny helper. A conditional field is a parent signal, a predicate, and a reset value:

```ts
interface ConditionalField<T> {
  visible: Signal<boolean>;
  reset: () => void;
}

function dependentField<T>(
  predicate: () => boolean,
  clear: () => void,
): ConditionalField<T> {
  return { visible: computed(predicate), reset: clear };
}
```

Each provider component declares its conditional fields as a small map, and one generic effect drives every reset:

```ts
readonly conditionals = {
  xumoBox: dependentField(
    () => this.tv() !== 'NONE' && this.tv() !== 'UNDETERMINED',
    () => (this.spectrumSaleInput.xumo_box = null),
  ),
  mobileDetails: dependentField(
    () => this.mobile() !== 'NONE' && this.mobile() !== 'UNDETERMINED',
    () => (this.spectrumSaleInput.mobileDetails = ''),
  ),
};

constructor() {
  effect(() => {
    for (const f of Object.values(this.conditionals)) {
      if (!f.visible()) f.reset();
    }
  });
}
```

The template reads `conditionals.xumoBox.visible()`. The validator reads it too. Adding a new conditional field to any provider is one entry in the map — declare the predicate and the reset, done — instead of a template `@if`, a handler, a reset branch, and a validator clause kept manually in lockstep.

## The sharp edges

A few things bit me, and they're the parts worth knowing before you do this.

**Effects don't run during change detection the way you expect, and ngModel writes are async-ish.** My first version put the reset logic in a `computed` instead of an `effect` — I tried to make the cleared value itself derived. That's wrong, and Angular tells you so: a `computed` must be pure, and assigning to `this.spectrumSaleInput.xumo_box` inside one is a side effect. It either throws in dev mode or, worse, silently runs at a surprising time. The reset *is* a side effect — it mutates state in response to a state change — so it belongs in `effect`, not `computed`. The predicate is derived; the consequence of the predicate is an effect. Keeping that line straight is the whole game.

**A reset effect can fight the user mid-edit if the predicate is too eager.** Early on I had the TPV reset keyed off a predicate that recomputed on every keystroke in an unrelated field, and under one ordering it cleared `tpvNumber` a tick after the user typed it. The fix was making the predicate depend *only* on the thing that should gate the field — `this.isTPV()` and nothing else. If your reset effect reads more signals than the predicate logically needs, it'll fire more often than it should. Effects run on any tracked dependency changing, so an over-broad dependency set means over-eager resets. Keep the predicate's dependencies minimal.

**Edit mode skips the reset.** When you load an existing sale to edit it, you hydrate the form from the server, and for a beat the parent selection and the dependent value are both being set. If the effect runs between those two writes it'll wipe the value you're about to populate. I guard the whole reconcile with an `editMode` check — in edit mode the server is the source of truth, not the predicate, so the reset stays out of the way until the user actually changes something. That's the same `editMode` flag that already short-circuits the `localStorage` draft save, so it fit cleanly.

## What I'd do differently

I'd reach for Angular's reactive forms with a `FormGroup` and per-control `setValidators`/`disable()` instead of the plain `ngModel` object, and let the framework own visibility and validity together. The signals approach I built is genuinely cleaner than the subscription spaghetti it replaced, but it's a clean *workaround* for the fact that these forms are template-driven objects bound with `ngModel`, not real reactive forms. A `FormControl` that's `disabled` is automatically excluded from the form's value and skips its validators — which is most of what my reset effect and validator guard are doing by hand. The reason I didn't is that converting sixteen mature provider forms to reactive forms is a much bigger blast radius than wrapping three fields in signals, and the signals version shipped in an afternoon with no schema or template rewrite.

So the honest framing isn't "signals beat reactive forms." It's that derived state gave me one place to say each rule, and that alone fixed the class of bug where a form hides a field and then rejects you for not filling it in. The predicate that decides whether you see a field is now the same predicate that decides whether you're required to fill it — and when something is provably the same value, it can't drift. That property, more than the syntax, is what I was buying.
