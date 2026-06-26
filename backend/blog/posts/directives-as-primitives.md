---
title: "Angular directives as app-wide primitives"
description: "Optional injection, standalone, fallback chains — building a directive that encodes a policy once and reuses it everywhere."
date: "2026-06-25"
updated: "2026-06-25"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "directives", "architecture"]
month: "2026-06"
repo: "frontend"
author: "Sachal Chandio"
---

Most Angular directives I see in the wild are decoration. `appAutofocus`, `appTrimWhitespace`, a hover class. Useful, throwaway, scoped to one component's quirks. I used to write them that way too.

Then two of them on Telelinkz turned into something else. A close button that animates a modal out. A name in a table that opens a user's profile. Neither is exotic. But getting them to drop into *any* of the dozen contexts where they were needed — a Material dialog, a routed full-page view, a deep-nested grid cell — forced a set of decisions that I now treat as the recipe for an app-wide primitive. Standalone so it has no module to import. Optional injection so it degrades instead of throwing. A fallback chain for the contexts you didn't anticipate. And, when there's an access rule involved, a paired service so the policy lives in exactly one place.

This post is those two directives and what each one taught me.

## The close button that doesn't know where it lives

Telelinkz has a "new sale" flow. Sometimes it opens as a Material dialog over the sales board. Sometimes it's a routed page you land on from a deep link. Same component, two mounting contexts, and a close button in the corner of both.

The naive version I shipped first took a callback `@Input`:

```html
<button (click)="onClose()">×</button>
```

Every host then had to define `onClose()`. In the dialog it was `this.dialogRef.close()`. On the routed page it was `this.router.navigate(['..'])`. Two implementations of "close" copy-pasted into every wrapper that reused the flow, and a third the day someone embedded it somewhere I hadn't planned. That's the smell: the button doesn't actually need the host to tell it how to close. It can figure that out from where it finds itself in the injector tree.

So the directive injects everything that *could* mean "close" and treats them all as optional:

```ts
@Directive({
  selector: '[appAnimatedClose]',
  standalone: true,
})
export class AnimatedCloseDirective {
  constructor(
    private el: ElementRef<HTMLElement>, // the <button>
    @Optional() private dialogRef?: MatDialogRef<any>,
    @Optional() private router?: Router,
    @Optional() private route?: ActivatedRoute,
  ) {}
```

`@Optional()` is the whole trick here. `MatDialogRef` is only provided when you're inside a dialog — Material registers it on the dialog's injector. Ask for it on the routed page and Angular's DI throws a `NullInjectorError` that takes down the component. Mark it optional and you get `undefined` instead. Now the same button can be mounted in a context where half its dependencies simply don't exist, and it shrugs.

The close logic is a priority chain. Most specific context wins; the last branch is the one that always works:

```ts
const finalizeClose = () => {
  if (hasClosed) return;
  hasClosed = true;

  if (this.dialogRef) {
    this.dialogRef.close();
    return;
  }
  if (this.router && this.route) {
    void this.router.navigate(['..'], { relativeTo: this.route });
    return;
  }
  window.history.back();
};
```

Dialog if there is one. Otherwise route up a level. Otherwise — for the context I haven't met yet — fall back to browser history. That last line is doing real work. It's the difference between "this directive supports the cases I enumerated" and "this directive does something sane everywhere." `window.history.back()` is a crude default, but a crude default that fires beats a `NullInjectorError` that doesn't.

The animation is the other half, and it's where I learned to never trust `animationend` alone:

```ts
const wrapper = this.el.nativeElement.closest('.new_sale_wraper') as HTMLElement;
if (!wrapper) {
  finalizeClose();
  return;
}

wrapper.classList.add('closing');
wrapper.addEventListener('animationend', finalizeClose, { once: true });
window.setTimeout(finalizeClose, 350);
```

Add a `.closing` class, let the CSS run the exit animation, close when it ends. But `animationend` doesn't fire if the user has reduced-motion on, or if the element gets detached mid-animation, or if there's no matching `.new_sale_wraper` ancestor at all. So there are three independent paths to `finalizeClose` — the animation event, a 350ms timeout, and the no-wrapper early exit — and a `hasClosed` boolean so whichever wins, the other two are no-ops. I've watched a modal hang open forever because someone trusted a single `animationend`. The timeout is not belt-and-suspenders, it's the belt.

What this one taught me: **an app-wide primitive reads its context from DI, it doesn't take it as configuration.** The moment you find yourself passing `[closeStrategy]="..."` you've pushed the decision back onto every caller. Let the directive look around and decide.

## The profile link, and where the policy actually lives

Second directive, harder problem. Across Telelinkz a user's name shows up everywhere — who made a sale, who penalized whom, who's assigned to a lead. We wanted those names clickable to open a profile dialog. But not for everyone. Privileged users (admins, managers) can open anyone's profile. A normal agent can only open their own. Click anyone else's name and it should render as plain, dead text — no pointer cursor, no underline, no role, nothing.

