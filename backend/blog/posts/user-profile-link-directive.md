---
title: "An app-wide profile-link primitive that enforces access policy"
description: "Dozens of one-off ‘open profile’ call sites collapsed into one directive plus one service."
date: "2026-06-19"
updated: "2026-06-19"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "directives", "access-control"]
month: "2026-06"
repo: "frontend"
author: "Sachal Chandio"
---

I went looking for one bug in how we opened a user's profile and found nine copies of the same code, each slightly wrong in its own way.

The pattern was always the same. Somewhere there's a name or an avatar. You click it, a dialog opens showing that person's stats. Inventory had it on the "assigned to" cell. The penalty panel had it on "requested by" and "reviewed by". User-management had it on the table rows. Every one of those sites had hand-rolled the `dialog.open(UserProfileComponent, …)` call, picked its own width and height, and decided — or more often didn't decide — who was allowed to open whose profile.

That last part is what scared me. Most sites just opened the dialog for whatever id you gave them. A normal agent could, in a couple of spots, pull up a colleague's profile because the click handler never checked. Nobody designed that; it was the default behavior of code that was copy-pasted before anyone asked the question.

## The duplication, concretely

A representative "before" handler looked like this. Fetch the user by id, fall back to a stub if the fetch fails, open the dialog with the magic config:

```ts
openUserProfile(agentId?: string | null): void {
  const id = String(agentId ?? '').trim();
  if (!id) return;
  this.userService.getUserById(id).subscribe({
    next: (user) =>
      this.dialog.open(UserProfileComponent, {
        data: { component_name: true, user },
        width: '90vw',
        height: '90vh',
        panelClass: 'user-profile-dialog',
      }),
    error: () =>
      this.dialog.open(UserProfileComponent, {
        data: { component_name: true, user: { id, name: 'User' } },
        width: '90vw',
        height: '90vh',
        panelClass: 'user-profile-dialog',
      }),
  });
}
```

Multiply that by nine, with the `90vw`/`90vh`/`user-profile-dialog` triple drifting slightly each time, the fallback name sometimes present and sometimes `'User'`, and the access check present in exactly zero of them. The template side was just as ad hoc: a `(click)` here, a `style="cursor:pointer"` there, no keyboard support anywhere, and a `<span>` pretending to be a button with nothing telling a screen reader so.

I wanted three things. One source of truth for "may this person open that profile". One source of truth for the dialog config and the fetch/fallback dance. And a way to attach the *clickable affordance* — cursor, hover underline, focus, Enter/Space — without every component re-learning it.

## What I rejected

My first instinct was a wrapper component: `<app-profile-link [user]="x">{{ x.name }}</app-profile-link>`. It works, but it forces a span around your content and you fight it the moment you want the affordance on an `<img>` avatar or a table cell that already has its own styling. A component owns its DOM; I didn't want to own the DOM here, I wanted to *decorate* whatever DOM the call site already had.

The second idea was a shared service and nothing else — make every site call `profileDialog.open(user)`. That fixes the dialog duplication and the policy, but it does nothing for the template. You still wire up your own click, your own cursor, your own keyboard handling, and you still forget two of the three.

So: a directive for the affordance, a service for the behavior, and a pure function for the policy that both of them call. The directive is the thing you reach for in a template; the service is the thing the directive (and any imperative caller) reaches for; the function is the thing neither of them is allowed to disagree about.

## The policy, as a pure function

This is the whole rule, and it lives by itself so it can be unit-tested without Angular in the room:

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

Privileged users (admin or manager, via `isPrivilegedUserCached()`) open anyone. Everyone else opens only themselves, matched by id. No target id, no open. That's it. The `String(… ?? '').trim()` noise is there because the ids arrive from a dozen GraphQL fragments and some are numbers, some are strings, and at least one was once `'  42 '`.

The function is deliberately ignorant of how you got the inputs. The directive feeds it the cached privilege flag and a resolved id; the service feeds it the same after an async lookup of the current user. Same answer either way, which is the point.

