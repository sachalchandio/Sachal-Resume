---
title: "Five years of leaked resize listeners"
description: "window.addEventListener with no matching remove, stacking on every navigation. Finding the pattern and fixing it everywhere."
date: "2025-09-17"
updated: "2025-09-17"
kind: "deepdive"
category: "Performance"
tags: ["angular", "memory", "dom", "echarts"]
month: "2025-09"
repo: "frontend"
author: "Sachal Chandio"
---

The dashboard got slower the longer you used it. Not slow on load — slow after a while. An agent would open the sales dashboard, click into a deal, come back, open the team report, come back, and somewhere in there the charts started lagging. Resizing the window, which should be instant, would hang for half a second and then snap. By the end of a shift the whole thing felt like it was wading through mud.

The annoying part is that a hard refresh fixed it. Every time. That's the tell for a leak, but I didn't see it as a leak at first. I assumed the charts were just heavy.

## The wrong guess

My first theory was that ECharts was doing too much work. We render a fair number of charts — sales-over-time, conversion funnels, agent leaderboards — and some of them have a few thousand points. So I went looking for the obvious wins. Throttle the resize handler, maybe drop the animation on redraw, set `large: true` on the series.

I added a `console.log` to the resize handler in the sales-trend component to see how often it fired, expecting to confirm that a single drag of the window edge was triggering a flood of redraws.

It was worse than that.

```text
[sales-trend] resize fired
[sales-trend] resize fired
[sales-trend] resize fired
[sales-trend] resize fired
[sales-trend] resize fired
... (47 of these)
```

Forty-seven. From one component. One resize event. The component was only on screen once. There was no way a single mounted component should be reacting to the same event forty-seven times.

That's when it clicked: it wasn't the chart doing too much work per resize. It was the same handler registered forty-seven times, because I had navigated into and out of that view forty-seven-ish times during the session, and every visit added a listener that never went away.

## The root cause

Here's what the component looked like. This pattern was copy-pasted across the dashboard, which is the only reason a one-component bug became a five-component bug.

```ts
@Component({ /* ... */ })
export class SalesTrendComponent implements OnInit {
  private chart!: echarts.ECharts;

  ngOnInit(): void {
    this.chart = echarts.init(this.chartEl.nativeElement);
    this.chart.setOption(this.buildOption());

    window.addEventListener('resize', () => {
      this.chart.resize();
    });
  }
}
```

Read it slowly and the bug is right there. `addEventListener` with an inline arrow function, no `ngOnDestroy`, no `removeEventListener`. Angular destroys the component instance when you navigate away — but the browser doesn't know or care about Angular's component lifecycle. The listener is registered on the global `window` object. As far as the DOM is concerned, that closure is live forever, and it's holding a reference to a component (and its ECharts instance) that Angular has otherwise thrown away.

So every visit to the dashboard did two bad things at once.

It leaked the listener. The arrow function keeps `this` alive through the closure, so the old component instance can't be garbage collected. Visit the page ten times, you have ten dead component instances pinned in memory, each with its own ECharts instance and its own data.

And it leaked the work. On the next resize, all ten zombie handlers fire. Nine of them call `.resize()` on charts attached to DOM nodes that aren't even on the page anymore. The tenth is the real one. ECharts doesn't complain — it just does the layout math and the canvas work for all of them. That's where the half-second hang came from. It scaled linearly with how long you'd been using the app.

This code had been in the repo since the first version of the dashboard. Nobody noticed because nobody keeps a single tab open for hours, except, of course, the agents who use it all day. They noticed. They just described it as "the dashboard gets tired."

## The fix

The fix is not clever. You have to be able to remove the exact same function reference you added, which means you cannot pass an inline arrow function — `removeEventListener` matches by identity, and a fresh arrow on the way out is a different object than the one you added. So I store the bound reference as an instance property and use it in both places.

```ts
@Component({ /* ... */ })
export class SalesTrendComponent implements OnInit, OnDestroy {
  private chart?: echarts.ECharts;

  // Same reference for add and remove. This is the whole trick.
  private readonly onResize = (): void => {
    this.chart?.resize();
  };

  ngOnInit(): void {
    this.chart = echarts.init(this.chartEl.nativeElement);
    this.chart.setOption(this.buildOption());
    window.addEventListener('resize', this.onResize);
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.chart?.dispose();
    this.chart = undefined;
  }
}
```

Two things changed and both matter.

`removeEventListener('resize', this.onResize)` works because `this.onResize` is the same object on the way out as it was on the way in. The class-property arrow is created once per instance and bound to `this` automatically, so I get the right `this` inside the handler without a manual `.bind()` call, and I get a stable reference to hand to both add and remove. If you write `this.onResize.bind(this)` in `ngOnInit`, you've recreated the original bug — `.bind()` returns a new function every time, so the one you add and the one you remove are different objects and nothing gets removed.

`this.chart?.dispose()` is the part it's easy to forget. Removing the listener stops new work from piling up, but ECharts holds onto its own canvas, its internal event handlers, and a chunk of memory for the chart instance. If you don't call `dispose()`, you've fixed the listener leak and kept a smaller chart leak. Calling it releases the canvas and lets the whole instance get collected once Angular drops the component.

I applied this same shape to five components: the sales trend chart, the conversion funnel, the agent leaderboard, the team-performance widget, and a small sparkline that lived in the header. Same disease, same cure, copy-pasted as faithfully as the bug originally was.

After the change I reran my crude test — navigate in and out a dozen times, then resize.

```text
[sales-trend] resize fired
```

One line. The way it should have been the whole time.

## What I'd do differently

Storing a bound reference and pairing add/remove is the correct mechanical fix, but it's also the kind of discipline a codebase can't rely on humans to remember every single time. The proof is that it was forgotten five times in a row. So if I were starting fresh I'd stop touching `window.addEventListener` by hand at all.

Angular's `Renderer2.listen` returns a teardown function, and `DestroyRef` lets you register cleanup without implementing `OnDestroy`. That combination makes the leak much harder to write, because the thing that creates the listener also hands you the thing that removes it, in the same expression:

```ts
import { DestroyRef, inject } from '@angular/core';

private readonly destroyRef = inject(DestroyRef);

ngOnInit(): void {
  this.chart = echarts.init(this.chartEl.nativeElement);
  const unlisten = this.renderer.listen('window', 'resize', () => this.chart?.resize());
  this.destroyRef.onDestroy(() => {
    unlisten();
    this.chart?.dispose();
  });
}
```

You can't forget the remove here without also deleting the add — they're written together. That's the property I actually want. The manual version is fine; it's just fragile in exactly the way that let this sit in production for years.

## When this bites

Global event targets are the trap. `window`, `document`, and `MediaQueryList` outlive your components, so any listener you attach to them is your responsibility to clean up, every time, no exceptions. A listener on an element inside the component's own template is mostly self-cleaning — when Angular tears down the view, those nodes and their listeners go with it. A listener on `window` does not, because `window` isn't part of any view.

The symptom is specific enough to recognize next time: an app that's fine on a fresh load and degrades the longer a single session stays open, where a hard refresh resets it completely. That shape almost always means something is accumulating across navigations and never getting released — leaked listeners, leaked subscriptions, leaked intervals, undisposed third-party instances. Resize was just the one that announced itself by firing forty-seven times into my console.

The cheapest way to catch it is the one I stumbled into by accident: put a log in the handler, navigate away and back a few times, and trigger the event once. If the handler fires more than once, you already have your answer, and you didn't even need to open the heap profiler.
