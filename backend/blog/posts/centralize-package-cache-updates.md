---
title: "One source of truth for Apollo cache updates"
description: "Scattered, any-typed cache writes bred subtle bugs. Centralizing them behind typed helpers."
date: "2025-06-27"
updated: "2025-06-27"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "apollo", "state", "rxjs"]
month: "2025-06"
repo: "frontend"
author: "Sachal Chandio"
---

A sales manager edits the commission on a MetroNet package, sees the success toast, and the package list still shows the old number. Refresh and it's correct. That bug report sat in my queue for a week because I couldn't reproduce it on demand, and when I finally could, the cause was embarrassing: two different places in the commission-management feature were both trying to keep the Apollo cache honest, and they disagreed about what the truth was.

This is the cleanup. Nothing glamorous — just pulling cache mutation into one place and putting types around it so the compiler catches the disagreements instead of a manager in production.

## Where the writes lived

The `currentPackagesByProvider` query backs a list on the left, and selecting a row opens an edit form. When you save, an `updatePackage` mutation goes out. The list has to reflect the new commission immediately — the manager just changed it, they expect to see it.

So I had two mechanisms fighting over that.

The component did its own mapping. After a mutation resolved, it took the raw GraphQL response, reshaped it into the UI's `ServicePackage` interface by hand, and patched its local signal. The service, separately, had an `update` callback on the mutation that wrote back into the normalized cache inline — reading the query, finding the matching package, splicing in the new fields, writing it back. Loose `any` casts everywhere because the generated query type and the mutation type don't line up field-for-field, and casting was faster than reconciling them.

The two paths produced subtly different objects. The component's hand-map dropped `versions` it didn't think it needed; the inline cache write kept them but mangled `rguCount` on the current version. Whichever one the UI happened to read from last is what you saw. The "stale commission" report was the cache write winning a race it shouldn't have been in.

## The constraint that shaped the fix

I didn't want a state-management library for this. No NgRx, no Apollo reactive vars layered on top. The feature is one query and a handful of mutations; reaching for a store would be more machinery than the problem deserves. The cache *is* the store. I just needed exactly one writer to it, and that writer needed to be typed against the real generated documents so it couldn't silently drift from the query shape again.

Second constraint: the displayed list and the edit form had to stay consistent after a save without a visible reload flash. So the cache update still had to happen optimistically-ish — write the merged package back so the list updates the instant the mutation returns, before any refetch.

## What I rejected

The lazy fix was to slap `refetchQueries: ['CurrentPackagesByProvider']` on every mutation and delete all the manual writing. It works. It's also a round trip on every commission edit, and it flickers the list while the refetch is in flight. For a tool people use all day to bulk-adjust commissions, that flicker adds up. I wanted the cache write to stay, just done once and done right.

The other option was to make the component the single owner — let it map and patch its signal, and stop touching the cache at all. But then any *other* component reading `currentPackagesByProvider` from the cache would see stale data, and the package-history dialog does exactly that. The cache had to be the source of truth, not a component's signal.

## The shape I landed on

One private method, `updateProviderPackagesCache`, is the only thing in the codebase that writes the provider package list. The mutation `update` callbacks call it and nothing else:

```ts
return this.apollo
  .mutate<UpdateCommissionMutation>({
    mutation: UpdateCommissionDocument,
    variables: { input },
    update: (cache, { data }) => {
      if (data?.updatePackage) {
        this.updateProviderPackagesCache(cache, input, data.updatePackage);
      }
    },
  })
```

The method reads the cached query, maps over the list, and replaces only the matching package with a merged version:

```ts
private updateProviderPackagesCache(
  cache: ApolloCache,
  input: UpdatePackageInput,
  updatedPackage: UpdateCommissionMutation['updatePackage'],
): void {
  const providerCode =
    input.providerCode ??
    updatedPackage.providerCode ??
    this.extractProviderFromPackageCode(input.packageCode);

  if (!providerCode) return;

  const cacheKey = {
    query: CurrentPackagesByProviderDocument,
    variables: { providerCode },
  };

  const existingData =
    cache.readQuery(cacheKey) as CurrentPackagesByProviderQuery | null;

  if (!existingData?.currentPackagesByProvider?.length) return;

  const updatedPackages = existingData.currentPackagesByProvider.map((pkg) =>
    this.isMatchingPackage(pkg, input, updatedPackage)
      ? this.mergeCachedPackage(pkg, input, updatedPackage)
      : pkg,
  );

  cache.writeQuery({
    ...cacheKey,
    data: { currentPackagesByProvider: updatedPackages },
  });
}
```

