---
title: "Versioning packages: only write a new version when something actually changed"
description: "Naive ‘always insert a version’ produced no-op history. Diffing fields and building human-readable change notes."
date: "2025-06-17"
updated: "2025-06-17"
kind: "deepdive"
category: "Backend"
tags: ["typeorm", "versioning", "audit"]
month: "2025-06"
repo: "backend"
author: "Sachal Chandio"
---

A package in Telelinkz is never edited in place. When an admin changes a commission rate, we close the current version and open a new one, so a sale recorded last March still resolves to the commission that was in effect in March, not whatever the rate is today. The mechanism is a `package_version` table with `validFrom` / `validTo` and an `isCurrent` flag, and it's the right design for this — point-in-time pricing is exactly the problem temporal versioning solves.

The bug was that it versioned too eagerly. Someone would open the package editor, tweak the display name, save — no change to commission, no change to RGU count — and we'd cut a brand new version anyway. The history dialog showed "Version 7," "Version 8," "Version 9," three rows apart in time, all carrying identical numbers. Nothing had changed. We'd just stamped the audit trail with three no-ops.

That's worse than useless. The whole point of versioning is that a row in the history *means* something happened. When half the rows mean nothing, you can't trust any of them, and the timeline the frontend builds out of `changeNotes` becomes a list of "version added" with no story.

## Why it happened

The update path was the naive one. It took the incoming `UpdatePackageInput`, closed the current version, and inserted a new one with the new values. Roughly:

```ts
async updatePackage(code: string, input: UpdatePackageInput) {
  const pkg = await this.packageRepo.findOneOrFail({
    where: { packageCode: code },
    relations: { versions: true },
  });

  const current = pkg.versions.find((v) => v.isCurrent);

  // close current, open new — always
  current.isCurrent = false;
  current.validTo = new Date();

  const next = this.versionRepo.create({
    package: pkg,
    version: current.version + 1,
    commission: input.commission,
    rguCount: input.rguCount,
    features: input.features,
    isCurrent: true,
    validFrom: new Date(),
  });

  await this.versionRepo.save([current, next]);
  return pkg;
}
```

Read it and the problem is obvious in hindsight: it never asks whether the new values are any different from the old ones. The editor sends the full package object on every save, including all the version fields, so even a save that only touched the package's `displayName` (which lives on `package`, not `package_version`) arrived here carrying `commission`, `rguCount` and `features` — identical to what was already current — and we dutifully versioned them.

## The fix is a diff, but the diff is the fiddly part

The shape of the fix is simple to state: compare the incoming versioned fields against the current version, and only cut a new version if at least one of them actually changed. If nothing changed, don't.

The fiddly part is what "changed" means, because the values don't compare cleanly with `===`.

`commission` is a `decimal(10,2)` in MySQL. TypeORM hands decimals back as **strings** — `"45.00"` — to avoid float precision loss. The input from GraphQL is a number, `45`. So `current.commission === input.commission` is `"45.00" === 45`, which is `false` every single time, even when the value is the same. That alone would have made a naive diff version on every save, which is the bug I started with wearing a different hat.

`rguCount` is an integer but came through with the same string-vs-number ambiguity depending on the path. And `features` is a `json` column holding a string array — `["unlimited", "5G", "hotspot"]` — and two arrays are never `===` to each other even when they hold the same items in the same order.

So I needed two small helpers before I could diff anything honestly.

```ts
// decimals come back from MySQL as strings; the input is a number.
// compare them as numbers, but tolerate the float fuzz that buys us.
function numEq(a: unknown, b: unknown): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return a === b;
  return Math.abs(na - nb) < 1e-9;
}

// order-sensitive array equality. for features the order is meaningful
// (it's how they render), so a reorder *is* a change worth versioning.
function arrEq(a?: unknown[] | null, b?: unknown[] | null): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((item, i) => item === y[i]);
}
```

The `1e-9` epsilon is there because once you've coerced both sides through `Number()`, you've invited the usual binary-float surprises, and I would rather not cut a new commission version because `0.1 + 0.2` doesn't land where arithmetic class promised. For money at two decimal places it never actually fires, but it costs nothing and it's the correct instinct.

I went back and forth on `arrEq` being order-sensitive. You could argue `["5G", "unlimited"]` and `["unlimited", "5G"]` are the same package and reordering shouldn't mint a version. But in our UI the feature order is the display order — dragging a feature up the list is a deliberate edit an admin made on purpose — so treating a reorder as a real change is correct here. If features were an unordered set I'd sort both sides first, or compare them as sets. Know what your array *means* before you decide how to compare it.

## Building the change notes while you diff

The other thing the old code didn't do was say *what* changed. `changeNotes` existed on the table and was usually null. The history timeline on the frontend falls back to a generic "New version with commission X and Y RGU" string when it's empty, which is filler.

So I built the diff and the human-readable note in the same pass. Walk each field, and if it differs, record the change in a way a person can read three months later.

```ts
const changes: string[] = [];

if (!numEq(current.commission, input.commission)) {
  changes.push(
    `commission ${current.commission} → ${input.commission}`,
  );
}

if (!numEq(current.rguCount, input.rguCount)) {
  changes.push(`RGU ${current.rguCount} → ${input.rguCount}`);
}

if (!arrEq(current.features, input.features)) {
  changes.push(
    `features [${(current.features ?? []).join(', ')}] → ` +
      `[${(input.features ?? []).join(', ')}]`,
  );
}
```

