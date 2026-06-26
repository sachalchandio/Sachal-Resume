---
title: "Designing a no-code form builder without losing your mind"
description: "Schema as data, a runtime renderer, validation as JSON, dependency rules — and the hard limits of generality."
date: "2026-06-16"
updated: "2026-06-16"
kind: "deepdive"
category: "Architecture"
tags: ["no-code", "architecture", "meta-programming"]
month: "2026-06"
repo: "both"
author: "Sachal Chandio"
---

Every "provider" we onboard at Telelinkz wants a slightly different intake form. AT&T wants the customer's account number and a service address. Spectrum wants a credit-check consent checkbox and a promo code that only shows up if the rep picked a bundle. The next one will want something I haven't seen yet. The first version of this lived as hand-built Angular reactive forms, one component per provider, and by the third provider I was copy-pasting `Validators.required` into files that differed by about 12 lines each. That doesn't scale, and worse, every change meant a frontend deploy. A sales ops person should be able to add a field without me.

So I built a form builder. This is the part nobody tells you: a no-code builder is a small language, and you are now the language designer. The whole job is deciding what stays data and what stays code, and being ruthless about the line.

## The thesis: store the form as data, render it with one component

The form is a row in MySQL. Not a generated `.ts` file, not a code-gen step. A `provider_form` row holds a JSON schema, and a single Angular renderer turns that JSON into a live reactive form at runtime. Add a provider, insert a row. No deploy.

Here's the shape that survived contact with reality, trimmed to the essentials:

```ts
interface FormField {
  key: string;              // unique within the form, becomes the control name
  type: FieldType;          // 'text' | 'number' | 'select' | 'date' | 'checkbox' | 'phone'
  label: string;
  validators?: ValidatorSpec[];
  options?: SelectOption[]; // for select/radio
  rules?: DependencyRule[]; // show/require/disable based on other fields
  binding?: BindingPath;    // where this value lands on the Sale entity
}

interface ValidatorSpec {
  kind: 'required' | 'minLength' | 'maxLength' | 'pattern' | 'min' | 'max';
  value?: string | number;
  message: string;          // the exact text the rep sees
}
```

Three things are doing the real work here, and I want to be specific about each because the details are where these projects die.

**`validators` is data, including the message.** I learned this the hard way. My first cut stored `kind: 'pattern'` and generated the error message in the renderer (`"Invalid " + field.label`). Then a provider needed account numbers to be "exactly 9 digits, no spaces" and the auto-message read "Invalid Account Number," which is useless to a rep on a call. Putting `message` in the schema means the person who writes the rule writes the words. The renderer never invents copy.

**`binding` keeps the schema decoupled from storage.** A form field named `acctNo` might need to land in `Sale.providerAccountNumber`. I do not want the column name leaking into the form definition, and I do not want the form definition to assume a column exists. The binding is a path the backend resolves when it persists the sale, and unbound fields just get dumped into a `metadata` JSON column. That escape hatch matters — it's what lets ops add a field today that I'll promote to a real column next sprint if it turns out to matter.

## The runtime renderer

One component reads the schema and builds an Angular `FormGroup`. The naive version is short and that's the point:

```ts
buildGroup(fields: FormField[]): FormGroup {
  const group: Record<string, FormControl> = {};
  for (const f of fields) {
    group[f.key] = new FormControl(
      { value: this.initialValue(f), disabled: false },
      this.toValidators(f.validators ?? []),
    );
  }
  return new FormGroup(group);
}

private toValidators(specs: ValidatorSpec[]): ValidatorFn[] {
  return specs.map((s) => {
    switch (s.kind) {
      case 'required':  return withMessage(Validators.required, s.message);
      case 'minLength': return withMessage(Validators.minLength(+s.value!), s.message);
      case 'pattern':   return withMessage(Validators.pattern(String(s.value)), s.message);
      // ...
      default: throw new Error(`Unknown validator kind: ${s.kind}`);
    }
  });
}
```

`withMessage` is a thin wrapper that attaches the schema's `message` to the validation error, so the template renders the exact text without a translation map. The template itself is one `@switch` over `field.type` with a case per widget. That switch is the entire UI layer. When someone asks for a new field type, I add one case and one row of validator mapping, and I am done.

The discipline: **the renderer knows about field *types*, never about *providers*.** The moment you see `if (provider === 'spectrum')` in the renderer, the design has failed. That conditional belongs in data.

## Dependency rules: the part that earns its keep

Static forms are easy. The interesting forms are reactive — a field that's required only when another field has a certain value. Spectrum's promo code is required if the rep selected a bundle, hidden otherwise. I modeled this as `DependencyRule` on the field:

```ts
interface DependencyRule {
  when: { field: string; op: 'eq' | 'neq' | 'in' | 'truthy'; value?: unknown };
  then: 'SHOW' | 'HIDE' | 'REQUIRE' | 'DISABLE';
}
```

