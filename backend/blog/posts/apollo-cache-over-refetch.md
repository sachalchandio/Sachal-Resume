---
title: "Drop refetchQueries: trust the Apollo cache"
description: "awaitRefetchQueries after every mutation meant a redundant network round-trip for data you already had."
date: "2025-05-25"
updated: "2025-05-25"
kind: "deepdive"
category: "Performance"
tags: ["apollo", "graphql", "caching", "angular"]
month: "2025-05"
repo: "frontend"
author: "Sachal Chandio"
---

Click "Approve" on a penalty, and the button sat spinning for the better part of a second. On a good connection. The penalty itself was approved server-side in maybe 40ms — the mutation was fast. What was slow was everything I made the client do *after* the mutation came back: throw away the whole penalty list and ask the server to send it all again, then wait on that before letting the user move.

That's `refetchQueries` with `awaitRefetchQueries: true`. I'd written it without thinking, because it's the path of least resistance and it's correct in the boring sense — the list always reflects the server. It's just wasteful in a way you don't notice until a QA lead is approving thirty penalties in a row and each one stalls.

## What I had

The penalty review screen is a paginated table of `PenaltyRequest` rows — agent, sale, level, who filed it, status. An admin approves or rejects each one. The approve mutation looked like this:

```ts
approvePenalty(id: string) {
  return this.apollo.mutate({
    mutation: APPROVE_PENALTY,
    variables: { id },
    refetchQueries: [{ query: GET_PENDING_PENALTIES, variables: this.queryVars }],
    awaitRefetchQueries: true,
  });
}
```

`APPROVE_PENALTY` returns the single updated penalty. Then `refetchQueries` fires `GET_PENDING_PENALTIES` again — the entire current page — and `awaitRefetchQueries: true` means the mutation's promise doesn't resolve until that second query lands. So the component's loading state, which I tied to the mutation promise, stayed up for the duration of *two* round-trips, not one.

Two things bugged me about that. The obvious one is the latency: a 40ms write padded out to 600–900ms because the client insisted on re-downloading a list it had just modified by exactly one row. The subtler one is that the refetch is pure redundancy. I already knew what changed. The mutation told me — it returned the approved penalty with its new `approvalStatus`. Apollo had that object in hand. I was ignoring it and asking the server to recompute and re-serialize the whole page to learn one field flipped from `PENDING` to `APPROVED`.

## The thing I reached for first that was worse

My first instinct wasn't even the cache. It was to drop `awaitRefetchQueries` to `false` and let the refetch happen in the background — optimistically flip the row in local component state, fire the mutation, let the refetch reconcile whenever it finished. Snappy UI, eventual consistency.

I'm glad I didn't ship that. Optimistic *component* state is a trap in a list that's also a cache. Now I've got the truth in two places: a `signal` in the component holding my hand-flipped row, and the Apollo cache holding the pre-mutation version, with a refetch in flight that's going to overwrite my optimistic edit at some unpredictable moment. If the user sorts or paginates between the optimistic update and the refetch landing, the two disagree and the row flickers back to `PENDING` for a beat. I'd have traded a slow-but-correct UI for a fast-but-occasionally-lying one, and lying-UI bugs are the ones that eat an afternoon because you can't reproduce them on demand.

The actual fix is smaller and it leans on the one thing Apollo is genuinely good at: it's a normalized cache, and if you let it, it'll do the bookkeeping for you.

## Update the cache instead

Apollo stores entities by a cache ID — typically `__typename` plus `id`. When `GET_PENDING_PENALTIES` runs, each `PenaltyRequest` in the list gets normalized into its own cache entry, and the query result is really a list of references to those entries. The implication that took me too long to internalize: if a mutation returns the same entity with the same `id` and `__typename`, **Apollo merges it automatically**. Any query referencing that entity re-renders with the new field. No refetch, no manual work.

So for the status flip specifically, I almost don't have to do anything — I just have to ask for the changed fields in the mutation's selection set:

```ts
const APPROVE_PENALTY = gql`
  mutation ApprovePenalty($id: ID!) {
    approvePenalty(id: $id) {
      id
      approvalStatus   # the field that changed — return it so Apollo merges it
      approvedAt
      approvedBy { id name }
    }
  }
