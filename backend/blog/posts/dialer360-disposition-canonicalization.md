---
title: "Canonicalizing third-party IDs: the Dialer360 disposition migration"
description: "Storing display names as identifiers breaks the day someone renames one. Moving to stable dispositionIds."
date: "2026-04-14"
updated: "2026-04-14"
kind: "deepdive"
category: "Architecture"
tags: ["integration", "api", "canonicalization"]
month: "2026-04"
repo: "backend"
author: "Sachal Chandio"
---

Someone on the Dialer360 side renamed a disposition from `Not Interested` to `Not Interested - DNC`. Reasonable thing to do. It broke three weeks of reporting on our end and nobody noticed until a campaign manager asked why "Not Interested" had flatlined to zero on the 9th of the month and a brand-new bucket had appeared out of nowhere.

The label hadn't disappeared. It had just stopped being the thing we keyed on, because we'd been keying on it. That was the whole mistake, and it was mine.

## What we were storing, and why it was wrong

Dialer360 is the predictive dialer our agents work in. When a call ends, the agent picks a disposition — `Sale`, `Callback`, `No Answer`, `Not Interested`, `Wrong Number`, a couple dozen of them per campaign. We pull those events into Telelinkz and map each one onto our internal call outcome so the CRM and the dialer agree on what happened.

The original integration did the obvious, lazy thing. It read the disposition's display name off the webhook payload and stored that string straight onto the call record, and our mapping table was keyed on the string too:

```ts
@Entity()
export class DispositionMapping {
  @PrimaryGeneratedColumn()
  id: number;

  // The Dialer360 disposition label, e.g. "Not Interested"
  @Column({ length: 191 })
  dialerLabel: string;          // <-- this was the join key. it should never have been.

  @Column({ type: 'enum', enum: CallOutcome })
  outcome: CallOutcome;
}
```

A label is not an identifier. I knew that abstractly. But the webhook payload led with the name, the name was human-readable, and a varchar join "worked" in every test I ran because in every test the label was stable. Display names are the most tempting fake ID there is — they look unique, they look meaningful, and they betray you the first time someone with edit access decides `No Answer` should really say `No Answer (machine)`.

The day that happened, our mapping for the old string went orphaned. New events carried the new label, matched nothing, and fell through to our default `UNKNOWN` outcome. No error. No exception. Just a silent reclassification of every call dispositioned that way, and a report that quietly lied.

## The ID was there the whole time

The annoying part: Dialer360 *does* assign every disposition a stable numeric `dispositionId`. It was sitting in the same payload I was already parsing. I'd been reading right past it because the name was easier to eyeball in logs.

```json
{
  "call_id": "8841220",
  "agent_id": "337",
  "disposition_id": "412",
  "disposition_name": "Not Interested - DNC",
  "campaign_id": "19",
  "call_ended_at": "2026-04-09T14:22:08Z"
}
```

`disposition_id` is the canonical key. `disposition_name` is a label for humans and nothing more. The rename had bumped the name and left `412` exactly where it was. If I'd keyed on `412` from day one, the rename would have been a no-op — the report keeps rolling up against the same id, and the new label just shows up in the UI next time we sync. So the migration wrote itself, in principle: make `dispositionId` the join key, demote `displayName` to a cosmetic column, and stop ever joining on a string a third party can edit.

In principle. The third party had some opinions.

## The obstacles Dialer360 threw at me

I wanted to backfill a clean catalog of every disposition per campaign so I had a complete source of truth before flipping the join. There's a `/dispositions` endpoint, so this should have been one call per campaign. It was not.

**The list endpoint is incomplete.** The `/dispositions` listing returns the *active* dispositions for a campaign. Dispositions that had been retired — including, of course, the old `Not Interested` before its rename — weren't in the list, but historical call rows still referenced their ids. So the authoritative list wasn't actually authoritative for anything older than "right now." I couldn't trust the endpoint to be the catalog.