## The directive: affordance only when allowed

The directive's selector is `[appUserProfileLink]` and it takes either a user object or a bare id string. Its one opinion: the element only *looks and behaves* clickable when `canOpenProfile` says yes. If you can't open the profile, you get plain, inert text — no pointer cursor inviting a click that would do nothing.

```ts
@Directive({ selector: '[appUserProfileLink]', standalone: true })
export class UserProfileLinkDirective implements OnInit, OnChanges {
  @Input('appUserProfileLink') target: string | UserProfileLike | null | undefined;
  @Input() profileFallbackName?: string;

  @HostBinding('class.user-profile-link') canOpen = false;

  @HostBinding('attr.role') get role() { return this.canOpen ? 'button' : null; }
  @HostBinding('attr.tabindex') get tabindex() { return this.canOpen ? 0 : null; }

  ngOnInit(): void {
    this.authService.getCurrentUserId()
      .then((id) => { this.currentUserId = id; this.recompute(); })
      .catch(() => this.recompute());
  }
  ngOnChanges(): void { this.recompute(); }

  @HostListener('click', ['$event'])
  @HostListener('keydown.enter', ['$event'])
  @HostListener('keydown.space', ['$event'])
  onActivate(event: Event): void {
    if (!this.canOpen) return;
    event.preventDefault();
    event.stopPropagation();
    const t = this.target;
    if (t && typeof t === 'object') this.dialogService.openForUser(t);
    else this.dialogService.openById(this.targetId, this.profileFallbackName);
  }

  private recompute(): void {
    this.canOpen = canOpenProfile(
      this.targetId,
      this.currentUserId,
      this.authService.isPrivilegedUserCached(),
    );
  }
}
```

A few decisions worth calling out. The `role` and `tabindex` are bound through getters so they vanish (`null`) when the element isn't interactive — a non-clickable name shouldn't be a tab stop or announce as a button. Enter and Space share the click path because a thing with `role="button"` that doesn't respond to the keyboard is a lie. And `getCurrentUserId()` is async (it decrypts from local storage), so `canOpen` starts `false` and flips once we know who you are; for the common privileged case `isPrivilegedUserCached()` is already true synchronously, so there's no visible flicker for the people who click these most.

The CSS the class hangs onto is intentionally tiny — it's global so it doesn't get re-declared per component:

```scss
.user-profile-link { cursor: pointer; }
.user-profile-link:hover,
.user-profile-link:focus-visible { text-decoration: underline; outline: none; }
img.user-profile-link:hover,
.user-profile-link:hover img { opacity: 0.88; }
```

## The service: config, fetch, and the backstop guard

The directive handles the affordance. The service handles everything that happens after the click, and it re-checks the policy. Two enforcement points for the same rule isn't redundant — the directive's job is to not *offer* a click you can't make, but a determined caller can invoke the service directly, so the service guards too. Defense in depth, on the front end, mostly so future-me doesn't open a hole by calling `openById` from some new place and forgetting.

```ts
@Injectable({ providedIn: 'root' })
export class UserProfileDialogService {
  async canOpen(targetUserId: string | null | undefined): Promise<boolean> {
    const currentUserId = await this.authService.getCurrentUserId();
    return canOpenProfile(
      targetUserId, currentUserId, this.authService.isPrivilegedUserCached(),
    );
  }

  openForUser(user: UserProfileLike | null | undefined): void {
    const id = String(user?.id ?? '').trim();
    this.guardThenOpen(id, () => this.openDialog(user ?? {}));
  }

  openById(id: string | null | undefined, fallbackName?: string): void {
    const cleanId = String(id ?? '').trim();
    if (!cleanId) return;
    this.guardThenOpen(cleanId, () => {
      this.userManagementService.getUserById(cleanId).subscribe({
        next: (user) => this.openDialog(user as UserProfileLike),
        error: () => this.openDialog({
          id: cleanId, name: fallbackName || 'User', email: '', profileImageURL: '',
        }),
      });
    });
  }

  private guardThenOpen(targetId: string, open: () => void): void {
    this.canOpen(targetId).then((allowed) => { if (allowed) open(); });
  }

  private openDialog(user: UserProfileLike): void {
    this.dialog.open(UserProfileComponent, {
      data: { component_name: true, user: user as unknown as UserDto },
      width: '90vw', height: '90vh', panelClass: 'user-profile-dialog',
    });
  }
}
```