`;
```

That alone kills the "status badge doesn't update" problem with zero cache code, because the approved row stays in the list, just with a new badge.

The wrinkle: approving a penalty should *remove* it from the **pending** list. It's not pending anymore. A merged entity update can't do that — the row's still referenced by the `GET_PENDING_PENALTIES` result; only its fields changed. Removing it from a specific list is a list-shape change, and that's the one case where you reach into the cache by hand with `update`:

```ts
approvePenalty(id: string) {
  return this.apollo.mutate({
    mutation: APPROVE_PENALTY,
    variables: { id },
    update: (cache, { data }) => {
      const approved = data?.approvePenalty;
      if (!approved) return;

      cache.updateQuery(
        { query: GET_PENDING_PENALTIES, variables: this.queryVars },
        (existing) => {
          if (!existing) return existing;
          return {
            ...existing,
            pendingPenalties: {
              ...existing.pendingPenalties,
              items: existing.pendingPenalties.items.filter(
                (p) => p.id !== approved.id,
              ),
              totalCount: existing.pendingPenalties.totalCount - 1,
            },
          };
        },
      );
    },
  });
}
```

No `refetchQueries`. No `awaitRefetchQueries`. The mutation resolves after one round-trip, the `update` callback runs synchronously against the in-memory cache the instant the response arrives, and the row is gone from the pending list before the next frame paints. The button stopped spinning. Measured end to end, the approve interaction went from that 600–900ms stall to feeling instant — the only latency left is the actual write.

A couple of things I got wrong on the first pass and want to save you:

- **Decrement `totalCount` yourself.** I filtered the `items` array and forgot the count, so the pagination footer said "23 pending" while showing 22 rows. The cache is exactly as smart as you make it; it won't infer that removing an item should change a sibling count field.
- **`variables` has to match the cached query exactly.** `updateQuery` keys on the query *and* its variables. My `this.queryVars` carried the sort and page, and the first time I passed a subtly different object — a different sort default — it silently updated nothing, because that query wasn't in the cache under those variables. No error. The list just didn't change. If a hand update appears to do nothing, check the variables before you touch anything else.

## When the refetch is the right call after all

I want to be careful here, because "always update the cache" is its own kind of cargo-culting, and a manual `update` is more code that can drift from reality. Reaching into the cache means *you* are now responsible for keeping the client's view consistent with what the server would have returned. For a single-field flip and a one-row removal, that responsibility is trivial and the win is real. It stops being trivial fast.

Refetch — and I mean it — when the mutation has effects you can't see from the client. Approving one penalty in our system is contained: one row, one status, one count. But some mutations cascade. If approving a penalty also recomputed an agent's monthly commission total shown in a *different* widget, or shifted the sale's position in a server-side ranking, or the list is ordered by a field the server computes and your edit changes that ordering — now reproducing the server's result on the client means reimplementing the server's logic in the `update` callback. That's a duplication bug factory. Refetch. Pay the round-trip and stay correct.

The rule I settled on, roughly:

- **Field changed on an entity that stays put?** Do nothing but return the field in the mutation. Apollo's normalization handles it.
- **Item added to or removed from a known list, server ordering unaffected?** A hand `update` with `updateQuery` is worth it. Cheap, fast, and the logic is obvious enough to verify by reading it.
- **Server-side recomputation you can't cheaply mirror — derived totals, re-ranking, fan-out to other queries?** Refetch. The redundant round-trip is the price of not lying, and correctness beats latency every time it's actually in tension.

And don't use `awaitRefetchQueries: true` reflexively even when you do refetch. That flag exists for the case where the user must not act until the fresh data is on screen — but most of the time a background refetch is fine and you shouldn't block the UI on it. The version of me that wrote the original code blocked on *both* the mutation and the refetch out of pure habit, which is the worst of all worlds: correct, redundant, and slow.

The lesson that stuck isn't "refetch is bad." It's that Apollo already holds the answer to most post-mutation updates, and the reflex to re-download the world is the client distrusting a cache it paid to maintain. Return the fields you changed, let normalization do its job, and reach for the manual update only when the shape of a list changes. Save the refetch for when the server knows something you can't cheaply recompute — and then it's not waste, it's the right tool.
