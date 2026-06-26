---
title: "Infinite scroll for message history"
description: "Loading older messages as you scroll, with an accordion thread list and subscription auth that actually works."
date: "2025-08-14"
updated: "2025-08-14"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "rxjs", "pagination"]
month: "2025-08"
repo: "frontend"
author: "Sachal Chandio"
---

The sales floor wanted a messenger. Not a chat bolt-on, a real one: agents talking to each other and to leads, threads that stay put, and the ability to scroll back through three months of "did the client sign yet" without the browser falling over. That last part is where most naive chat UIs die. You render every message, the DOM bloats to ten thousand nodes, and the tab starts chewing a CPU core just to show a list nobody is reading.

So the brief was small but the constraints were sharp. A conversation list on the left that behaves like an accordion — one thread open at a time. Inside the open thread, the newest messages at the bottom, and older ones paging in as you scroll up. New messages arriving live over a GraphQL subscription. And the scroll position must not jump when history loads above the viewport, because nothing feels more broken than reading a message and having it teleport off-screen because forty older ones just appeared on top of it.

## Why an accordion, not a router

The first instinct was to make each conversation a route. `/messenger/:conversationId`, lazy-load the thread component, done. I built that and threw it out within a day.

The problem is context. An agent scanning their conversations wants to glance between threads — see who replied, who's waiting — without losing where they were. Routing blows away component state on every navigation, so every thread switch meant re-fetching, re-scrolling, re-subscribing. The accordion keeps the list mounted and just swaps which body is expanded. State for the open thread lives in a signal; closing it tears down the subscription, opening another spins one up.

```ts
// messenger-list.component.ts
openConversationId = signal<string | null>(null);

toggle(id: string) {
  this.openConversationId.update(curr => (curr === id ? null : id));
}
```

The template is a plain `@for` over conversations with the body rendered conditionally. Material's `mat-expansion-panel` was tempting but it fought me on the scroll container — it wants to own the animation and the overflow, and I needed the inner scroll to be mine. So it's a hand-rolled accordion. Less magic, fewer surprises.

## Paging older messages

The backend exposes messages with cursor pagination. The cursor is the message's `createdAt` plus its id as a tiebreaker, because two messages can land in the same millisecond and a pure timestamp cursor will silently drop or duplicate one. The query asks for messages *before* a given cursor, newest-first, and the client reverses them for display.

```ts
const MESSAGES = gql`
  query Messages($conversationId: ID!, $before: String, $limit: Int!) {
    messages(conversationId: $conversationId, before: $before, limit: $limit) {
      edges {
        node { id body senderId createdAt }
        cursor
      }
      pageInfo { hasPreviousPage }
    }
  }
`;
```

On the client, I keep the loaded messages in a signal and prepend older pages as they arrive. The trigger is an `IntersectionObserver` on a sentinel element at the top of the scroll list. When the sentinel scrolls into view, fetch the next page using the oldest cursor we currently hold.

```ts
private oldestCursor: string | null = null;
loading = signal(false);
messages = signal<Message[]>([]);

async loadOlder(conversationId: string) {
  if (this.loading() || !this.hasMore) return;
  this.loading.set(true);

  const { data } = await firstValueFrom(
    this.apollo.query<MessagesResult>({
      query: MESSAGES,
      variables: { conversationId, before: this.oldestCursor, limit: 30 },
      fetchPolicy: 'no-cache', // we own the cache; Apollo's would fight the prepend
    }),
  );

  const older = data.messages.edges.map(e => e.node).reverse();
  this.hasMore = data.messages.pageInfo.hasPreviousPage;
  this.oldestCursor = data.messages.edges.at(-1)?.cursor ?? this.oldestCursor;

  this.messages.update(curr => [...older, ...curr]);
  this.loading.set(false);
}
```

I went with `fetchPolicy: 'no-cache'` deliberately. Apollo's normalized cache is great until you're doing manual prepend-on-scroll, at which point its merge policies and your component state are two sources of truth that drift. I tried wiring a `merge` function into the type policy first. It worked, sort of, until live messages from the subscription started landing and the cache and my signal disagreed about ordering. Owning the array myself was less clever and more correct.

## The scroll-jump problem

Here's the part the notes just called "keep scroll position stable" — easy to write, annoying to do right.

When you prepend N messages above the viewport, the browser keeps the scroll *offset* constant, which means everything you were looking at shifts down by the height of the new content. You read a message, history loads, and your message slides off the bottom. Maddening.

The fix is to measure the scroll height before the prepend and after, and add the difference back to `scrollTop`. The trick is *when* to measure. The new DOM isn't laid out the instant you update the signal — you have to wait for Angular to render and the browser to compute layout. My first version read the new height synchronously right after `messages.update()` and got the old height back, so the correction was always zero. Looked like it did nothing because it did nothing.