The interesting part is the merge, because this is where the old inline code went wrong. The mutation response and the cached query node are different generated types with overlapping but not identical fields. A naive `{ ...existing, ...updated }` clobbers fields the response doesn't carry — that was the bug. So `mergeCachedPackage` is explicit about which input fields were actually present. `UpdatePackageInput` is a partial; a missing key means "don't touch", and `undefined` for a present key means "clear it". `Object.prototype.hasOwnProperty` is the only way to tell those apart:

```ts
private mergeCachedPackage(existing, input, updatedPackage) {
  const hasDisplayName = this.hasInputField(input, 'displayName');
  const hasSpeedMbps = this.hasInputField(input, 'speedMbps');
  // ...one per editable field

  return {
    ...existing,
    ...updatedPackage,
    displayName: hasDisplayName
      ? (input.displayName ?? existing.displayName)
      : existing.displayName,
    speedMbps: hasSpeedMbps
      ? (input.speedMbps ?? null)
      : existing.speedMbps,
    // ...
    versions: this.mergeCachedVersions(
      existing.versions,
      updatedPackage.versions,
      input,
    ),
  };
}

private hasInputField(
  input: UpdatePackageInput,
  fieldName: keyof UpdatePackageInput,
): boolean {
  return Object.prototype.hasOwnProperty.call(input, fieldName);
}
```

Versions get their own merge because they're a list keyed by version number, and the old code rebuilt them wholesale. `mergeCachedVersions` walks the updated versions, finds the existing one by `version`, merges field-by-field, and the `rguCount` quirk — the one the inline write mangled — finally has a single deliberate rule: only take the new RGU count when this is the current version *and* the input actually carried a `newRguCount`. Otherwise keep what was there.

```ts
const shouldUseUpdatedRguCount =
  updatedVersion.isCurrent && this.hasInputField(input, 'newRguCount');

return {
  ...(existingVersion ?? {}),
  ...updatedVersion,
  rguCount: shouldUseUpdatedRguCount
    ? (input.newRguCount ?? existingVersion?.rguCount ?? 0)
    : (updatedVersionWithRgu.rguCount ?? existingVersion?.rguCount ?? 0),
};
```

Versions in the response get merged; versions only in the cache get carried forward untouched and concatenated. No version silently vanishes from history because the mutation didn't echo it back.

## Killing the hand-map in the component

The second half was deleting the component's reshaping. The service now returns typed `ServicePackage[]` and `ServicePackage` from every method — no `any` crossing the boundary. The mapping that used to live in the component moved into one private `mapDetailedPackageToServicePackage` in the service, so there's exactly one definition of how a GraphQL package becomes a UI package.

The component got dumber, which is the goal:

```ts
this.commissionService
  .getCurrentPackagesByProvider(providerCode)
  .subscribe({
    next: (packages) => {
      this.packages.set(packages);
      // re-resolve the selected row against the fresh list, that's it
    },
  });
```

It sets a signal. It doesn't know the response shape, doesn't cast, doesn't reshape. If the GraphQL schema changes a field, the break surfaces inside the service against the generated type, not three layers deep in a template binding.

## The one place I chose the network over the cache

Here's the tradeoff I'm least sure about, and the one most likely to bite someone reading this. `getCurrentPackagesByProvider` fetches `network-only`:

```ts
return this.currentPackagesByProviderGQL
  .fetch({
    variables: { providerCode },
    fetchPolicy: 'network-only',
  })
```

Same for `getPackageByCode` and `getPackageById`. After all that work to keep the cache correct, the *list load* deliberately skips it and hits the server.

The reasoning: commissions are money, and this data is edited by multiple managers concurrently. The cache write keeps *your own* edit instant within your session — that's what the merge is for, and it still does its job because the `update` callback runs regardless of fetch policy. But when you re-open a provider's packages, I'd rather pay a round trip than show you a number another manager changed two minutes ago that your cache doesn't know about. Correctness over a few hundred milliseconds.

The honest cost: `network-only` means every provider switch is a request, and if the network blips, you get an error toast instead of stale-but-present data. For a list where speed mattered more than freshness — a read-mostly catalog, say — I'd use `cache-and-network` and let the cached copy paint first. I didn't here, on purpose, but if commission edits ever get rarer than provider browsing, that's the first knob I'd turn back.

So the cache is now a single-writer store that's correct for your own session, and the read path opts out of it exactly where the staleness window is unacceptable. Two decisions that look contradictory until you say the quiet part: optimistic writes are for *your* changes, and they were never going to save you from *someone else's*.

The lesson I keep relearning: duplicated state isn't a bug you fix once, it's a shape you have to design out. Two writers will always eventually disagree, and they'll do it in production, on the one field that's denominated in dollars.
