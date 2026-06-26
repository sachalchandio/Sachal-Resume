---
title: "OnPush and upload progress: markForCheck and flexible dialogs"
description: "Progress that never updated, and a dialog hardcoded to 960px. Fixing change detection and sizing."
date: "2026-03-15"
updated: "2026-03-15"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "change-detection", "onpush"]
month: "2026-03"
repo: "frontend"
author: "Sachal Chandio"
---

You drop a 40MB call recording onto the file manager, the spinner appears, and then nothing moves for eight seconds. No bar, no percentage, no sign the browser is doing anything at all. Then the row snaps in, fully uploaded, as if it teleported. The upload worked. It always worked. What didn't work was the part where a human watching the screen could tell.

That's the bug a sales manager reported, more or less: "the upload froze, but the file showed up anyway." It hadn't frozen. The progress was being computed perfectly — it just never made it to the screen.

## The progress was there. The view wasn't listening.

The upload service was already wired for progress. We use Angular's `HttpClient` with `reportProgress` and `observe: 'events'`, which gives you a stream of `HttpEvent`s including `HttpEventType.UploadProgress`, each carrying `loaded` and `total`. The service did the arithmetic and pushed a number out:

```ts
upload(file: File): Observable<UploadState> {
  const form = new FormData();
  form.append('file', file);

  return this.http
    .post('/api/files/upload', form, {
      reportProgress: true,
      observe: 'events',
    })
    .pipe(
      map((event) => {
        if (event.type === HttpEventType.UploadProgress) {
          const percent = event.total
            ? Math.round((100 * event.loaded) / event.total)
            : 0;
          return { status: 'uploading', percent } as UploadState;
        }
        if (event.type === HttpEventType.Response) {
          return { status: 'done', percent: 100 } as UploadState;
        }
        return { status: 'pending', percent: 0 } as UploadState;
      }),
    );
}
```

And the dialog component subscribed and stored it on a field the template reads:

```ts
this.uploadSvc.upload(file).subscribe((state) => {
  this.uploadState = state;
});
```

```html
<mat-progress-bar mode="determinate" [value]="uploadState.percent" />
<span>{{ uploadState.percent }}%</span>
```

By every reasonable reading, that should animate from 0 to 100. The field updates. The template binds to the field. So I did the thing you do when a binding doesn't update: I logged it.

```ts
this.uploadSvc.upload(file).subscribe((state) => {
  console.log('progress', state.percent);
  this.uploadState = state;
});
```

The console scrolled beautifully. `4, 11, 19, 26, 33, ... 88, 95, 100`. Every tick arrived. The field was being assigned. The bar on screen sat at 0 the whole time and then jumped to 100 at the very end.

## The wrong guess: it's the progress bar

My first theory was `mat-progress-bar` itself. Maybe `mode="determinate"` with a fast-changing `[value]` needed a kick, or the Material component was debouncing internally, or `event.total` was occasionally undefined and poisoning the binding. I swapped the bar for a plain `<div>` with an inline width:

```html
<div class="bar" [style.width.%]="uploadState.percent"></div>
```

Same behavior. Flat at zero, then full. So it wasn't Material. It was something between "the field changed" and "the DOM changed," which in Angular is exactly one thing.

The dialog component was `OnPush`. Of course it was — almost everything in this app is, because the file manager renders large lists and `Default` change detection on those was a measurable cost. I'd set it months earlier and forgotten.

Here's the part of `OnPush` that's easy to internalize wrong. Under `OnPush`, Angular only re-checks a component's view when one of a short list of things happens: an `@Input()` reference changes, an event fires from within the component's own template, an `async` pipe in that template emits, or a signal read in the template changes. A value arriving on a manual `.subscribe()` callback is **none of those**. The HTTP progress event comes in from outside the template's event system entirely. Angular has no idea anything changed, so it never re-checks the view, so the bar never moves.

The final `100` only showed up because something *else* triggered change detection right around then — the upload completing kicked off a refetch of the file list, and that refetch's `async` pipe emission re-checked the tree and incidentally swept up my stale `uploadState`. The progress wasn't broken. It was invisible until an unrelated event happened to repaint the room.

## The fix: tell Angular yourself

When you mutate component state from outside Angular's change-detection triggers — and a manual subscription is outside — you have to mark the view dirty yourself. `ChangeDetectorRef.markForCheck()` does exactly that: it marks this component and its ancestors as needing a check on the next cycle. It does not run change detection synchronously (that's `detectChanges()`); it just flags the path so the next tick repaints it. For a stream that emits often, that's the right tool — you don't want to force a synchronous re-render on every one of 200 progress events, you want to mark dirty and let Angular batch.

```ts
constructor(private cdr: ChangeDetectorRef) {}

upload(file: File) {
  this.uploadSvc
    .upload(file)
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe((state) => {
      this.uploadState = state;
      this.cdr.markForCheck(); // the line that was missing
    });
}
```

One line. The bar animated immediately, smoothly, 0 to 100, exactly as the service had been reporting all along.