The classic one is `REQUIRE_IF`: require this field when another equals something.

```json
{
  "key": "promoCode",
  "type": "text",
  "label": "Promo code",
  "rules": [
    { "when": { "field": "planType", "op": "eq", "value": "bundle" },
      "then": "REQUIRE" },
    { "when": { "field": "planType", "op": "neq", "value": "bundle" },
      "then": "HIDE" }
  ]
}
```

At runtime the renderer subscribes once to the whole group's `valueChanges`, evaluates every rule, and reconciles. The thing that bit me: when a field flips to `HIDE`, you have to clear its value and strip its validators, or you ship an invisible required field and the form is dead — the rep gets a "fix the errors" toast with nothing visibly wrong. I spent a genuinely embarrassing afternoon on exactly this before I wrote it down.

```ts
applyRule(ctrl: AbstractControl, rule: DependencyRule, active: boolean) {
  switch (rule.then) {
    case 'REQUIRE':
      this.setRequired(ctrl, active);
      break;
    case 'HIDE':
      if (active) { ctrl.reset(null, { emitEvent: false }); ctrl.disable({ emitEvent: false }); }
      else        { ctrl.enable({ emitEvent: false }); }
      break;
    // ...
  }
  ctrl.updateValueAndValidity({ emitEvent: false });
}
```

`emitEvent: false` everywhere, or one rule's reconciliation re-triggers `valueChanges` and you get a feedback loop that pins a CPU core. Ask me how I know.

I deliberately did **not** build a general expression language. No `"planType === 'bundle' && region in ['NE','SE']"` parser. The `when` is a single comparison against one other field. If a rule needs two conditions, you add two rules, or — and this is the important part — you stop. More on stopping in a second.

## Validate on both sides, or it's theater

The schema renders on the frontend, but the backend cannot trust a single byte of it. A rep can open devtools; a malformed payload can hit the GraphQL mutation directly. So the same schema is the source of truth on the NestJS side too. When a sale comes in, the resolver loads the `provider_form` row, walks the field list, and re-runs the validators server-side before anything touches the `sales` table.

```ts
async validateAgainstSchema(providerId: string, input: Record<string, unknown>) {
  const schema = await this.formRepo.findActiveByProvider(providerId);
  const errors = schema.fields.flatMap((f) => this.checkField(f, input[f.key]));
  if (errors.length) throw new BadRequestException({ fieldErrors: errors });
}
```

Same JSON, two enforcement points. That's the actual payoff of schema-as-data: the rule lives in one row, and both Angular and NestJS read it. I cache the active schema per provider in Redis with a short TTL and bust it on save, because forms get read on every sale and written maybe once a week.

## Where it bites — and the rule about stopping

Here's the honest part. Schema-driven UI is a tax you pay on the unusual cases to save on the common ones. It pays off when forms are mostly fields, validation, and simple show/hide. It stops paying the moment a form needs real behavior.

The case that broke generality: one provider needed an address field that calls a USPS-style verification service on blur, shows a "did you mean…" suggestion, and rewrites the entered address if the rep accepts. I sat down to invent `type: 'verifiedAddress'` with a `serviceUrl` in the schema and a `suggestionMapping` config and a debounce setting and — I stopped. I was about to encode an HTTP client, a debounce, and a UI affordance into JSON. That's not configuration anymore. That's a worse programming language with no type checker and no debugger.

So I wrote the special case. A real Angular component, `VerifiedAddressFieldComponent`, with actual code. The schema just says `type: 'custom', component: 'verifiedAddress'`, and the renderer's `@switch` has one case that delegates to a registry of hand-written components. The builder stays a builder for the 95% that's boring, and the weird 5% gets to be code that a human can read and step through.

That's the whole discipline in one sentence: **generalize the regular, hard-code the exceptional, and make the seam between them explicit and cheap to cross.** The `type: 'custom'` escape hatch is that seam. Without it, you either bloat the schema language until it's an untyped DSL nobody can maintain, or you refuse the requirement and lose the deal.

A few things I'd tell myself before starting:

- Put the user-facing message in the schema, not the renderer. The person writing the rule writes the words.
- The renderer must never know a provider's name. If it does, you've leaked data into code.
- Build `REQUIRE_IF`/`HIDE_IF` early; skip the general expression parser forever. Two simple rules beat one clever one.
- Validate server-side from the same schema. Frontend validation is UX; backend validation is the actual contract.
- Always have a `type: 'custom'` door. The day you need it, you'll need it badly, and retrofitting it is painful.

The builder didn't eliminate code. It moved the boring code into data and concentrated the interesting code into a handful of named components I'm not embarrassed to open. That's the win — not "no code," just code in the right places, and a clear, defended line between the two.