`openForUser` is for when the call site already has the whole user object (the penalty panel does — `record.penalizedBy` is a full fragment), so there's no point round-tripping to the server. `openById` is for when all you have is an id, with the fallback stub for when the lookup fails so the dialog still opens with *something* instead of dying silently.

The `UserProfileLike` type is deliberately loose — `{ id?, name? } & Record<string, unknown>`. Our GraphQL fragments don't agree on shape (one has `userType: string`, the full `UserDto` has a `UserType` enum), and I was not about to make every call site cast to the canonical DTO just to open a dialog. Structural typing earns its keep here.

## openSelf(), the shortcut I almost forgot

There was a second, quieter kind of duplication: the "open *my own* profile" button in the header and a few menus. Those passed `{ component_name: true }` with no user and let the dialog default to the logged-in user. Same magic config, copy-pasted, no guard needed because opening your own profile is always allowed.

```ts
openSelf(): void {
  this.dialog.open(UserProfileComponent, {
    data: { component_name: true },
    width: '90vw', height: '90vh', panelClass: 'user-profile-dialog',
  });
}
```

It's three lines and it bypasses the guard on purpose — there's no target to check. Worth its own method only because it kills the last places that knew the `90vw`/`90vh`/`user-profile-dialog` incantation by hand. Now exactly one file knows it.

## Migrating the call sites

The template changes are almost boring, which is the goal. A name that used to be inert text, or a name with a bespoke click handler, becomes:

```html
<span [appUserProfileLink]="record.penalizedBy">{{ record.penalizedBy.name }}</span>
@if (record.reviewedBy; as reviewer) {
  · reviewed by
  <span [appUserProfileLink]="reviewer">{{ reviewer.name }}</span>
}
```

No click handler in the component, no cursor style, no keyboard wiring. The component just imports the directive and renders the name. The imperative sites — like single-inventory, which opened the profile from a button rather than a clickable name — collapsed to one line:

```ts
openUserProfile(agentId?: string | null): void {
  // Centralized: fetch + fallback AND the access policy live in the service now.
  this.userProfileDialog.openById(agentId, this.unit?.agentName);
}
```

One genuine blocker: the record-search results row only carried `agentName` as a string, no `agentId`. You can't link a profile you can't identify. That one waited until the id was plumbed onto the DTO — which it now is, in a later commit — rather than faking it. The directive renders inert text given no resolvable id, so the un-migrated state was at least honest about not being clickable.

## What I'd watch for

The privilege check is synchronous and cached, which is what keeps the affordance from flickering. The flip side is that it's only as fresh as the cache. If a user's role changes mid-session, `isPrivilegedUserCached()` can be stale until the next refresh, and the directive will show or hide the affordance based on the old answer. For us that's fine — roles don't change while you're staring at a penalty panel — but it's the kind of assumption that's invisible until the day it isn't.

And to be clear about what this is: a *UI* access control. It decides who sees a clickable name and who can pop a dialog. It is not authorization. The profile data still comes from a GraphQL query, and that query is where the real boundary has to live — the backend resolver has to enforce who can read whose profile regardless of what the front end offers. The directive stops a normal user from idly clicking a colleague's name. It does not, and must not be trusted to, stop someone who opens the network tab. I keep these two honest by treating the front-end check as politeness and the resolver as the wall.

The win was never cleverness. It was that "open a profile" now has one place to change, one place to test, and one place where the policy is written down — and the next person who needs a clickable name types `[appUserProfileLink]` and inherits all of it, including the part that says no.
