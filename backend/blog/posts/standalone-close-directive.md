---
title: "A close button that works in three contexts: dialog, route, and history"
description: "One directive, made resilient with optional injection and a fallback chain instead of three copies."
date: "2026-03-26"
updated: "2026-03-26"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "directives", "di", "standalone"]
month: "2026-03"
repo: "frontend"
author: "Sachal Chandio"
---

The directive worked everywhere it had ever been used, which is to say: inside a Material dialog. The day I dropped it on a close button in a full-page route, it threw `NullInjectorError: No provider for MatDialogRef`. Of course it did. The thing was written to do exactly one job and assumed the world it lived in.

Here's the original, more or less:

```ts
@Directive({
  selector: '[appAnimatedClose]',
})
export class AnimatedCloseDirective {
  constructor(
    private el: ElementRef<HTMLElement>,
    private dialogRef: MatDialogRef<unknown>,
  ) {}

  @HostListener('click')
  onClick(): void {
    const host = this.el.nativeElement.closest('.cdk-overlay-pane');
    host?.classList.add('closing');
    host?.addEventListener('animationend', () => this.dialogRef.close(), {
      once: true,
    });
  }
}
```

It plays a small exit animation, waits for `animationend`, then closes the dialog. Fine inside an overlay. Useless anywhere else, and not in a graceful way — Angular can't construct the directive at all without a `MatDialogRef` in the injector, so the component hosting the button fails to render. The error surfaces nowhere near the button. You spend ten minutes blaming the page.

## What I actually wanted

We have close buttons in three different shapes across the CRM. The sale-detail editor opens as a dialog. The agent profile is a routed page at `/agents/:id` with a back chevron in the header. And a handful of side panels open via router outlet but get reached directly by URL too, so "close" sometimes means "go up a level" and sometimes means "there's nowhere up, just go back."

Three behaviors:

- In a dialog: `dialogRef.close()`.
- On a routed page that has a parent: navigate up one segment.
- On a page someone deep-linked into: `history.back()`.

The wrong move — the one I almost made — was three directives. `appDialogClose`, `appRouteClose`, `appHistoryClose`. Whoever places the button picks the right one. That pushes the decision onto the call site, and the call site is exactly the place that doesn't know. A reusable header component that renders a close button shouldn't have to know whether it's currently mounted in a dialog or a route. That's the whole point of it being reusable.

So I wanted one directive that figures out its own context and degrades sensibly. Inject what might be there. Use whatever is.

## Optional injection is the lever

Angular's DI lets you ask for a dependency without demanding it. `@Optional()` returns `null` instead of throwing when no provider exists. That's the entire trick here — a directive can ask for `MatDialogRef`, `Router`, and `ActivatedRoute`, and just see which ones come back populated.

```ts
@Directive({
  selector: '[appAnimatedClose]',
  standalone: true,
})
export class AnimatedCloseDirective {
  constructor(
    private el: ElementRef<HTMLElement>,
    @Optional() private dialogRef: MatDialogRef<unknown> | null,
    @Optional() private router: Router | null,
    @Optional() private route: ActivatedRoute | null,
  ) {}
}
```

Making it `standalone: true` mattered more than it looks. The old one lived in a shared `DialogModule`, which quietly imported `MatDialogModule`, which is part of why it only ever got used near dialogs — the module boundary was doing the gatekeeping. A standalone directive gets imported directly into whatever component needs it, dialog or not, and carries no module baggage. `Router` and `ActivatedRoute` are root-provided, so they resolve on any routed page; `MatDialogRef` only exists inside the dialog's own injector. The directive doesn't need to know any of that. It just reads three slots and sees what's filled.

## The fallback chain

Click handler in priority order. Dialog wins if present, because if you're in a dialog you're definitionally not navigating. Then a route with a real parent. Then history.

```ts
private close(): void {
  if (this.dialogRef) {
    this.dialogRef.close();
    return;
  }

  if (this.route && this.canGoUp(this.route)) {
    this.router?.navigate(['..'], { relativeTo: this.route });
    return;
  }

  history.back();
}

private canGoUp(route: ActivatedRoute): boolean {
  // a parent that isn't the root outlet
  return !!route.parent && route.parent.snapshot.url.length > 0;
}
```

