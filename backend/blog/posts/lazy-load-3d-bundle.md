---
title: "Lazy-loading the 3D libraries to keep the initial bundle light"
description: "Heavy visualization code that most users never reach shouldn't sit in the critical bundle."
date: "2026-03-04"
updated: "2026-03-04"
kind: "deepdive"
category: "Performance"
tags: ["angular", "bundle", "lazy-loading"]
month: "2026-03"
repo: "frontend"
author: "Sachal Chandio"
---

The login screen was taking too long to become interactive on the laptops our agents actually use — mid-range Windows machines on call-center wifi, not my dev box. Time-to-interactive, not first paint. The page would show up fine and then sit there, unresponsive, while the main thread chewed through a bundle that had quietly grown past 2 MB of JavaScript before gzip. Agents log in, go to the dialer, work leads. Most of them, on most days, never touch the part of the app that needed all that weight.

So I went looking for what was in the bundle before I touched anything, because the one rule I've learned the hard way about bundle work is that your intuition about what's big is almost always wrong.

## Look first, cut second

Angular's CLI gives you the size of each chunk on every build, but the summary table lies by omission — it tells you `main.js` is 2.1 MB and says nothing about *why*. For the why, you need the stats JSON and a treemap.

```bash
ng build --configuration production --stats-json
npx webpack-bundle-analyzer dist/telelinkz/stats.json
```

That opens a treemap in the browser where every module is a rectangle sized by its byte contribution. The first time I ran it I expected the usual suspects — Material, Apollo, RxJS, the moment-shaped date library everyone forgets to remove. Those were all there and all reasonable. The thing that made me actually stop was a single fat block in the corner, bigger than Material, that traced back to `three`. Three.js. The WebGL renderer.

We don't render a 3D scene on the login page. We render one in exactly one place: a "galaxy graph" view in the file manager, a force-directed 3D graph of files and their relationships that you can spin around. It's genuinely nice and almost nobody opens it. It pulls in `3d-force-graph`, which pulls in the entire `three` runtime, plus `three-spritetext` for the text labels floating next to each node. Together those were the largest single thing on a screen that never showed them.

The treemap is the whole reason this post isn't "I guessed and got lucky." If I'd trimmed based on a hunch I'd have spent the afternoon shaving 30 KB off a date utility and never noticed the 600 KB of WebGL riding along for free.

## How it was wired, and why that's the bug

The galaxy graph lived in a `file-manager` module, and that module was *already* lazy-loaded behind its route:

```ts
{
  path: 'files',
  loadChildren: () =>
    import('./modules/file-manager/file-manager.module').then(
      (m) => m.FileManagerModule,
    ),
}
```

So you'd think Three.js was already deferred. It wasn't, and the reason is the subtle part. Lazy-loading a route only defers code that is *reachable solely through that route's import graph*. The galaxy component imported `three` at the top of the file:

```ts
import ForceGraph3D from '3d-force-graph';
import SpriteText from 'three-spritetext';
```

A static `import` at module scope is a hard dependency. The bundler has to decide which chunk it belongs to, and it does that by looking at everything that references it. The problem was that `three`'s footprint was big enough, and the way it was referenced shared enough with eagerly-loaded code paths, that Webpack hoisted it toward common ground rather than leaving it stranded in the file-manager chunk. The net effect: opening the app downloaded the 3D runtime whether or not you ever visited `/files`, let alone the galaxy view inside it.

That's the trap with lazy routes. People treat "it's behind a `loadChildren`" as a guarantee, and it isn't. It's a hint the bundler is free to override based on how modules actually reference each other. The only way to know is to build and look at the chunk the module lands in.

## The approaches I weighed

I had three options and I'll be honest about why I rejected two of them.

**Drop the feature.** The galaxy graph is used by a handful of managers a handful of times a week. Cutting it would've solved the bundle problem cleanly and I considered it for about ten minutes. But it works, people who use it like it, and "delete the thing instead of loading it correctly" is the kind of decision that's hard to walk back. No.

