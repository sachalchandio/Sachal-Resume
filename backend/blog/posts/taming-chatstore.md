---
title: "Taming a 500-line async state store"
description: "A sprawling chat store with loose types and tangled async. Refactoring it for clarity without a rewrite."
date: "2025-09-12"
updated: "2025-09-12"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "rxjs", "typescript", "refactor"]
month: "2025-09"
repo: "frontend"
author: "Sachal Chandio"
---

The file that finally pushed me over the edge was `chat.store.ts`. 514 lines. Mixed two-space and four-space indentation depending on which week I'd written which method. Signals typed `any` because I'd been in a hurry the day I added them and "I'll tighten it later" turned into three months. And buried in the middle, an `uploadFile` flow that I genuinely could not trace by reading it — I had to run the app, attach a file, and watch the network tab to remember what it did.

Telelinkz has an in-app chat for the sales floor. Agents send messages, attach call recordings and contract scans, and the whole thing runs over a GraphQL subscription with optimistic local echo. The store holding all of that had grown by accretion. Every feature added a branch. Nobody had ever sat down and made it legible.

I want to be precise about what this was, because it shapes every decision below: this was a refactor for legibility, not a rewrite. The behavior was correct. Users weren't complaining. The problem was that *I* couldn't safely change it anymore, which meant the next feature was going to take three days instead of three hours and probably ship a bug. That's the failure mode that justifies touching working code — not aesthetics.

## The constraints

Two things boxed me in, and they're worth stating because they're why I didn't just rewrite the store as a clean NgRx feature or whatever.

The store was consumed by five components and two services, and the public surface — the signals they read, the methods they called — was load-bearing across all of them. A rewrite means re-verifying every one of those call sites by hand against a backend I can't easily mock, because half the behavior only shows up when a real subscription pushes a real message mid-upload. I didn't have that test coverage. Writing it first would have been the "correct" thing and also would have tripled the scope, and this was a Tuesday, not a sprint.

So the rule I gave myself: **public API stays byte-for-byte identical, internals get clarified.** If a component imported `chatStore.messages` and `chatStore.sendMessage(...)` before, those resolve to the exact same thing after. The diff should be reviewable as "this is the same code, but now I can read it." That constraint is doing a lot of work — it's what let me move fast without a safety net.

## Approach: four passes, in order

I rejected the all-at-once edit immediately. When you change typing, formatting, and async logic in one commit, and something breaks, you've got nothing to bisect. So I did four passes, each its own commit, each independently verifiable.

### Pass 1 — types first, because types find the bugs

The signals were `any`, which meant TypeScript had been silently agreeing with every mistake I'd ever made. First job was writing the real interfaces.

```ts
// before
private _messages = signal<any[]>([]);
private _uploads = signal<any>({});
private _pending = signal<any[]>([]);
```

The `tempId` was the thing that mattered most. Optimistic messages get a client-generated id before the server assigns the real one, and the reconciliation — swap the temp message for the server one when the mutation resolves — was all done by poking into `any` objects. So the type had to make the two ids first-class:

```ts
interface ChatMessage {
  id: string | null;        // server id, null until the send mutation resolves
  tempId: string | null;    // client id, null once reconciled
  body: string;
  author: AuthorRef;
  attachments: Attachment[];
  status: 'pending' | 'sent' | 'failed';
  createdAt: string;        // ISO; the API never sends Date
}

interface UploadState {
  tempId: string;
  file: File;
  stage: 'queued' | 'uploading' | 'processing' | 'done' | 'error';
  progress: number;         // 0–100, only meaningful while stage === 'uploading'
  url: string | null;       // populated when stage === 'done'
}

private _messages = signal<ChatMessage[]>([]);
private _uploads = signal<Record<string, UploadState>>({});
```

The moment I changed `_uploads` from `any` to `Record<string, UploadState>`, the compiler lit up four places where I'd been reading `upload.progress` on an upload that might not exist yet, and one where I compared `id === tempId` — two fields that, now that they had types, could never be equal. That comparison had been silently always-false for who knows how long. The optimistic reconcile was working by accident through a different code path. Types didn't just document the bug, they found it.

### Pass 2 — null and tempId guards

With the types in place, the guards wrote themselves, because now the compiler was telling me where `null` could flow. The old code assumed a message always had an `id`. It doesn't — a pending message has only a `tempId`. So everywhere I looked something up by id, I had to decide which id I meant.

```ts
// before: blows up on optimistic messages, id is null
const idx = msgs.findIndex(m => m.id === serverId);

// after: explicit about which identity we're matching on
private findByEitherId(msgs: ChatMessage[], id: string): number {
  return msgs.findIndex(m => m.id === id || m.tempId === id);
}
```

The reconcile became something I could actually read. When the send mutation resolves, find the message by its `tempId`, then promote it: fill in the real `id`, clear the `tempId`, flip status to `'sent'`.

```ts
private reconcile(tempId: string, server: ServerMessage): void {
  this._messages.update(msgs =>
    msgs.map(m =>
      m.tempId === tempId
        ? { ...m, id: server.id, tempId: null, status: 'sent' as const }
        : m
    )
  );
}
```

Setting `tempId` to `null` after reconcile matters. It means a message is in exactly one of two states — optimistic (`tempId` set, `id` null) or confirmed (`id` set, `tempId` null) — and never some ambiguous third thing where both are populated and the next lookup matches the wrong one. The type plus the null-out enforces a little state machine that used to live only in my head.

