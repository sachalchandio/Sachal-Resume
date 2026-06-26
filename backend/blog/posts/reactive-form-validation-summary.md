---
title: "A reusable validation summary for reactive forms"
description: "Inline mat-errors hide below the fold. A computed summary that tells you exactly which fields are wrong."
date: "2026-04-09"
updated: "2026-04-09"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "forms", "signals", "ux"]
month: "2026-04"
repo: "frontend"
author: "Sachal Chandio"
---

The sale form is long. Customer details, the plan, the service address, the install window, a block of compliance checkboxes, then payment. On a 1366x768 laptop you can't see all of it at once. So an agent fills what they can, hits **Save sale**, and nothing happens. The button just sits there, disabled, with no explanation. The one invalid field is a phone number three sections up, off screen, wearing a small red `mat-error` that nobody scrolled to see.

This came in as a support ticket worded roughly as "the save button is broken." It wasn't broken. It was doing exactly what `[disabled]="form.invalid"` says to do. The problem was that the form had no way of telling you *why* it was invalid without a scroll hunt. Material's inline errors are great when the bad field is in front of you and useless the moment it isn't.

So I built a validation summary. A panel that sits next to the submit button and lists, in plain language, every field that's currently blocking submission, with a link that scrolls you to it. Plus a tooltip on the disabled button so even before you open the panel you get a hint. Nothing exotic. The interesting part was wiring it to a Angular signal so it stays correct as the form changes, without me sprinkling `markAsTouched` calls everywhere.

## What I wanted out of it

Three things, in order of how much they mattered.

First, it had to be **driven by the form's actual state**, not a hand-maintained list. The sale form has 20-something controls and they change between projects. If the summary is a separate array I have to keep in sync, it'll rot the first time someone adds a field. The form's `status` and the controls' `errors` are the source of truth; the summary should be a pure function of those.

Second, it had to be **reusable**. We have a sale form, a lead form, an agent-onboarding form. I didn't want to write this three times. So it takes a `FormGroup` and a map of control name to label, and that's the whole API.

Third, it had to **show before the user submits**, but not nag. Material hides errors until a control is `touched`. That's the right default for inline errors — you don't want red text screaming at an empty form. But a summary that only appears after you've touched every field defeats the point. The compromise I landed on: the summary lists *all* invalid fields regardless of touched state, but it only renders at all once you've attempted a submit, or once the form is dirty enough to be worth it. More on that below, because it's where I got it wrong first.

## Computing the summary from the form

The core is a signal. I take the form's `statusChanges` (and the initial status, because `statusChanges` doesn't fire on load) and turn it into a list of problems.

```ts
import { computed, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormGroup, AbstractControl } from '@angular/forms';
import { startWith } from 'rxjs';

export interface FieldProblem {
  control: string;
  label: string;
  message: string;
}

export function buildValidationSummary(
  form: FormGroup,
  labels: Record<string, string>,
) {
  // status fires on every validity change; seed it so we have a value on load
  const status = toSignal(
    form.statusChanges.pipe(startWith(form.status)),
    { initialValue: form.status },
  );

  const problems = computed<FieldProblem[]>(() => {
    status(); // subscribe: re-run whenever validity changes
    return collectProblems(form, labels);
  });

  return problems;
}
```

That `status();` line on its own looks like a mistake the linter will flag, and it sort of is — it's there purely to register the dependency. The actual work happens in `collectProblems`, which walks the controls and maps each error key to a human sentence. I keep that mapping in one place so the wording is consistent across every form.

```ts
function collectProblems(
  form: FormGroup,
  labels: Record<string, string>,
): FieldProblem[] {
  const out: FieldProblem[] = [];

  for (const [name, control] of Object.entries(form.controls)) {
    if (control.valid || control.disabled) continue;
    const label = labels[name] ?? name;
    out.push({ control: name, label, message: describe(control, label) });
  }
  return out;
}

function describe(control: AbstractControl, label: string): string {
  const e = control.errors ?? {};
  if (e['required']) return `${label} is required`;
  if (e['email']) return `${label} isn't a valid email`;
  if (e['minlength'])
    return `${label} needs at least ${e['minlength'].requiredLength} characters`;
  if (e['pattern']) return `${label} is in the wrong format`;
  if (e['matDatepickerParse']) return `${label} isn't a valid date`;
  // catch-all so a new validator never produces a blank line
  return `${label} is invalid`;
}
```

The catch-all matters more than it looks. Early on, someone added an async uniqueness validator on the customer phone field, and because I didn't have a branch for its error key, the summary showed a row with a label and an empty message. Looked broken. The fallback `${label} is invalid` is ugly but it's never wrong, and it's a loud enough signal to go add a proper branch.

## The component

The presentation is a dumb standalone component. It takes the problems signal and an `attempted` flag, and renders a list. Clicking a row scrolls the field into view.

```ts
@Component({
  selector: 'app-validation-summary',
  standalone: true,
  imports: [MatIconModule],
  template: `
    @if (visible()) {
      <div class="summary" role="alert">
        <mat-icon>error_outline</mat-icon>
        <div>
          <p class="summary__head">
            {{ problems().length }} field{{ problems().length === 1 ? '' : 's' }}
            need attention
          </p>
          <ul>
            @for (p of problems(); track p.control) {
              <li>
                <button type="button" (click)="jump.emit(p.control)">
                  {{ p.message }}
                </button>
              </li>
            }
          </ul>
        </div>
      </div>
    }
  `,
  styleUrl: './validation-summary.component.scss',
})
export class ValidationSummaryComponent {
  problems = input.required<FieldProblem[]>();
  attempted = input(false);
  jump = output<string>();

