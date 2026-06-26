---
title: "Floating chat heads and per-user inbox subscriptions"
description: "Real-time message discovery that surfaces a conversation the moment it starts."
date: "2025-09-02"
updated: "2025-09-02"
kind: "deepdive"
category: "Real-time"
tags: ["angular", "graphql", "subscriptions"]
month: "2025-09"
repo: "frontend"
author: "Sachal Chandio"
---

The messenger worked, but it was dead between page loads. You'd send a message, the other person had to refresh to see it, and a brand-new conversation from someone you'd never chatted with simply didn't exist until you reloaded the whole app. For a sales floor where a closer pings a QA agent about a stuck order, that's not a chat tool. That's email with extra steps.

So the goal was narrow: a message should appear the instant it's sent, and a conversation should surface the moment it starts — even one you didn't know existed. Floating chat heads for the attention-grabbing part. A per-user inbox subscription for the discovery part. And, it turns out, a fair amount of bookkeeping so the whole thing doesn't leak sockets all over the place.

## Two subscriptions, not one

The first thing I got wrong was thinking I could do this with a single subscription per conversation. You open a chat, you subscribe to `messageAdded(chatId)`, messages stream in. Fine. But that only works for chats you already have open. The instant a message arrives in a chat you've never opened — or a chat that didn't exist five seconds ago — you have no `chatId` to subscribe to. You can't subscribe to a thing you don't know the name of.

That's the whole reason the inbox subscription exists. It's keyed on the user, not the chat:

```graphql
subscription InboxMessage {
  inboxMessage {
    chatId
    messageId
    senderId
    senderName
    text
    totalUnreadCount
    profileImageURL
    createdAt
  }
}
```

No variables. The backend publishes every message destined for you to a single channel — conceptually `USER_INBOX_${userId}` — and the client subscribes once for the whole session. That payload carries `chatId`, so even if the conversation is brand new, the client now knows its id and can go fetch it.

The per-chat `messageAdded` subscription still exists, and both fire on the same message by design. The split in responsibility is the part people get wrong:

- `messageAdded(chatId)` — appends to the **open** conversation window, in real time. One per open chat.
- `inboxMessage` — updates the sidebar preview, the unread badge, the tab title, and spawns a chat head. Never appends to the open window.

If you let `inboxMessage` also append to the open chat, you get every message twice. I know because I did exactly that first, stared at the double messages for ten minutes, and then wrote a comment in the store that's still there: only `messageAdded` appends to the active window. The dedupe-by-id in `appendMessage` saved me anyway, but you don't want to lean on the safety net.

## Where the inbox event lands

The interesting code is the handler. A raw inbox payload has to fan out into four different pieces of state, and most of the logic is deciding whether the chat is *active* — because an active chat shouldn't bump its unread count or sprout a chat head:

```ts
handleInboxMessage(payload: any, options?: { isActive?: boolean }) {
  const chatId = String(payload?.chatId ?? '');
  const senderId = String(payload?.senderId ?? '');
  const isOwnMessage = this.isSenderCurrentUser(senderId);

  const ensureUpdate = (id: string) => {
    const active = options?.isActive ?? this.isChatActive(id as ChatId);

    // append the message to the chat's buffer (dedup'd by id downstream)
    const msgId = payload?.messageId || payload?.id;
    if (payload && msgId) this.appendMessage(id as ChatId, /* mapped */ message);

    let nextUnread: number;
    if (isOwnMessage)      nextUnread = active ? 0 : existingUnread; // never count your own echo
    else if (active)       nextUnread = 0;
    else                   nextUnread = existingUnread + 1;

    // when not active, never let a stale server total drag the count down
    if (!active) nextUnread = Math.max(existingUnread, nextUnread);

    this.updateConversationMeta(id as ChatId, { unreadCount: nextUnread, ... });

    if (!active && !isOwnMessage) {
      this.addHead(id as ChatId);       // float a chat head
      this.playNotificationSound();
    }
  };

  // chat exists? update it. Otherwise resolve/create it from senderId, then update.
  if (chatId && this.conversationExists(chatId)) { ensureUpdate(chatId); return; }
  if (senderId) {
    this.ensureChatWith(senderId).subscribe({ next: (conv) => ensureUpdate(conv.id) });
  }
}
```