**Auth is a query-string token with a short fuse.** Dialer360's API doesn't take a bearer header. It wants the API key as a `?token=` query param, and the token rotates. The first version of my backfill grabbed the token once at the top of the loop and reused it across all 19 campaigns; somewhere around campaign 12 every call started coming back `401`. So I moved token retrieval behind a small accessor that refetches lazily and caches in Redis with a TTL safely under the real expiry:

```ts
private async dialerToken(): Promise<string> {
  const cached = await this.redis.get('dialer360:token');
  if (cached) return cached;

  const token = await this.fetchFreshToken();
  // real expiry is ~15m; cache for 10 to leave a margin
  await this.redis.set('dialer360:token', token, 'EX', 600);
  return token;
}
```

**Responses are slow and occasionally just hang.** Per-campaign listing calls would mostly return in a second or two, then one would sit there for ninety seconds and never come back. No `connectTimeout` meant the whole backfill blocked on a single dead socket. I bounded every request and made the listing path tolerant of a campaign timing out rather than aborting the run:

```ts
const res = await firstValueFrom(
  this.http.get(url, { timeout: 15_000 }).pipe(
    retry({ count: 2, delay: 1_000 }),
    catchError((err) => {
      this.logger.warn(`disposition list failed for campaign ${campaignId}: ${err.message}`);
      return of({ data: { dispositions: [] } }); // skip, don't kill the run
    }),
  ),
);
```

**The data is flaky in small ways.** Ids arrive as strings (`"412"`, not `412`). The same disposition can appear under two campaigns with slightly different casing in the name. And a handful of legacy rows had a `disposition_id` of `"0"` or empty string — the dialer's way of saying "agent hung up without dispositioning." Treating `"0"` as a real id would have created a junk catalog entry that swallowed a chunk of traffic.

## The design: harvest, don't trust

Since the list endpoint couldn't give me a complete catalog, I stopped trying to fetch the truth and started *observing* it. The source of truth became a local table that we fill from two directions: whatever the list endpoint knows about now, plus every distinct `dispositionId` we've ever actually seen on a real call event. The webhooks already carry the id on every call. They are, collectively, a more complete census of live dispositions than the endpoint that claims to list them.

The catalog table:

```sql
CREATE TABLE dialer_disposition_catalog (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  campaignId    INT          NOT NULL,
  dispositionId INT          NOT NULL,  -- the canonical Dialer360 id
  displayName   VARCHAR(191) NOT NULL,  -- latest human label; cosmetic
  firstSeenAt   DATETIME     NOT NULL,
  lastSeenAt    DATETIME     NOT NULL,
  retired       TINYINT(1)   NOT NULL DEFAULT 0,
  UNIQUE KEY uq_campaign_disposition (campaignId, dispositionId)
);
```

The unique key is `(campaignId, dispositionId)` — never the name. `displayName` is `UPDATE`-on-conflict, so when the rename comes through, the row for `(19, 412)` keeps its identity and just refreshes its label. `retired` flips on when a disposition drops out of the active list but only after we've seen it; we never delete catalog rows, because historical calls still point at them.

The harvest is a GraphQL mutation an admin can fire, and it's also wired to a nightly BullMQ job. It does an upsert per observed id:

```ts
async syncDispositionCatalog(campaignId: number): Promise<SyncResult> {
  const fromApi = await this.fetchActiveDispositions(campaignId);   // may be partial
  const fromCalls = await this.distinctSeenDispositionIds(campaignId); // census from real events
  const merged = this.merge(fromApi, fromCalls);

  let inserted = 0, updated = 0;
  for (const d of merged) {
    if (!d.dispositionId || d.dispositionId === 0) continue;  // drop the "0" / hangup sentinel

    const result = await this.repo
      .createQueryBuilder()
      .insert()
      .into(DialerDispositionCatalog)
      .values({
        campaignId,
        dispositionId: d.dispositionId,
        displayName: d.displayName?.trim() || `disposition ${d.dispositionId}`,
        firstSeenAt: () => 'NOW()',
        lastSeenAt: () => 'NOW()',
        retired: d.activeInApi ? 0 : 1,
      })
      .orUpdate(['displayName', 'lastSeenAt', 'retired'], ['campaignId', 'dispositionId'])
      .execute();

    result.raw.affectedRows === 1 ? inserted++ : updated++;
  }
  return { campaignId, inserted, updated };
}
```