```ts
private async prependPreservingScroll(
  el: HTMLElement,
  apply: () => void,
) {
  const prevHeight = el.scrollHeight;
  const prevTop = el.scrollTop;

  apply(); // mutate the signal that drives the @for

  // wait for layout to settle before reading the new height
  await new Promise(requestAnimationFrame);

  const delta = el.scrollHeight - prevHeight;
  el.scrollTop = prevTop + delta;
}
```

One `requestAnimationFrame` was enough once the change detection ran first. Where it bit me was zone timing: with `provideExperimentalZonelessChangeDetection` the signal write doesn't synchronously flush the view, so I had to let the microtask queue drain. In practice `await new Promise(requestAnimationFrame)` after the signal update lands after the render in this setup. If you're still on Zone.js, an `afterNextRender` callback is the cleaner hook and I'd reach for that.

There's a CSS lever too that I almost missed. `overflow-anchor` does some of this for you in modern browsers, but it's inconsistent the moment you're also programmatically setting `scrollTop`, so I turned it off on the container (`overflow-anchor: none`) and did the math myself. Two mechanisms fighting over the same scrollTop is a bug generator.

```scss
.thread-scroll {
  overflow-y: auto;
  overflow-anchor: none; // we manage scroll position manually
}
```

## Subscription auth, the actual hard part

Live messages come over a GraphQL subscription on a WebSocket using `graphql-ws`. HTTP requests carry the JWT in an `Authorization` header via an Apollo link, which is trivial. WebSockets don't have request headers in the browser — there's no clean way to set one on the upgrade. So the token has to ride along in the connection init payload, and that's where I lost an afternoon.

The naive version reads the token once when the app boots and hands it to the WS client:

```ts
// don't do this
const wsClient = createClient({
  url: env.wsUrl,
  connectionParams: { authToken: localStorage.getItem('access_token') },
});
```

This works right up until the token expires or the user logs in fresh without a full reload. The connection params were captured once at construction, so a reconnect re-sends a stale token, the server rejects it, and the socket flaps in a retry loop. The fix is that `connectionParams` accepts a function, and `graphql-ws` calls it on every (re)connect.

```ts
const wsClient = createClient({
  url: environment.wsUrl,
  lazy: true, // don't open the socket until a subscription actually runs
  connectionParams: () => {
    const token = this.auth.accessTokenSnapshot();
    return token ? { authToken: `Bearer ${token}` } : {};
  },
  retryAttempts: 5,
  shouldRetry: () => true,
});
```

On the server the `onConnect` hook pulls `authToken` off the payload, verifies it, and stashes the user on the connection context so every subscription resolver can authorize against it. The thing that tripped me up there was that the subscription resolver runs in a different execution context than HTTP guards — the `@nestjs/graphql` request context for WS is the connection, not a per-message request, so my usual `@CurrentUser()` decorator returned undefined until I taught it to read from `context.extra.user` for the WS path.

The split-link routes operations to the right transport: subscriptions over WS, everything else over HTTP.

```ts
const link = split(
  ({ query }) => {
    const def = getMainDefinition(query);
    return def.kind === 'OperationDefinition'
      && def.operation === 'subscription';
  },
  new GraphQLWsLink(wsClient),
  httpLink, // auth header link chained in here
);
```

When a new message arrives on the subscription, it appends to the bottom of the same signal the pager prepends to. Different ends of the same array, which is why owning that array myself paid off. I also dedupe by id, because the optimistic local echo of the sender's own message and the subscription broadcast of it would otherwise show twice — you send "ok", and for half a second there are two "ok"s.

```ts
this.messages.update(curr =>
  curr.some(m => m.id === incoming.id) ? curr : [...curr, incoming],
);
```

## What I'd do differently

The `IntersectionObserver` sentinel is the right call and I'd keep it — it's cheaper and steadier than listening to scroll events and checking `scrollTop < threshold` on every frame, which was my first pass and which fired hundreds of times a second. Throttling scroll events with RxJS works but you're still paying for the listener. The observer just tells you when the top is near.

What I'd change is virtualization. Right now I cap the rendered window at a few hundred messages and trim the far end as you scroll, which is fine, but a CDK virtual scroll viewport would let me hold the whole loaded history without DOM weight. I skipped it because virtual scroll plus prepend-preserving-scroll plus a live-appending tail is three timing-sensitive things interacting, and I wanted one of them solved cleanly before stacking the next. Shipping the simpler version taught me where the real edges were. The accordion and the cursor pagination I'd build the same way again; the scroll-anchoring I'd write with `afterNextRender` from the start instead of discovering `requestAnimationFrame` timing the hard way.

The bit that still makes me a little nervous is reconnect storms — if the RDS-backed gateway hiccups and a few hundred agents' sockets all retry at once with the same backoff, they retry in lockstep. I added jitter to `retryWait` after watching exactly that happen on a deploy. Stable scroll was the visible problem. The invisible one was the socket.
