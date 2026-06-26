---
title: "Extracting a shared avatar util and caching audio durations"
description: "Three copies of the same initials-and-color logic, and audio that re-decoded on every load. Dedupe and cache."
date: "2025-05-13"
updated: "2025-05-13"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "utilities", "caching"]
month: "2025-05"
repo: "frontend"
author: "Sachal Chandio"
---

I went to change one color in the messenger and found I had to change it in four places. That's the kind of discovery that ruins your afternoon in a good way — it tells you the actual bug isn't the color, it's that the same forty lines of "turn a name into initials and a background color" got copy-pasted everywhere a face needed to show up.

The messenger conversation header had it. The chat info panel had its own copy. The member-management dialog had a third. And there was a real `AvatarComponent` sitting in `components/shared/avatar/` that nobody used in those places because pasting a helper method was faster than importing a component. Four implementations of the same idea, and — this is the part that bites — they didn't agree. Two of them used the bit-shift hash. One summed char codes with a different modulus. The palettes were different lengths. So the same person got a blue circle in the sidebar and a green one in the chat header, which looks less like a design system and more like a bug report waiting to happen.

## The duplicate, in three slightly different costumes

Here's what the messenger conversation carried, inline on the component:

```ts
getInitials(name: string | undefined): string {
  if (!name) return '?';
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();
}

private readonly senderColorPalette: string[] = [
  '#1e88e5', '#43a047', '#fb8c00', '#e53935', '#8e24aa', '#00acc1',
  '#d81b60', '#6d4c41', '#546e7a', '#c0ca33', '#f4511e', '#5e35b1',
];

getSenderColor(name: string | undefined): string {
  if (!name) return this.senderColorPalette[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash; // force to 32-bit
  }
  const index = Math.abs(hash) % this.senderColorPalette.length;
  return this.senderColorPalette[index];
}
```

The `AvatarComponent` had the same shape but a different palette — eight hex values starting `#2563eb` instead of the Material-ish twelve above — and folded initials and color into getters. The member-management dialog had only `getInitials`, no color at all, so its avatars were all one flat gray. None of these were wrong on their own. Together they were three sources of truth for a thing that should have exactly one, and the determinism — same name always gets the same color — only holds *within* a single copy. Across copies, the whole point of a deterministic color falls apart.

## What I pulled out

I didn't try to be clever about it. A name goes in, initials and a color come out, and it's a pure function so it's trivial to test and impossible to make stateful by accident. I put it next to the URL helper that already lived at `utils/profile-avatar.util.ts` (that one resolves a profile image URL or falls back to a gendered placeholder — related job, same file).

```ts
const AVATAR_COLORS = [
  '#1e88e5', '#43a047', '#fb8c00', '#e53935', '#8e24aa', '#00acc1',
  '#d81b60', '#6d4c41', '#546e7a', '#c0ca33', '#f4511e', '#5e35b1',
] as const;

export interface ProfileAvatar {
  initials: string;
  color: string;
}

export function getProfileAvatarUtil(name?: string | null): ProfileAvatar {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return { initials: '?', color: AVATAR_COLORS[0] };

  const initials = trimmed
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();

  // djb2-flavored hash: stable across reloads, no Math.random anywhere
  let hash = 0;
  for (let i = 0; i < trimmed.length; i++) {
    hash = trimmed.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0;
  }
  const color = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];

  return { initials, color };
}
```

Two decisions worth defending. First, it returns both pieces in one object instead of two functions, because the only caller that wants initials wants the color too, and splitting them just means two iterations over the same string and two import lines. Second, I canonicalized on the twelve-color palette and the bit-shift hash — the messenger's version — because that palette was the most-seen one in the running app and re-skinning the messenger to match the smaller `AvatarComponent` palette would have been a visible change to users. Picking the winner this way is a judgment call; I'd rather every avatar shift to match the one most people already look at than have the loud surface change.

`split(/\s+/)` instead of `split(' ')` is the one real bug fix smuggled in. The old `split(' ')` turned `"Mary  Jane"` (someone double-spaced a name in the admin form) into `["Mary", "", "Jane"]`, and `n[0]` on the empty string is `undefined`, so the initials came out `"Mu"`-ish garbage. Collapsing whitespace makes that go away.

Then the call sites collapse to one line each:

```ts
// messenger conversation, chat info panel, member dialog — all the same now
protected avatar(name?: string) {
  return getProfileAvatarUtil(name);
}
```