**Swap the library for something lighter.** There are smaller force-graph implementations, some 2D-only. But the 3D-ness is the point of this view — it's the one place in a fairly utilitarian CRM that's allowed to be a little fun — and re-implementing it against a different API to save bytes on a screen most people don't open is effort spent in exactly the wrong place. Also no.

**Defer the load to the moment the view actually renders.** This is the right answer and it's barely any code. Angular already splits the *route* chunk. What I needed was to push `three` and its friends out of even that chunk, so they download only when someone opens the galaxy view — not when they open the file manager, and certainly not when they log in.

## The fix: dynamic import inside the component

You move the static imports out of module scope and into a runtime `import()` that fires from the component's lifecycle. A dynamic `import()` is a code-split point the bundler respects unconditionally — it has no choice, because the import is a promise resolved at runtime, so the module *must* live in its own chunk.

Before, the libraries were top-of-file constants:

```ts
import ForceGraph3D from '3d-force-graph';
import SpriteText from 'three-spritetext';

@Component({ /* ... */ })
export class GalaxyGraphComponent implements AfterViewInit {
  ngAfterViewInit() {
    this.graph = ForceGraph3D()(this.container.nativeElement);
    // ...
  }
}
```

After, they're loaded on demand, and the types are just `any` because we never touch them until the chunk arrives:

```ts
type ForceGraph3DInstance = any;

@Component({ /* ... */ })
export class GalaxyGraphComponent implements AfterViewInit, OnDestroy {
  private graph: ForceGraph3DInstance | null = null;
  private ForceGraph3D: any = null;
  private SpriteText: any = null;

  private async loadGraphLibraries(): Promise<void> {
    const [fg3d, spriteText] = await Promise.all([
      import('3d-force-graph'),
      import('three-spritetext'),
    ]);
    this.ForceGraph3D = fg3d.default;
    this.SpriteText = spriteText.default;
  }
}
```

`Promise.all` so the two requests go out together instead of waterfalling. Note the `.default` — both ship as ESM default exports, and a dynamic `import()` hands you the namespace object, not the default, so you have to reach into `.default` yourself. I got a `ForceGraph3D is not a function` on the first try because I forgot that and called the namespace object. Easy to miss, since the static-import form unwraps `default` for you and you never think about it.

Then `ngAfterViewInit` awaits the load before it builds anything:

```ts
async ngAfterViewInit(): Promise<void> {
  await this.loadGraphLibraries();
  this.initGraph();
}

private initGraph(): void {
  this.graph = (this.ForceGraph3D as any)()(this.graphContainer.nativeElement);
  // node labels use the sprite text lib we just loaded
  this.graph.nodeThreeObject((node: any) => new this.SpriteText(node.name));
}
```

And `SpriteText` gets called through `this.`, because it no longer exists as a top-level binding — it's a field that's null until the chunk lands. That's the one ergonomic tax: everything from a deferred library has to go through an instance property, and you lose the compile-time types. For a leaf component that only renders one specific thing, that's a fine trade. I would not do this to a library used in fifteen places.

## What it bought, and what it cost

After the change, the production build split `three` and `three-spritetext` into their own lazy chunk, and the main bundle dropped by a little over 600 KB raw — call it ~180 KB off the gzipped critical path. Time-to-interactive on the login screen came down by roughly a second on the call-center laptops, which is the only measurement I cared about. Nobody who doesn't open the galaxy graph pays for it anymore.

The cost is a visible pause the first time you *do* open the galaxy view. You click in, and there's a beat — a few hundred milliseconds to a second on bad wifi — before the graph appears, because that's the WebGL runtime arriving over the network. I added a small "Loading visualization…" state so it doesn't look frozen, and after the first load it's cached and instant. I'm comfortable moving the cost onto the few people who use the feature and off the thousands of logins that don't, but it is a real cost and you should know it's there before you ship it. Lazy-loading doesn't make work disappear. It moves the work to the person who asked for it.

The part I'd underline if you take one thing from this: run the analyzer *before* you start, and run it again after. Both times. The "after" run is how I confirmed `three` actually left the main chunk instead of getting re-hoisted somewhere I wasn't looking — which, given how it got into the main bundle in the first place, was not a thing I was willing to take on faith.