### Pass 3 — standardize the RxJS

Every method that talked to Apollo had its own pipe dialect. Some used `firstValueFrom`, some subscribed manually and never unsubscribed, one had a `.subscribe()` inside a `.subscribe()` that I'm not proud of. The behavior was fine. The inconsistency meant every read started from zero.

I picked one shape and made everything match it: `switchMap` for things that supersede (typing into the same thread), `mergeMap` for things that run in parallel (uploads), `takeUntilDestroyed` on every long-lived stream, errors caught at the pipe and folded into state rather than thrown.

```ts
// before — a representative offender
sendMessage(body: string) {
  const tempId = uuid();
  this.pushOptimistic(tempId, body);
  this.apollo.mutate({ mutation: SEND, variables: { body, tempId } })
    .subscribe(res => {
      this.reconcile(tempId, res.data.sendMessage);
    }); // no error branch, no unsubscribe
}
```

```ts
// after
sendMessage(body: string): void {
  const tempId = uuid();
  this.pushOptimistic(tempId, body);

  this.apollo
    .mutate<SendResult>({ mutation: SEND, variables: { body, tempId } })
    .pipe(
      map(res => res.data?.sendMessage),
      filter((m): m is ServerMessage => m != null),
      takeUntilDestroyed(this.destroyRef),
      catchError(err => {
        this.markFailed(tempId);
        return EMPTY;
      }),
    )
    .subscribe(server => this.reconcile(tempId, server));
}
```

Nothing clever happened here. The send still sends. But `markFailed(tempId)` now exists and runs, so a dropped message goes grey with a retry affordance instead of sitting there pretending it was delivered — which is the one place the old "no error branch" version was actually, quietly wrong.

### Pass 4 — make uploadFile's stages explicit

This was the whole reason I started. `uploadFile` drove an S3 upload through a pre-signed URL, tracked progress, then waited on the backend to finish processing (thumbnailing, virus scan) before the attachment was usable. Three async phases, and the old code smeared them across boolean flags — `uploading`, `processing`, `done` — that could contradict each other. I'd seen the UI show a spinner *and* a checkmark once. Never could reproduce it. Of course I couldn't; it was a race between two independent booleans.

The fix wasn't more logic, it was collapsing three booleans into one `stage` field — the `UploadState.stage` union from Pass 1 — so the states are mutually exclusive by construction.

```ts
uploadFile(file: File): void {
  const tempId = uuid();
  this.setUpload({ tempId, file, stage: 'queued', progress: 0, url: null });

  this.signer.presign(file.name).pipe(
    tap(() => this.patchUpload(tempId, { stage: 'uploading' })),
    switchMap(({ url, key }) =>
      this.s3.put(url, file).pipe(
        tap(evt => {
          if (evt.type === HttpEventType.UploadProgress && evt.total) {
            this.patchUpload(tempId, {
              progress: Math.round((evt.loaded / evt.total) * 100),
            });
          }
        }),
        filter(evt => evt.type === HttpEventType.Response),
        map(() => key),
      ),
    ),
    tap(() => this.patchUpload(tempId, { stage: 'processing', progress: 100 })),
    switchMap(key => this.waitForProcessed(key)),   // polls until backend marks it ready
    takeUntilDestroyed(this.destroyRef),
    catchError(() => {
      this.patchUpload(tempId, { stage: 'error' });
      return EMPTY;
    }),
  ).subscribe(processedUrl => {
    this.patchUpload(tempId, { stage: 'done', url: processedUrl });
  });
}
```

Now the template reads `stage` and renders one thing. `@switch (upload.stage)`, four cases, done. The spinner-and-checkmark bug is gone because the UI can't even express it — there's no combination of values where both render. That's the move I keep coming back to: when a bug comes from two pieces of state disagreeing, the fix is usually to delete one of them.

## What I gave up

The store is still a single 430-line class. I trimmed it but I didn't decompose it into smaller stores, even though parts of it (uploads especially) want to be their own thing. Splitting it would have changed the public surface, and that was the one line I'd drawn. So there's a `// TODO: extract UploadStore` sitting at the top, and it'll stay there until uploads grow enough to justify breaking the API and re-verifying every call site. Today they don't.

I also didn't add the test suite this code is begging for. Same reason — scope. The refactor made the store testable (typed inputs, no hidden `any`, pure reconcile/promote functions I could call in isolation), which is honestly most of the value, but I shipped it on manual verification: send under flaky network, upload mid-conversation, kill the connection during processing. The tests are the next commit, not this one, and I'm aware that "next commit" is where good intentions go to die.

Here's the part that's easy to get wrong, and the reason I'm writing this down. The temptation with a file this ugly is to rewrite it, because rewriting *feels* like progress and editing someone else's mess (even past-you's mess) feels like janitorial work. But a rewrite throws away every accidental correctness the old code accumulated — every weird branch that's there because of a bug you fixed at 11pm and forgot. The `markFailed` gap and the spinner race were real, and I caught them precisely *because* I was reading the existing code line by line under a "don't change behavior" rule, not because I was writing fresh code that would've reintroduced its own new set of 11pm bugs. Legibility first. The cleverness can wait until you can see what you're doing.