```html
<div class="mc-avatar-initials" [style.background-color]="avatar(title).color">
  {{ avatar(title).initials }}
</div>
```

I deleted three copies of the hash, two stray palettes, and the dialog's color-less gray circles got actual colors for free. The thing I'd flag if you do this: calling `avatar(title)` twice in the template — once for color, once for initials — runs the function twice per change-detection cycle. It's a string hash over a short string, so I left it; it's nowhere near a hot path. If it were a long list re-rendering constantly I'd memoize per name or compute it once into a view model. Know which one you've got before you optimize.

## The other repeat offender: audio re-decoding

Different file, same disease. The messenger plays voice notes through an `AudioPlayerComponent`, and every time a message scrolled back into view, or you switched conversations and came back, the player handed the `<audio>` element the same S3 URL and the browser dutifully fetched and decoded enough of it to report `duration` all over again. The duration label flashed `--:--`, then snapped to `0:14` a beat later. On a thread with twenty voice notes, that's twenty redundant metadata fetches for clips whose length hadn't changed since they were recorded.

The duration of a recording is immutable. We know it the moment it's sent. So there's no reason a component instance should be the unit of memory here — the answer should outlive any one player.

I put a cache on the class itself, keyed by source URL:

```ts
export class AudioPlayerComponent {
  private static durationCache = new Map<string, number>();

  @Input() src!: string;
  @Input() initialDurationSec?: number;

  durationSec = 0;
  duration = '--:--';
```

When the media element finally reports a real duration, I write it through:

```ts
private syncDurationState(): void {
  const mediaDurationSec = this.normalizeDuration(this.audio.duration);

  if (mediaDurationSec > 0 && this.src) {
    AudioPlayerComponent.durationCache.set(this.src, mediaDurationSec);
  }

  const resolvedDurationSec =
    mediaDurationSec || this.resolveKnownDuration(this.initialDurationSec);

  this.durationSec = resolvedDurationSec;
  this.duration = resolvedDurationSec ? this.formatTime(resolvedDurationSec) : '--:--';
}
```

And reads resolve in priority order: an explicit `initialDurationSec` the caller passed, then the static cache, then nothing.

```ts
private resolveKnownDuration(durationSec?: number): number {
  const inputDurationSec = this.normalizeDuration(durationSec ?? Number.NaN);
  if (inputDurationSec > 0) return inputDurationSec;

  return this.normalizeDuration(
    AudioPlayerComponent.durationCache.get(this.src) ?? Number.NaN,
  );
}
```

`ngAfterViewInit` and `ngOnChanges` both call `applyKnownDuration()`, which reaches into that same resolver. So the second time a player mounts for a URL we've already decoded, it shows `0:14` immediately — no fetch, no `--:--` flicker, the waveform is seekable before the audio element has done anything. `normalizeDuration` exists because `audio.duration` is `Infinity` or `NaN` for a beat while streaming, and I am not about to format `Infinity` into a timestamp.

## Closing the loop back to the store

The cache helps within a session, but it's empty on first load — the first time you open a thread, every duration still starts unknown. The better fix is to never not know in the first place. When a voice note is recorded, we already measure its length before upload:

```ts
this.uploadFile(id, file, { audioDurationSec: durationSec });
```

That `audioDurationSec` rides along on the message and lands on the `MessageView`, which the template feeds straight into the player as `[initialDurationSec]="m.audioDurationSec"`. So a freshly recorded clip shows its real duration the instant it appears, before the upload even finishes — the player trusts the number it was handed and skips decoding entirely. The static cache is the fallback for the clips that predate that field, or that arrive from someone else's device where we never measured locally. Two layers: a known value propagated through the store for the common case, a per-URL memo for everything else.

## What I'd watch for

A `static Map` keyed by URL is a memory leak with good manners — it only ever grows, one entry per distinct recording you've played this session. For voice notes in a CRM that's bounded and tiny; a couple hundred small numbers. If this were a media app where users scrub through thousands of distinct audio URLs in a sitting, I'd bound it — an LRU, or just clear it on conversation switch. It's a deliberate tradeoff, not an oversight, and the line between the two is whether you wrote down why.

The avatar cleanup has a quieter lesson. The reason the same logic existed four times wasn't laziness exactly — it was that importing a shared thing felt heavier than pasting eight lines, right up until those eight lines drifted into four different behaviors and the same person started showing up in two colors. Duplication isn't expensive on the day you write it. It bills you later, with interest, the first time you have to change a "one-line" thing in four files and notice three of them were already lying to each other.