Three things in there earned their place the hard way.

`isOwnMessage` exists because the inbox channel echoes your own sent messages back to you. Without the guard, sending a message would increment your own unread count, which is a special kind of stupid. The active-vs-not split decides everything: if the chat is on screen, the message is already read; if it isn't, it's unread and worth a chat head.

The `Math.max(existingUnread, nextUnread)` line is defensive and ugly, and I'd keep it. The backend sometimes ships a `totalUnreadCount` for the whole user rather than a per-chat number, and if you naively trust whatever number arrives you get the badge flickering down to a smaller value and back up. While a chat isn't active, the count is only allowed to go up. The same monotonic rule lives in the per-chat `unreadChanged` handler for the same reason.

And `ensureChatWith(senderId)` is the discovery path. If the inbox event references a chat the client has never seen, it calls `getOrCreateChat(otherUserId)` to materialize the conversation, then runs the same update. That's how a message from someone you've never talked to appears in your sidebar with no refresh.

## The chat heads themselves

The heads are deliberately dumb. The component is a `@for` over a signal of chat ids, each rendered as a fixed-position avatar button stacked from the right edge:

```ts
readonly heads = computed(() => this.store.heads());

getHeadPosition(index: number): number {
  return this.RIGHT_MARGIN + index * (this.HEAD_SIZE + this.GAP); // 16 + i*68
}
```

All the state lives in the store as a plain `signal<ChatId[]>`. `addHead` pushes an id, `removeHead` filters it out, and the component reacts. The only nuance is `addHead` refuses to add a head for a chat that's already open and un-minimized — a head is a "you're not looking at this" signal, so it's pointless when you are:

```ts
addHead(chatId: ChatId) {
  const popup = this.openPopupsSignal().find((p) => p.chatId === chatId);
  if (popup && popup.minimized === false) return; // already on screen
  if (this.headsSignal().includes(id)) return;    // no duplicates
  this.headsSignal.set([...this.headsSignal(), id]);
}
```

Clicking a head opens a popup, loads messages, subscribes to that chat's `messageAdded`, and removes the head. The mirror image happens on minimize: minimizing a chat window calls `addHead` so the conversation collapses back into a floating avatar instead of vanishing. Open removes a head, minimize creates one. That symmetry is the entire interaction model and it took me a couple of tries to make it feel right rather than leaving orphan heads behind.

There's one genuinely fiddly case: opening a head before its real conversation exists. When the inbox path hasn't resolved a `chatId` yet, the head carries a `temp-<userId>` id. Clicking it opens a temporary popup immediately (so the UI feels instant), then resolves the real conversation and swaps the temp popup for the real one atomically. If you skip the optimistic step, there's a visible beat where you click and nothing happens while the network round-trips. Users read that as a broken button.

## Pagination, because chats get long

Loading every message in a six-month-old conversation is a non-starter. The messenger pages with a cursor — the `createdAt` of the oldest message currently in the buffer — and walks backward:

```ts
loadOlderMessages(chatId: ChatId, cursor?: string, limit = 30) {
  if (this.noMoreOlderSignal().has(chatId)) {
    return of({ items: [], nextCursor: null }); // already hit the beginning
  }
  const oldest = this.messages(chatId)[0];
  const messageCursor = cursor ?? oldest?.createdAt;

  return this.api.getMessages(chatId, limit, messageCursor).pipe(
    tap(({ items }) => {
      if (!items.length) this.mutateSet(this.noMoreOlderSignal, s => s.add(chatId));
      else this.prependMessages(chatId, items);
    }),
  );
}
```