`distinctSeenDispositionIds` is the part that makes this resilient. It's a plain `SELECT DISTINCT disposition_id` over the raw call-event table, and it surfaces ids the API has long since forgotten. The retired `Not Interested` showed up here even though `/dispositions` no longer listed it, so the catalog covered it and the historical join held.

With the catalog in place, the mapping table moved off the string:

```ts
@Entity()
@Unique(['campaignId', 'dispositionId'])
export class DispositionMapping {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  campaignId: number;

  @Column()
  dispositionId: number;       // canonical, stable, what we actually join on

  @Column({ type: 'enum', enum: CallOutcome })
  outcome: CallOutcome;
}
```

The display name lives only in the catalog now, fetched for the UI by joining `dispositionId`, never compared as a key. The call ingestion path reads `disposition_id` off the webhook, coerces it to an int, looks up the outcome by `(campaignId, dispositionId)`, and only stores the name for display.

## Migrating the existing rows without a string graveyard

The live data was the awkward part. Every historical call had a `dialerLabel` string and no id. I couldn't synthesize the ids — but I could *recover* most of them, because the same labels appeared in the call-event payloads where the id was also present. So the data migration was a join: for each distinct `(campaignId, label)` on old call rows, find the `dispositionId` the catalog had harvested for that label, and stamp it on.

I generated the migration through the TypeORM CLI rather than hand-writing it, then added the backfill as a follow-up data step I could run, review, and re-run idempotently. A few hundred labels matched nothing — campaigns long deleted, typos in names from years back. Those I left pointed at a single explicit `dispositionId = -1` "unresolved legacy" catalog row rather than scattering them into `UNKNOWN`, so they're countable and quarantined instead of silently blended into a real bucket.

## How I verified it

Three checks, in order of how much I trusted them.

First, a reconciliation count. Before the cutover I snapshotted the outcome distribution for the trailing 30 days under the old string join. After backfilling ids, I recomputed the same distribution under the id join and diffed them. They had to match within the few hundred legacy-unresolved rows I'd deliberately quarantined — and they did, off by exactly the count I'd parked in `-1`.

Second, the rename test, which is the entire point of the change. On staging I renamed a disposition in Dialer360, fired a call event for it, and confirmed two things: the call still resolved to the correct outcome (because it joined on `412`, untouched), and the catalog's `displayName` for `(19, 412)` updated to the new label on the next sync. Under the old design that sequence produced an `UNKNOWN`. Under the new one it produced nothing — which is exactly what you want from a rename. It's cosmetic, so it should be a non-event.

Third, I let the nightly sync run for a week and watched the `inserted` counts. They should trend to roughly zero once the catalog is complete; a non-zero insert means a genuinely new disposition appeared, which is a signal worth seeing rather than noise. One morning it inserted two — a campaign manager had added dispositions the day before. The catalog caught them without anyone touching code, which is the behavior I was actually buying.

## The lesson I'd staple to the next integration

When you pull data from a system you don't control, find its canonical key on day one and store *that*, even if the human-readable field is right there looking like a perfectly good identifier. Display names, codes, slugs, anything an admin can edit in a settings screen — those are labels, and labels drift. The id is the contract; the name is a courtesy.

And the bit I underrated: don't assume the vendor's "list everything" endpoint is complete. Dialer360's wasn't, because it only listed what was active, and "active" is a moving target while your historical data is not. The cheapest source of truth for which ids really exist was the stream of events I was already receiving — every webhook was a vote for an id being real. Harvesting observed ids into a local catalog turned a brittle dependency on a half-honest endpoint into something I owned and could reconcile. The next time a vendor hands me a list and swears it's everything, I'm going to keep my own census anyway.
