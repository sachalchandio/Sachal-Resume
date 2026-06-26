---
title: "What two years of commits taught me about shipping"
description: "Stepping back from 3,000 commits across two repos to see the patterns in how a real product actually got built."
date: "2026-06-04"
updated: "2026-06-04"
kind: "deepdive"
category: "Architecture"
tags: ["career", "engineering", "reflection"]
month: "2026-06"
repo: "both"
author: "Sachal Chandio"
---

I ran `git log --oneline | wc -l` on both Telelinkz repos last week. 1,071 on the backend, 3,115 on the Angular app. A little over 4,000 commits across two years of building a CRM for telecom sales teams — closers, fronters, billing, QA, salary runs, the whole machine.

Then I read them. Start to finish. Not to feel nostalgic — to find out whether the way I *think* I build software matches the way I actually built it. The commit log doesn't lie the way memory does. It has timestamps and it has the messages you wrote at 2am, like `aa757a1 altafiber enums created` and the legendary `9a27492 .`.

Here's the thesis the log handed me: **the work that makes a feature real is almost never the part you'd put on a slide.** Foundations come before features whether you plan them or not, the same three bugs keep coming back wearing new clothes, and the difference between a senior engineer and a junior one is mostly knowing which unglamorous wiring to do *first*.

## Foundations come due, with interest

The earliest backend commits are a confession. `f54cfff basic backend up and running`, then `680eba5 telelinkz working adding new entities and creating relations`, then almost immediately `b4024df need to create relations between all entities`. I was building entities before I understood the domain. Of course I was — you can't understand the domain until you've modeled it wrong a few times.

The tell is `a16cddc wrong names for saleStage fixed but db sync error persists`. TypeORM's `synchronize: true` was on, I'd named a column wrong, and the schema diff wouldn't converge. The very next commit is the real lesson:

```
fa753bd salestage and comment to have polymorphic relation instead of a hard foreign key reference
```

I'd hardwired a foreign key from `sale_stage` to a single sale type. But Telelinkz doesn't have *a* sale — it has Xfinity sales, DishTV sales, AltaFiber, Blazing Hog, and eventually a whole no-code provider builder. A `comment` or a `sale_stage` needs to attach to any of them. The hard FK was a foundation poured in the wrong place, and every feature I built on top of it would have cracked.

So I went polymorphic: an `ownerType` discriminator plus an `ownerId`, no database-level FK, integrity enforced in the service layer instead.

```ts
@Entity()
export class SaleStage {
  @Column({ type: 'enum', enum: SaleOwnerType })
  ownerType: SaleOwnerType; // XFINITY | DISHTV | ALTAFIBER | DYNAMIC

  @Column()
  ownerId: string; // no FK — resolved per ownerType in the service
}
```

That decision in week three is why, two years later, `6c02a97 Introduce dynamic provider forms & sales` and `dfd2466 Add Provider Table Builder & Dynamic Sales` were even possible. A no-code provider has no compile-time table to point a foreign key at. Past-me, flailing with a sync error, accidentally bought future-me the ability to ship a feature he hadn't imagined yet.

The flip side: I paid for the foundations I *skipped*. Authentication and authorization show up embarrassingly late. The role work clusters in a run of commits — `4fabc79 Resolver Permission Added`, `2a38bfe permissions not workign for shared users`, `b43d9cc BILLING_MANAGER and MARKETING_MANAGER permissions added`, and on and on, `VMA_MANAGER`, `BILLING_MANAGER`, `MARKETING_MANAGER`, each bolted onto resolvers one at a time. Because I didn't design the permission model up front, I added roles reactively, and `d311361 Scope resources by current user & roles` had to retrofit user-scoping across resolvers that were originally written assuming everyone could see everything.

Scoping-after-the-fact is the most expensive refactor I did on this project, full stop. Every query that returned "all sales" had to become "sales this user is allowed to see," and getting that wrong is a data leak, not a bug.

## The same bug, in new clothes

Read enough `fix:` commits in a row and you stop seeing individual bugs. You start seeing *species*.

Species one: **date and timezone serialization.** `dda735b websocket date serialzzation issue fixed`. A `Date` went over a WebSocket, got JSON-stringified to UTC, and the Angular side rendered it a day off for anyone west of London. MySQL `DATETIME` has no timezone; the JS `Date` does; the boundary between them is where this bug lives, and it kept coming back every time I added a new transport. Eventually I stopped passing `Date` objects across boundaries at all and standardized on ISO strings serialized at one chokepoint, but I learned that the hard way, one off-by-one-day report at a time.

Species two: **state that lives in two places at once.** My favorite commit message in the entire repo is a full paragraph:

```
65748df To address uncertainty, I fixed running-state detection so it checks
        Bull queue jobs as well (not just Redis lock)
```

A long-running job's "am I running?" check looked at a Redis lock. But the job also lived in a Bull queue. The lock could be gone while the job was still queued, or the reverse, so the UI would show "idle" for something that was very much not idle. The real bug wasn't the check — it was that I had two sources of truth for one fact and trusted whichever one I happened to query. Same disease as `92bf34a task pubsub assigned to and assigned by fixed`: the assignment lived in the entity *and* in the pub/sub payload, and they drifted.