Two details matter. `prependMessages` filters out ids already in the buffer before prepending, because cursor pagination on a timestamp can hand you back a boundary message you already have. And once a page comes back empty, the chat id goes into `noMoreOlderSignal` so scrolling up stops hammering the API forever. Without that flag, an idle user parked at the top of a short conversation generates a request every time the scroll handler fires. I'd rather have a small per-chat `Set` than a chatty network tab.

## @mentions, the boring-but-useful part

Mentions in comments aren't real-time, but they ride the same agent directory the new-chat dialog uses, so they landed in the same sweep. The approach is unglamorous: type `@`, get a panel of matching agents, and the actual mention is encoded as `@user@example.com` in the text. On submit, a regex pulls the emails back out:

```ts
private extractMentionEmails(text: string): string[] {
  const set = new Set<string>();
  const re = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) set.add(m[1].toLowerCase());
  return [...set];
}
```

Encoding the mention as the email — rather than a display name — means the backend has a stable key to notify against, and it survives the user editing the surrounding prose. The panel selections and the typed text get merged into one `Set` so you can't double-notify the same person. Not clever. It just doesn't break.

## The bookkeeping that keeps it from leaking

This is the part nobody asks for in the ticket and the part that actually decides whether the feature is shippable. A messenger that opens a fresh WebSocket per chat and never closes them will, on a long-lived single-page app, accumulate dozens of live subscriptions per session.

Three rules hold it together.

The `messageAdded` streams are shared and ref-counted. The store memoizes one observable per chat id and wraps it in `shareReplay({ bufferSize: 1, refCount: true })`. Multiple callers asking for the same chat's stream get the same underlying socket; when the last one unsubscribes, `refCount` tears the socket down on its own.

Closing a chat actively disposes everything. When a popup closes, `cleanupChat` doesn't just hide the window — it evicts the shared stream from both the store and the API layer, completes the per-chat send queue so its async pump stops, drops the cached messages, and clears the pagination and mark-read flags. Eight small deletions. Miss one and you've got a slow leak that only shows up after an hour of use, which is the worst kind to debug.

The inbox subscription is single and gated on auth. It starts once, only when authenticated, and re-subscribes cleanly:

```ts
this.inboxSub?.unsubscribe();        // never stack two
this.inboxSub = this.api.onInboxMessage()
  .pipe(retry({ delay: 3000 }))      // reconnect on a dropped socket
  .subscribe({ next: (p) => this.handleInboxMessage(p, { isActive }) });
```

The dedicated `ChatInboxClientService` does the same thing with a stricter guard — it bails on the `/login` route and refuses to even attempt a subscription if there's no `accessToken` in storage, so you don't fire a doomed WebSocket handshake on the login screen and log a useless auth error.

## What I'd do differently

The active-chat check leans on `localStorage.getItem('tlz_messenger_activeChatId')` plus `document.hasFocus()`. It works, but reading focus state out of `localStorage` and the DOM inside a store method is the kind of thing that's fine until it isn't. If I rebuilt it, active-chat would be a signal owned by the store and written by the UI, not something the store reaches out and sniffs. Same answer, cleaner boundary.

The other thing: the inbox handler is doing too much. Appending messages, reconciling unread counts, patching participant info, spawning heads, and playing a sound — all in one method with a nested `ensureUpdate` closure. It reads fine today because I wrote it. It'll read like a riddle to whoever touches it next. Splitting it into a small reducer that maps an inbox event to a list of intents, applied separately, would make each rule testable in isolation. I haven't, because it works and the floor is busy.

Here's when this bites you: the day the backend changes what `totalUnreadCount` means, or starts sending it more aggressively, every one of those `Math.max` guards becomes load-bearing in a way you forgot about. Real-time UI is mostly the art of not trusting your own state — and writing down, in a comment next to the guard, exactly which lie you're defending against.