There's a cleaner version of this, and I want to be honest that I reached for the patch before the design. The properly idiomatic fix under `OnPush` is to never manually subscribe at all — expose the stream and let the `async` pipe do the marking for you, because `async` calls `markForCheck()` internally on every emission:

```ts
uploadState$ = this.uploadSvc.upload(file).pipe(
  startWith({ status: 'pending', percent: 0 } as UploadState),
);
```

```html
@if (uploadState$ | async; as state) {
  <mat-progress-bar mode="determinate" [value]="state.percent" />
  <span>{{ state.percent }}%</span>
}
```

That's where this code lives now. But I left the `markForCheck` story in because the manual-subscribe pattern is everywhere in this codebase — websocket handlers, Bull job-status pollers, a couple of imperative places where `async` genuinely doesn't fit — and every one of them is a latent version of this exact bug. `markForCheck()` is the escape hatch for when you can't use `async`. Knowing why you need it is the part that transfers.

## While I was in there: the dialog was the wrong size

The same upload dialog had a second, unrelated annoyance that I fixed in the same pass, because it was right there mocking me. It was hardcoded to 960 pixels wide:

```ts
this.dialog.open(FileUploadDialogComponent, {
  width: '960px',
});
```

`960px` is a number someone typed once because the upload form happened to look fine at that width on their monitor. But this dialog does more than one thing. Uploading a single file, it shows a drop zone and one progress row and acres of empty space to the right. Showing the post-upload summary with a wide metadata table, it was too cramped and scrolled horizontally. One magic width can't serve both, and `960px` served neither well.

The fix was to stop dictating a width and let the content decide, with bounds so it never gets absurd:

```ts
this.dialog.open(FileUploadDialogComponent, {
  width: 'auto',
  maxWidth: '90vw', // Material's default is 80vw; we want a touch more room
  panelClass: 'fit-content-dialog',
});
```

```scss
.fit-content-dialog .mat-mdc-dialog-surface {
  width: fit-content;
  max-width: 90vw;
  min-width: 360px; // below this the drop zone collapses
}
```

`width: 'auto'` on the dialog config plus `width: fit-content` on the surface is what does it — the panel hugs its content instead of stretching to a fixed box. `min-width` keeps the single-file case from collapsing into a sliver, `max-width` keeps the wide summary from running off the screen. One gotcha worth flagging: you have to override `maxWidth` in the config *and* it has to agree with the SCSS, because Material applies its own default `max-width: 80vw` to `.mat-mdc-dialog-surface` and if you only change one, the other wins and you spend ten minutes wondering why your `90vw` does nothing.

## And the breadcrumbs were lying about ancestors

Third small thing, same file manager. The breadcrumb at the top — `Recordings / 2026 / March / agent-4471` — used route fragments to track where you were, and clicking a middle crumb to jump up a level sometimes landed you in the wrong folder. The fragment for each crumb only encoded that crumb's own id, not the path to it:

```ts
// before: each crumb knew its own folder, nothing above it
crumbs = folders.map((f) => ({
  label: f.name,
  fragment: f.id,
}));
```

Clicking `March` navigated to the folder whose id was `March`'s — but the file-tree component resolved a folder by walking down from root using the full ancestor chain, and a bare leaf id with no ancestors couldn't be located unambiguously when folder names repeat (and they do — every agent has a `2026/March`). The fix was to carry the accumulated ancestor path on each crumb, so clicking one navigates with the full chain it needs:

```ts
// after: each crumb carries the path from root down to it
crumbs = folders.map((f, i) => ({
  label: f.name,
  path: folders.slice(0, i + 1).map((a) => a.id), // ancestors + self
}));
```

```ts
goTo(crumb: Crumb) {
  this.router.navigate(['/files'], {
    queryParams: { path: crumb.path.join('/') },
  });
}
```

Now `March`'s crumb carries `[recordings, 2026, March]`, the tree resolves it unambiguously, and middle-crumb clicks land where they read. Tiny diff. It's the difference between a breadcrumb that's a label and a breadcrumb that's a working address.

## What ties these together

None of these is a hard bug. A missing `markForCheck`, a hardcoded width, a fragment that dropped its ancestors. But they're the bugs that make a UI feel dead even when the logic underneath is correct — the upload that works but looks frozen, the dialog that fits one case and fights the rest, the breadcrumb that points to the wrong place. The data layer was fine in all three. The feeling was broken.

The one I'll keep paying attention to is the `OnPush` one, because it's the trap that doesn't announce itself. `OnPush` is the right default for a list-heavy app and I'd set it again tomorrow. But it changes the contract: the moment you mutate component state from anything that isn't an input, a template event, a signal, or an `async` pipe, the view will quietly ignore you. It won't error. It won't warn. It'll just sit at zero and make the user think the thing is broken. Every manual `.subscribe()` in an `OnPush` component is that bet, and the way you lose it is exactly the way I lost it here — the value's right, the console proves it's right, and the screen disagrees. When that happens, don't debug the binding. Ask who's supposed to be telling Angular, and check whether anyone is.