Species three: **derived data computed on the hot path.** Look at this one — the comment is the whole confession:

```
93df739 categories count issue fixed - But this being calculated on the run
        which is not very performance effficient
```

I fixed the count, knew exactly why the fix was slow, and shipped it anyway because the feature had to go out. That's not a failure. That's the job. But it's a debt, and the log shows me paying it down later with `4ac9e92` / `4cc277e` / `800a8d1` — scoped, cached distribution queries backed by a covering index:

```
4cc277e Sales provider distribution: scoped+cached query, providerCode, covering index
800a8d1 Call Logs dashboard: scoped+cached state distribution & potential logs
```

The pattern in those late commits is identical and it's the pattern I wish I'd had a name for at commit one: **scope it, cache it, index it for the exact shape of the query.** A dashboard aggregate is `WHERE user/role scope → GROUP BY → cache in Redis with a sane TTL → covering index so MySQL never touches the row data.** Once that pattern clicked, every dashboard widget became the same three moves instead of a fresh adventure.

## The unglamorous wiring is the feature

This is the one I'd tattoo on commit one if I could. When a stakeholder asks for "add AltaFiber as a provider," the satisfying part — modeling the AltaFiber sale — is maybe 10% of the work. The log shows the other 90%, and it's all plumbing:

```
e07dcf0 altafiber is created
aa757a1 altafiber enums created
57f47dd Wire AltaFiber into shared provider subsystems
ea2d155 AltaFiber: register in commission/PSU/stats + add provider seed + package SQL
ce33838 added altaFiber to Salary Generation
7a467b7 AltaFiber: include alta_fiber_sale in PII anonymization table list
```

A new provider isn't real when its entity exists. It's real when it's wired into commission calculation, PSU stats, the salary generation run, the package seed data, *and* the PII anonymization table list so we don't leak customer data when we export. That last commit — adding `alta_fiber_sale` to the anonymization list — is the kind of thing nobody asks for and everyone assumes is already done. It's invisible until it's a breach.

I count six commits to make one provider "real," and only two of them touch the thing a non-engineer would call "AltaFiber." If you scope a feature by its happy path, you will be wrong by roughly 5x. The commit history says so, with a straight face, every single time.

The same shape shows up in the queue work. `710ebdc Refactor sale queuing and targeted index re-sync` and `d8ae2c6 File manager: register files via queue, pin, index` — a file isn't "uploaded" when it hits S3. It's uploaded when a Bull job has registered it, pinned it, and pushed it into the search index. The user sees "upload complete." Three subsystems had to agree for that to be true.

## Where this advice is wrong

I don't want to hand you four rules and pretend they're laws. They bite back.

**"Foundations first" curdles into never shipping.** If I'd designed the perfect polymorphic permission-scoped multi-provider schema before writing a feature, Telelinkz would not exist. The `synchronize: true` era was *sloppy* and it was also the only reason I learned the domain fast enough to model it right later. You earn the right to good foundations by building bad ones quickly and feeling the pain. There's a window — usually right when a hack starts causing the *second* bug — where stopping to fix the foundation pays off. Before that window you're gold-plating; after it you're in debt. Reading the log, I was mostly late, occasionally early, rarely on time.

**"Cache it" is how you create species-two bugs.** Every cache I added to fix `93df739`-style slowness became a new place for state to live, which is exactly the disease behind the Redis-lock-vs-Bull-queue bug. Caching trades a performance problem for a consistency problem. Sometimes that's the right trade. When the data is a dashboard count that can be five seconds stale, absolutely. When it's "is this job running," a stale cache is worse than a slow query, and I shipped that mistake before I understood the difference.

And the no-code provider builder I'm so pleased with? It let non-engineers add providers, which is the dream — until you realize every dynamic provider still needs hand-written wiring into commission, salary, and PII anonymization. The schema went no-code. The *consequences* of a new provider stayed very much code. I traded one kind of work for a subtler kind, and the slide deck version of "no-code providers" hides that completely.

## What I'd tell myself at commit one

Not a summary. Just the things the log actually proved, that I'd hand to past-me on an index card:

- Model the discriminator before the foreign key. The thing you think is one type is three types you haven't met yet. `fa753bd` was the most valuable accident I made.
- Decide who can see a row *before* you write the query that returns rows. Retrofitting scope is the worst refactor and the one with a security blast radius.
- When you ship the slow-but-correct version on purpose, write the reason in the commit message like I did in `93df739`. Future-you needs to know it was a choice, not an oversight.
- Pick one boundary to serialize dates and never let a `Date` object cross a wire raw. You will reintroduce the timezone bug at every new transport otherwise.
- One fact, one source of truth. If "is it running" can be answered two ways, you have a bug already; you just haven't hit it yet.
- Scope what a feature *touches*, not what it's *about*. Six commits for one provider. Plan for the six.

The honest takeaway is smaller than any of those, though. Two years of commits don't show a master plan unfolding. They show someone building the wrong thing fast, feeling exactly where it hurt, and fixing that specific spot — over and over, 4,000 times. The skill isn't avoiding the bad first version. It's reading your own pain accurately enough to know which foundation to fix next.
