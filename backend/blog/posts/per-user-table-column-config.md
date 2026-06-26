---
title: "Scoping client state per user so configs stop leaking between accounts"
description: "Switching accounts inherited the previous user's table layout. Keying preferences by user and clearing on auth change."
date: "2025-12-02"
updated: "2025-12-02"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "signals", "localstorage", "auth"]
month: "2025-12"
repo: "frontend"
author: "Sachal Chandio"
---

A team lead pinged me on a Friday. He'd logged into Telelinkz to check his agents' numbers, opened the Sales table, and three of his columns were gone. Hidden. The column order was scrambled too — Disposition was sitting where Agent Name should be. He swore he hadn't touched the column settings. He hadn't.

I asked the obvious thing first: were you on a shared machine? He was. He'd logged in right after one of his agents had been showing him something on the same laptop.

That detail is the whole bug, but I didn't see it yet.

## The first guess was wrong

My first instinct was that the column config was getting corrupted on write. Our tables let you show/hide columns, reorder them by drag, and resize them, and all of that gets persisted so it survives a refresh. We store it client-side. My theory: a race between the drag-reorder handler and the resize handler was writing a half-baked layout, and the team lead had just caught the bad state.

So I went looking at the persistence layer. Here's roughly what it looked like:

```ts
@Injectable({ providedIn: 'root' })
export class TableColumnConfigService {
  private readonly STORAGE_KEY = 'table_column_configurations';

  load(tableId: string): ColumnConfig[] | null {
    const raw = localStorage.getItem(this.STORAGE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, ColumnConfig[]>;
    return all[tableId] ?? null;
  }

  save(tableId: string, columns: ColumnConfig[]): void {
    const raw = localStorage.getItem(this.STORAGE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, ColumnConfig[]>) : {};
    all[tableId] = columns;
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(all));
  }
}
```

I stared at this for a while trying to find the corrupting write. There isn't one. `save` reads the whole blob, mutates one table's entry, writes it back. The reorder and resize handlers both call `save` with a complete, valid column array. Nothing here produces a half-baked layout.

The naive race theory was dead. And it was dead for a boring reason: I'd been looking at *what* gets written instead of *who* it gets written for.

## The actual root cause

Read the storage key again. `table_column_configurations`. One key. For everyone.

`localStorage` is scoped to the origin, not to the logged-in user. Our app is a single-page app — when the agent logged out and the team lead logged in, the page never reloaded. Same tab, same origin, same `localStorage`. The team lead's session inherited every column layout the agent had set, because as far as the browser was concerned there was only one bucket of preferences and it didn't care whose face was behind the keyboard.

So it wasn't corruption. It was the agent's perfectly valid layout showing up under the team lead's login. The "missing" columns were columns the agent had hidden because he only cared about his own three KPIs. The scrambled order was his order.

I reproduced it in ten seconds once I knew what to look for: log in as user A, hide a column, log out, log in as user B in the same tab. B sees A's hidden column. Every time.

The thing that made this sneaky is that it only bites on shared machines or when one person genuinely switches accounts. Most users log into their own laptop and never see it. It sat in production quietly until a team lead happened to borrow an agent's screen.

## The fix: key the cache by user

The fix is conceptually small. Stop using one global key. Namespace the storage per user, and make sure stale state from the previous user can't bleed through.

Three moving parts:

1. Know who the active session user is, on the client.
2. Build the storage key from that user id: `table_column_configurations_<userId>`.
3. Clear the in-memory copy when the auth state changes, so a logout doesn't leave the last user's layout sitting in a signal.

I already had an `AuthService` holding the decoded JWT and the current user. I added an `activeSessionUserId` concept the config service could read, set it on login, and subscribed to auth-state changes to flush.

Here's the service after the change:

```ts
@Injectable({ providedIn: 'root' })
export class TableColumnConfigService {
  private readonly KEY_PREFIX = 'table_column_configurations';

  // in-memory mirror so reads don't hit localStorage every render
  private readonly configs = signal<Record<string, ColumnConfig[]>>({});

  private activeSessionUserId: string | null = null;

  constructor(private readonly auth: AuthService) {
    // when the logged-in user changes (login, logout, switch), re-scope
    this.auth.authState$.subscribe((user) => {
      this.setActiveSession(user?.id ?? null);
    });
  }

  private storageKey(): string | null {
    if (!this.activeSessionUserId) return null;
    return `${this.KEY_PREFIX}_${this.activeSessionUserId}`;
  }

  setActiveSession(userId: string | null): void {
    if (userId === this.activeSessionUserId) return;
    this.activeSessionUserId = userId;
    // drop the previous user's layout out of memory, then hydrate the new one
    this.configs.set({});
    this.hydrate();
  }

  private hydrate(): void {
    const key = this.storageKey();
    if (!key) return;
    const raw = localStorage.getItem(key);
    this.configs.set(raw ? (JSON.parse(raw) as Record<string, ColumnConfig[]>) : {});
  }

  load(tableId: string): ColumnConfig[] | null {
    return this.configs()[tableId] ?? null;
  }

  save(tableId: string, columns: ColumnConfig[]): void {
    const key = this.storageKey();
    if (!key) return; // no logged-in user => nothing to persist

    const next = { ...this.configs(), [tableId]: columns };
    this.configs.set(next);
    localStorage.setItem(key, JSON.stringify(next));
  }
}
```

A few things worth calling out, because the diff hides some decisions.

The `if (userId === this.activeSessionUserId) return;` guard matters more than it looks. `authState$` can emit the same user twice on a token refresh, and without that guard every refresh would blow away the in-memory configs and re-read from disk for no reason. Harmless, but it caused a visible flicker on tables mid-render the first time I tried it without the guard.

`setActiveSession(null)` is the logout path. The `storageKey()` returns `null`, `configs` gets cleared, and `hydrate` short-circuits. So after logout there is literally no per-user layout held anywhere in the app. The next login re-scopes and pulls that user's own key off disk.

I deliberately did *not* migrate or delete the old global `table_column_configurations` key. It just sits there orphaned. Nothing reads it anymore, so it's dead weight, not a hazard — and writing a migration to split one blob across N users by guessing who owned it was not a project I wanted. If it ever bothers me I'll add a one-time cleanup that removes the legacy key on first login. It hasn't bothered me.

On the auth side, the only change was making the active user observable in a way the config service could subscribe to. The login flow already set the user; I just made sure it pushed through `authState$` and that logout pushed `null`:

```ts
// in AuthService, on successful login
this.currentUser.set(user);
this.authStateSubject.next(user);

// on logout
this.currentUser.set(null);
this.authStateSubject.next(null);
localStorage.removeItem('access_token');
```

## Why a signal and not just localStorage

You might ask why there's an in-memory `signal` mirror at all, given that `localStorage` is already persistent. Two reasons.

Reads. The tables read column config on every render pass, and `localStorage.getItem` + `JSON.parse` on each read is wasteful when the data only changes on an explicit user action. The signal is the hot path; `localStorage` is the durable backup. Writes go to both, reads come from the signal.

Correctness on switch. `localStorage` has no concept of "the current user" — if I read straight from it, I'd have to re-derive the key on every single read and trust that nobody forgot. By holding the active user's configs in a signal that gets *cleared* on auth change, the wrong-user state physically cannot survive a login switch. The bug is closed by construction, not by everyone remembering to pass the right key everywhere.

## The general lesson

The real mistake predates this bug. We treated `localStorage` as if it were per-user storage. It isn't. It's per-origin. Any state you put there outlives the session, outlives the logout, and is visible to whoever logs in next on that browser. The browser does not know or care who your user is.

So the rule I now apply: **if a piece of client state is meaningful only in the context of a logged-in user, its storage key must contain the user id, and it must be cleared when the auth state changes.** Both halves. Keying by user stops the cross-contamination on read; clearing on auth change stops stale in-memory copies from leaking before the next read re-scopes.

This bites hardest in exactly the places you don't test: shared machines, kiosk logins, support staff who switch between accounts, anyone using "log out and back in as someone else" as a debugging move. Single-tab SPAs make it worse because there's no page reload to wipe the slate. If your auth flow doesn't reload the page on login — and most modern ones don't — then every scrap of client-cached state from the previous user is still sitting right there waiting to be served to the next one.

Audit your `localStorage` keys. Any of them that hold user-specific preferences, filters, draft form state, dismissed banners — check whether switching accounts in the same tab leaks them. Mine did. I'd bet at least one of yours does too.