`canGoUp` is the part I got wrong twice. `route.parent` is almost never null — even a top-level page has the root as a parent — so checking `!!route.parent` alone made every page "navigate up" into a blank root and look broken. What I actually want is a parent that owns a URL segment, something to climb to. `route.parent.snapshot.url.length > 0` is the check that holds. If the parent has no segments of its own, there's nothing meaningful above this page, and `history.back()` is the honest answer.

One thing worth saying out loud: `history.back()` can leave the app if the user landed here from an external link. I decided that's acceptable. The alternative is tracking navigation history in a service and reconstructing a safe fallback URL, and for a close button that already lives three levels deep in an edge case, that's more machinery than the problem deserves. If a deep-linked user clicks close and ends up where they came from, that's the contract a close button implies anyway.

## The animation, and the part that actually bites

The directive's whole reason to exist is the exit animation, and animation is where this kind of thing rots. The pattern is: add a class, listen for `animationend`, run the close. The bug nobody catches in review is that `animationend` is not guaranteed to fire. `prefers-reduced-motion` can strip the animation. A `display: none` toggled mid-flight kills it. The element gets detached. And then your close never runs — the button is just dead, and it's dead intermittently, which is the worst kind.

So: a timeout that fires the close if `animationend` doesn't, and a guard so the two can't both run.

```ts
@HostListener('click')
onClick(): void {
  if (this.closing) return;
  this.closing = true;

  const pane = this.el.nativeElement.closest('.animatable') as HTMLElement | null;

  if (!pane) {
    this.close();
    return;
  }

  pane.classList.add('closing');

  const done = () => {
    if (this.done) return;   // guard against double-close
    this.done = true;
    clearTimeout(timer);
    pane.removeEventListener('animationend', done);
    this.close();
  };

  const timer = setTimeout(done, 350);   // a hair past the 300ms animation
  pane.addEventListener('animationend', done, { once: true });
}
```

Two flags doing two different jobs. `closing` blocks a second click while the animation is mid-flight — without it, an impatient double-click queues two closes and on a dialog you get a flash of the next thing in the stack closing too. `done` is the latch between the two completion paths: whichever of `animationend` or the timeout arrives first wins, cancels the other, and runs `close()` exactly once. The `350` is `300` (the CSS animation duration) plus a small margin so on a healthy run the real `animationend` always beats the timer and you see the full animation; the timeout is purely the safety net for when the event never comes.

I also stopped reaching for `.cdk-overlay-pane`. That selector is a Material implementation detail and it only exists in dialogs — using it was a second hidden assumption baked into the "reusable" directive. Now the animation target is a generic `.animatable` class that the dialog, the page, and the panel each opt into. If nothing matches, the directive skips the animation and closes immediately. No crash, no dead button, just a faster close.

## Before and after, on the call site

Before, the dialog component imported a module and got a directive that only worked there:

```ts
@Component({
  imports: [DialogModule],   // drags in MatDialogModule
  template: `<button appAnimatedClose>Close</button>`,
})
```

After, every context imports the same directive directly and the button reads identically in all three:

```html
<!-- sale-detail.dialog.html -->
<button appAnimatedClose mat-icon-button><mat-icon>close</mat-icon></button>

<!-- agent-profile.page.html (routed) -->
<button appAnimatedClose class="back-btn"><mat-icon>arrow_back</mat-icon></button>
```

Same directive, same markup, three behaviors, and the component author never thinks about which one. The shared header component that renders the agent-profile back button doesn't import a dialog dependency or a router dependency — it imports `AnimatedCloseDirective` and the directive sorts out the rest at construction time.

## What I'd watch for

The thing I traded away is explicitness. A reader scanning `appAnimatedClose` on a button can't tell what it'll do without knowing the runtime context — and that's by design, but it's a real cost. If someone wraps a routed page inside a dialog someday (we do this for "preview in modal"), the dialog branch wins and the up-navigation never fires, which is probably right but is the kind of thing that's surprising at 6pm. I left a comment on the fallback chain spelling out the priority order, because the order is the contract and it isn't obvious from the call site.

The lesson I keep relearning: a directive that takes a hard dependency is a directive that only works in one place, and you usually find out which place the hard way. `@Optional()` plus a fallback chain costs three nullable injections and one ordering decision, and it buys you a thing that's hard to break by moving it. The double-close guard and the timeout aren't the interesting part — they're just the tax you pay for hanging behavior off an animation event that the browser is allowed to never send.