`changes` does double duty. If it's empty, nothing changed and we bail. If it isn't, joining it gives the `changeNotes` string for free: `commission 45.00 → 50.00, RGU 1 → 2`. That's the line the timeline now renders, and it's the difference between a history you read and a history you scroll past.

## Throw on the no-op

Here's the decision I had to make: when the update changes nothing, what do you do? Silently return the package and pretend you versioned it? Return some `noChange: true` flag the frontend has to handle?

I throw.

```ts
if (changes.length === 0) {
  throw new BadRequestException(
    'No changes detected — package version not updated',
  );
}
```

The reasoning is that a no-op update is almost always a mistake — a double-click, a stale form re-submitted, a save with nothing actually edited — and surfacing it as an error is more honest than swallowing it. The admin gets a toast that says "no changes detected" instead of a success message for a thing that didn't happen. GraphQL turns the `BadRequestException` into a clean error the client already knows how to display, so it cost nothing on the frontend.

The full guarded path, with the eager versioning gone:

```ts
async updatePackage(code: string, input: UpdatePackageInput) {
  const pkg = await this.packageRepo.findOneOrFail({
    where: { packageCode: code },
    relations: { versions: true },
  });
  const current = pkg.versions.find((v) => v.isCurrent);
  if (!current) {
    throw new NotFoundException(`No current version for ${code}`);
  }

  const changes: string[] = [];
  if (!numEq(current.commission, input.commission)) {
    changes.push(`commission ${current.commission} → ${input.commission}`);
  }
  if (!numEq(current.rguCount, input.rguCount)) {
    changes.push(`RGU ${current.rguCount} → ${input.rguCount}`);
  }
  if (!arrEq(current.features, input.features)) {
    changes.push('features changed');
  }

  if (changes.length === 0) {
    throw new BadRequestException(
      'No changes detected — package version not updated',
    );
  }

  return this.dataSource.transaction(async (tx) => {
    current.isCurrent = false;
    current.validTo = new Date();

    const next = tx.create(PackageVersion, {
      package: pkg,
      version: current.version + 1,
      commission: input.commission,
      rguCount: input.rguCount,
      features: input.features,
      changeNotes: changes.join(', '),
      isCurrent: true,
      validFrom: new Date(),
    });

    await tx.save([current, next]);
    return tx.findOneOrFail(Package, {
      where: { id: pkg.id },
      relations: { versions: true },
    });
  });
}
```

The two writes — closing the old version and opening the new one — go in one transaction. That was already a latent bug in the original: if the process died between saving `current` (now `isCurrent = false`) and saving `next`, the package would have **zero** current versions and every sale lookup against it would fail. Wrapping both in `dataSource.transaction` makes "close old, open new" atomic. There is never a moment where a package has no current version or two of them.

## The sharp edges

The decimal-string thing is the one that'll get you. I want to underline it because it's the kind of bug that hides. With the *old* always-version code, the string-vs-number mismatch was invisible — we versioned on every save regardless, so nobody noticed that `current.commission === input.commission` was permanently false. The instant I added the diff to *stop* versioning, that same mismatch flipped from harmless to load-bearing: now it meant "commission always looks changed," so the diff never short-circuited and the no-op versions kept coming. The fix didn't work until `numEq` did. Two bugs that cancel out look like one working feature, right up until you fix half of it.

The second edge: `current.features` from the DB and `input.features` from GraphQL can both be `null` versus `[]` versus undefined, and those are three different falsy things that should all compare equal. The `?? []` on both sides of `arrEq` is doing quiet, necessary work. Before I added it, a package with `features: null` in the DB and `features: []` from a form that defaulted the field looked like a change — `null` vs `[]` — and minted a phantom version on first save. Same class of bug as the decimals: an absent value and an empty value are equal in meaning and unequal in JavaScript.

The third: I only diff the fields that live on `package_version`. The package's own attributes — `displayName`, `sortOrder`, `isActive` — are updated directly on the `package` row and don't trigger versioning at all, which is correct, because renaming a package isn't a pricing event and shouldn't pollute the price history. But it means "update package" is really two operations wearing one mutation, and if I were drawing the API again I'd split them: `updatePackageDetails` for the non-versioned attributes, `updatePackagePricing` for the versioned ones. One mutation that sometimes versions and sometimes doesn't is the ambiguity that produced this whole mess.

## What I'd do differently

The diff logic is hand-written, field by field, and that's fine while there are three versioned fields. The moment a fourth shows up — a `setupFee`, say — someone has to remember to add it to both the diff and the change-notes builder, and the failure mode if they forget is silent: the field changes, no version is cut, history lies again. I'd drive it off a small table of `{ field, label, compare }` descriptors so the diff, the note, and the "what counts as a change" decision all come from one declaration you can't half-update.

I'd also reconsider throwing on the no-op. It's the right default for an interactive admin saving a form. But the day we drive package updates from an import or a bulk sync, a `BadRequestException` on "this row didn't change" is noise, not signal — a batch of 200 packages where 180 are unchanged shouldn't throw 180 times. So I'd keep the throw for the GraphQL mutation and have the diff helper itself return `null` for a no-op, letting batch callers treat "nothing changed" as a skip instead of an error. The diff is the reusable part. The decision to shout about an empty diff belongs to the caller, not buried in the service.

The lesson I keep relearning: versioning is easy and *deciding when to version* is the actual feature. Anyone can append a row. The value is entirely in the rows you chose not to write — and you can't make that choice until you've defined equality honestly for every field, including the ones MySQL and JavaScript disagree about.