The trap is obvious in hindsight: that access rule wants to live in the directive, because the directive is what paints the affordance. But it *also* has to live wherever the dialog actually opens, because a determined caller can call the service directly and skip the directive entirely. Put the rule in both and they drift. One day someone loosens the directive and forgets the service, and now the cursor says "not clickable" but the dialog opens anyway.

So the policy is one pure function, owned by neither:

```ts
export function canOpenProfile(
  targetUserId: string | null | undefined,
  currentUserId: string | null | undefined,
  isPrivileged: boolean,
): boolean {
  const target = String(targetUserId ?? '').trim();
  if (!target) return false;
  if (isPrivileged) return true;
  const current = String(currentUserId ?? '').trim();
  return current.length > 0 && current === target;
}
```

No `this`, no injection, no side effects. It takes three values and returns a boolean, which means it has a real unit test (`user-profile-access.spec.ts`) that doesn't need a TestBed. Privileged sees all. Normal user sees self. No id, no profile. That's the entire access model for profiles on the app, and it's about ten lines.

The directive consumes it to decide whether to even *look* clickable:

```ts
@HostBinding('class.user-profile-link') canOpen = false;

@HostBinding('attr.role') get role(): string | null {
  return this.canOpen ? 'button' : null;
}
@HostBinding('attr.tabindex') get tabindex(): number | null {
  return this.canOpen ? 0 : null;
}

private recompute(): void {
  this.canOpen = canOpenProfile(
    this.targetId,
    this.currentUserId,
    this.authService.isPrivilegedUserCached(),
  );
}
```

When `canOpen` is false the element gets no `role`, no `tabindex`, no hover class, and the click handler returns early. It is genuinely inert — a screen reader doesn't announce a button, keyboard tab skips it, the cursor stays an arrow. That matters more than hiding it. A greyed-out-looking thing you can't click is worse UX than text that was never pretending to be interactive.

And the service — `UserProfileDialogService`, the single entry point that ~9 call sites use — runs the *same function* before it opens anything:

```ts
private guardThenOpen(targetId: string, open: () => void): void {
  this.canOpen(targetId).then((allowed) => {
    if (allowed) open();
  });
}
```

Directive gates the affordance, service gates the action, both call `canOpenProfile`. The directive is the UX; the service is the defense-in-depth backstop. No caller can construct a path that opens a profile the policy forbids, because the policy is checked at the door no matter which door you come through.

The directive also handles the messy reality of what a "target" is. Half the call sites have a full user object from a GraphQL fragment; half have only an id string they pulled off a sale row. So the input accepts either:

```ts
type UserProfileTarget = string | UserProfileLike | null | undefined;

@Input('appUserProfileLink') target: UserProfileTarget;
@Input() profileFallbackName?: string;
```

If it's an object, the service opens it directly. If it's a bare id, the service fetches the full user and — if that fetch fails — falls back to a minimal `{ id, name }` built from `profileFallbackName`. Same fallback-chain instinct as the close button: the happy path, then a degraded path, then a path that's ugly but never blank.

One honest wrinkle. `currentUserId` arrives from an async `getCurrentUserId()`, so on first paint `canOpen` is `false` and the element is briefly inert until the promise resolves and `recompute()` runs. For an admin dashboard that's a non-issue — the flicker is sub-frame. If these names were the primary interaction on a latency-sensitive screen I'd resolve the current user higher up and pass it down synchronously rather than eat a microtask per directive instance. It wasn't worth it here. Know when it would be for you.

## When this is the wrong tool

Directives-as-primitives is not free, and I've over-reached with it.

If the behavior needs a template — a tooltip with markup, a popover with its own layout — that's a component, not a directive. Don't contort a directive into rendering DOM it has to `createElement` by hand.

If only one component ever uses it, leave it in that component. A directive earns its keep at the third call site, not the first. I've written "reusable" directives used exactly once and they're just indirection with a decorator.

And `@Optional()` everywhere can hide real wiring bugs. If a dependency is genuinely required in every context, inject it normally and let DI throw — a loud `NullInjectorError` at startup beats a directive that silently does nothing because the thing it needed was quietly `undefined`. Optional is for dependencies that are *legitimately* absent in some contexts, not a blanket way to dodge DI errors.

The rules I actually keep:

- **Read your context from the injector, don't take it as `@Input`.** `@Optional()` plus a fallback chain beats a strategy parameter every caller has to fill in.
- **The last branch of the fallback chain must work everywhere.** `window.history.back()`, a minimal `{ id, name }` object — ugly is fine, blank is not.
- **If there's a policy, extract it to a pure function and call it from both the affordance and the action.** Two copies of an access rule will drift; one tested function won't.
- **Make "not allowed" mean structurally inert** — no role, no tabindex, no handler — not just visually dimmed.
- **Three call sites, then promote.** Below that, you're paying for reuse you don't have.

The close button and the profile link don't look related. But they're the same shape: a small piece of behavior that had to survive being dropped into places I hadn't thought of yet. That survival is the whole point of calling something a primitive.