  visible = computed(() => this.attempted() && this.problems().length > 0);
}
```

The host form owns the scroll. I give each field a stable `id` matching its control name and the parent listens for `jump`:

```ts
onJump(control: string) {
  const el = document.getElementById(`field-${control}`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // focus the input inside so they can just start typing
  el?.querySelector<HTMLElement>('input, textarea, mat-select')?.focus();
}
```

`role="alert"` on the panel is doing real work, not decoration. It means a screen reader announces the summary when it appears, which for a form this size is the difference between usable and not.

## The submit-button tooltip

The summary is the full story. The tooltip is the glance. When the button is disabled, hovering it tells you the count and the first couple of fields, so you don't even have to open the panel for the common case of one missing field.

```ts
submitTooltip = computed(() => {
  const list = this.problems();
  if (list.length === 0) return '';
  const names = list.slice(0, 2).map((p) => p.label).join(', ');
  const more = list.length > 2 ? ` +${list.length - 2} more` : '';
  return `Can't save yet — fix ${names}${more}`;
});
```

```html
<span [matTooltip]="submitTooltip()" [matTooltipDisabled]="form.valid">
  <button mat-flat-button color="primary"
          [disabled]="form.invalid"
          (click)="submit()">
    Save sale
  </button>
</span>
```

Two gotchas baked into that markup. A disabled Material button doesn't emit mouse events, so `matTooltip` on the button itself never shows — you have to wrap it in a `span` and put the tooltip on the wrapper. And I gate it with `matTooltipDisabled` on `form.valid` so a valid form doesn't show a stale "can't save" tooltip in the brief window before the binding settles.

## Where I got it wrong first

The `attempted` flag is the part I'd warn anyone about, because my first version didn't have it and it was worse.

Version one showed the summary whenever `problems().length > 0`. Which is to say: immediately, on a blank form, before the agent had typed a single character. Eight red rows greeting you on load. Technically accurate, completely obnoxious. It made the form feel like it was yelling at you for not having filled it in yet.

So I added the `attempted` signal, flipped on the first submit click:

```ts
attempted = signal(false);

submit() {
  this.attempted.set(true);
  if (this.form.invalid) {
    this.form.markAllAsTouched(); // so inline errors light up too
    return;
  }
  // ... actually save
}
```

Now the flow is: you fill the form, you hit save, *then* the summary and the inline errors appear together, pointing at the same fields from two angles. Submit a second time after fixing one and the list shrinks live, because it's computed. Get to zero and it vanishes. That's the behavior that made the ticket go away.

One more sharp edge: nested groups. The sale form has the address as a child `FormGroup`. My first `collectProblems` only walked the top level, so an invalid postcode produced an invalid form with an *empty* summary — the worst possible state, because now the button's disabled and the panel swears everything's fine. I had to make the walk recursive and prefix nested control names so the labels map and the scroll target still resolve. If your form is flat you'll never hit this; the day you nest a group, you will, and it'll confuse you for ten minutes because the form is correctly invalid and the summary is correctly empty and both of those facts are lies of omission.

## What I'd change

The label map is the weak point. Passing `Record<string, string>` from every host form is fine for three forms and would get tedious at thirty. If I did it again I'd read the label off the field's own template — we already render a `<mat-label>` next to each control, so the text exists in the DOM. A directive that registers `controlName -> label text` at render time would kill the duplication entirely and keep the summary's wording automatically in step with what the user actually sees on the field. I didn't do it because the directive is more moving parts than three small maps, and at our scale the maps win. Ask me again at thirty forms.

The other thing: the snackbar. Fixing the inline-error story made me notice we had four different ways of telling the user a save succeeded or failed — a raw `MatSnackBar.open` here, a custom toast there, a silent console.log in one place. I pulled all of it behind a tiny `NotifyService` with `success()`, `error()`, and `info()` so the success-of-save and the failure-of-save both route through one styled, consistent surface. That wasn't strictly part of this work, but a validation summary that gets you to a clean submit only to throw a naked browser error on the network call is a half-finished job. The summary tells you why you can't submit; the snackbar tells you what happened when you did. They're the same feature from the user's side, and it's worth treating them that way.
