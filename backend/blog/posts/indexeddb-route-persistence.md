---
title: "Persisting form state to IndexedDB on route deactivation"
description: "Text that didn't reload, a tab that forgot itself, data lost on navigation. Lifecycle bugs and IndexedDB."
date: "2024-11-26"
updated: "2024-11-26"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "indexeddb", "lifecycle"]
month: "2024-11"
repo: "frontend"
author: "Sachal Chandio"
---

A sales lead pinged me with three screenshots and a sentence: "the form keeps eating my notes." That was the whole bug report. It took me the better part of a day to learn that those three screenshots were actually three different bugs wearing the same coat.

The feature is a lead workspace in the Telelinkz CRM. An agent opens a lead, there's a tabbed panel — Notes, Call Outcome, Follow-up — and a big reactive form per tab. Agents bounce between leads constantly. Click a lead in the list, the route changes to `/leads/:id`, fill in some notes, jump to another lead because the phone rang, come back. The expectation is obvious: the workspace should look exactly like you left it.

It did not.

## Three symptoms, one coat

Once I sat with the lead's actual workflow instead of my own, the single complaint split apart:

1. The Notes textarea came back **empty** after navigating away and back, even though the agent had typed into it.
2. The panel always reopened on the **first tab**, never the tab the agent was last looking at.
3. Sometimes — not always — the form data was just **gone**, even within the same session, no reload involved.

Symptom three is the one that made me nervous, because "sometimes" is the word that means "race condition" until proven otherwise.

## The wrong guess: blame the cache

My first instinct was that this was a data-layer problem. We use Apollo for GraphQL, and the lead detail query is cached. So my theory was: the form binds to the cached lead, the agent edits the form, but those edits never write back to Apollo, so on revisit Apollo hands us the stale server copy and the local edits evaporate.

Clean theory. Wrong.

I spent an hour adding `cache.writeFragment` calls to push form edits back into the Apollo cache on every `valueChanges`. It did nothing for symptom one. The textarea still came back empty. And it couldn't explain symptom two at all — the active tab isn't server data, it never goes near GraphQL.

The thing that snapped me out of it was a `console.log` in the component constructor. I navigated away and back and saw the constructor fire **again**. Of course it did. With Angular's default route reuse, navigating from `/leads/42` to `/leads/99` and back destroys and recreates the component. The form wasn't holding stale data. The form, and the component instance that owned it, simply no longer existed. There was nothing to write back to.

I was debugging the data layer. The bug was in the lifecycle.

## Where the state actually lived

Here's the shape of the original component, trimmed to the part that matters:

```ts
@Component({ /* ... */ })
export class LeadWorkspaceComponent implements OnInit {
  activeTab = 0;
  form = this.fb.group({
    notes: [''],
    callOutcome: [''],
    followUpAt: [null as Date | null],
  });

  constructor(private fb: FormBuilder, private leads: LeadsService) {}

  ngOnInit() {
    const id = this.route.snapshot.paramMap.get('id')!;
    this.leads.getLead(id).subscribe(lead => {
      this.form.patchValue({ notes: lead.notes /* ... */ });
    });
  }
}
```

Every piece of unsaved state — the form value, `activeTab` — lived on the component instance. When Angular tore the component down, all of it went with it. The "sometimes it's gone within a session" symptom was the same root cause: any navigation, even a quick one, destroyed the instance. It only felt intermittent because agents didn't always navigate before they hit save.

The server-backed save existed, but it was an explicit button. Half-typed notes were never meant to be persisted to the backend — and honestly, you don't want every keystroke of draft text hitting MySQL. This is local, per-user, throwaway-ish draft state. It belongs on the client.

`localStorage` was the obvious reach. I didn't take it. The notes field can hold call transcripts that run to a few KB, agents keep dozens of leads in flight, and `localStorage` is synchronous and string-only — every write blocks the main thread while you `JSON.stringify` the whole form. IndexedDB is async, structured, and made for exactly this: keyed records you can write without serializing by hand and without janking the UI.

## Persist on the way out

The right lifecycle hook for "save before this instance dies" isn't `ngOnDestroy` — well, it is, but for route components I prefer the router's `CanDeactivate` guard, because it runs *before* navigation commits and gives me a clean async seam. I used a small `idb`-style wrapper around IndexedDB; the raw API works too, it's just verbose.

The store key is the lead id, so each lead gets its own draft record:

```ts
interface LeadDraft {
  leadId: string;
  form: { notes: string; callOutcome: string; followUpAt: string | null };
  activeTab: number;
  savedAt: number;
}

@Injectable({ providedIn: 'root' })
export class LeadDraftStore {
  private dbPromise = openDB('telelinkz', 1, {
    upgrade(db) {
      db.createObjectStore('leadDrafts', { keyPath: 'leadId' });
    },
  });

  async put(draft: LeadDraft) {
    const db = await this.dbPromise;
    await db.put('leadDrafts', draft);
  }

  async get(leadId: string): Promise<LeadDraft | undefined> {
    const db = await this.dbPromise;
    return db.get('leadDrafts', leadId);
  }

  async clear(leadId: string) {
    const db = await this.dbPromise;
    await db.delete('leadDrafts', leadId);
  }
}
```

The component now writes its draft when the route is leaving, and — crucially — captures `activeTab` in the same record:

```ts
export class LeadWorkspaceComponent implements OnInit {
  activeTab = 0;
  form = this.fb.group({ /* ... */ });
  private leadId!: string;

  constructor(
    private fb: FormBuilder,
    private leads: LeadsService,
    private drafts: LeadDraftStore,
    private route: ActivatedRoute,
  ) {}

  async ngOnInit() {
    this.leadId = this.route.snapshot.paramMap.get('id')!;

    const draft = await this.drafts.get(this.leadId);
    if (draft) {
      this.form.patchValue(draft.form, { emitEvent: false });
      this.activeTab = draft.activeTab;
      return; // restored a draft; don't clobber it with the server copy
    }

    this.leads.getLead(this.leadId).subscribe(lead => {
      this.form.patchValue({ notes: lead.notes /* ... */ }, { emitEvent: false });
    });
  }

  // Called by the CanDeactivate guard
  async persist() {
    await this.drafts.put({
      leadId: this.leadId,
      form: this.form.getRawValue() as LeadDraft['form'],
      activeTab: this.activeTab,
      savedAt: Date.now(),
    });
  }
}
```

And the guard, which is the whole reason `persist()` reliably runs before teardown:

```ts
export const persistLeadDraft: CanDeactivateFn<LeadWorkspaceComponent> =
  async (component) => {
    await component.persist();
    return true; // never block navigation, just persist on the way out
  };
```

Wire it into the route:

```ts
{
  path: 'leads/:id',
  component: LeadWorkspaceComponent,
  canDeactivate: [persistLeadDraft],
}
```

When the agent hits the real Save button and the mutation succeeds, I call `drafts.clear(leadId)` so the next visit pulls the canonical server copy. That cleanup is not optional — skip it and you've built a cache that never invalidates, which is its own bug filed under a nicer name.

## The two details that actually bit me

The async hooks are easy to write and easy to get subtly wrong. Two things cost me real time.

**`patchValue` fires `valueChanges`.** My first restore version triggered the form's `valueChanges` subscription, which I'd wired to a "dirty" indicator and an autosave debounce. Restoring a draft instantly marked the form dirty and kicked off a save of the thing I'd just loaded. Passing `{ emitEvent: false }` on every restoring `patchValue` fixed it. If you autosave on `valueChanges`, hydration must not look like user input.

**The await ordering.** I almost wrote `ngOnInit` so that the server fetch and the draft read raced — fetch fires, draft read resolves a tick later, and whichever wins last sets the form. That's symptom three reincarnated as a brand-new race. The fix is the boring sequential one above: `await` the draft, and if it exists, `return` before you ever touch the network. The draft is the source of truth for unsaved work, full stop. The server copy only matters when there's no draft.

The tab fix turned out to be free once the persistence was real. `activeTab` was always just a number on the component; the only reason it forgot itself was that the component forgot itself. Put it in the same IndexedDB record and it rides along.

## When this bites

The general lesson is one I keep relearning: **any state that lives only on a component instance is one navigation away from gone**, and route components get destroyed far more often than people expect. The moment you decide a value should survive a route change, you've signed up to put it somewhere that outlives the component — a service, the URL, or persistent storage — and to pick a lifecycle moment to write it and another to read it back.

Async storage on top of that adds a second trap. Lifecycle hooks are happy to run your reads and writes out of order with everything else that's racing during a navigation — a fetch, a resolver, a debounced save. If you don't make the ordering explicit with `await` and a clear "who wins" rule, you get a bug that's only reproducible on a slow connection or a slow Tuesday.

So: if a component holds anything a user would be annoyed to lose, ask where it goes when the component dies, and ask what happens if storage answers a beat late. I didn't ask either question the first time. The form ate the notes, and the lead was right to complain.
