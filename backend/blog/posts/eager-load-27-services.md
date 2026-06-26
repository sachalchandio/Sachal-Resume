---
title: "Eager-loading relations across 27 sale services to stop an N+1 at serialization"
description: "Lazy relations looked fine until GraphQL serialized them. Adding relations to every findById across 27 providers."
date: "2026-04-07"
updated: "2026-04-07"
kind: "deepdive"
category: "Performance"
tags: ["nestjs", "typeorm", "graphql", "n-plus-1"]
month: "2026-04"
repo: "backend"
author: "Sachal Chandio"
---

The query came back instantly. The response took two seconds. That gap is where this bug lived, and it took me longer than I'd like to admit to look in the right place.

A rep opens the sales grid for ADT. The frontend fires a paginated GraphQL query, gets back fifty rows, and renders a table with the agent name, the fronter name, the package, the order date. Nothing exotic. But the page hitched on every load, and the API logs told a story I almost dismissed: the `findSalesWithComplexFilter` query was fast — one `getManyAndCount`, joined and indexed, done in single-digit milliseconds. Then, after it returned, a wall of follow-up selects:

```sql
SELECT * FROM user WHERE id = ? LIMIT 1;
SELECT * FROM user WHERE id = ? LIMIT 1;
SELECT * FROM package_version WHERE id = ? LIMIT 1;
SELECT * FROM user WHERE id = ? LIMIT 1;
...
```

Fifty rows, three or four relations each, one query per relation per row. The list query was clean. The serialization of its result was not.

## Why it didn't show up where I looked first

My first instinct was wrong, and it's worth saying why, because the wrong instinct is the common one. I assumed the N+1 was in the query builder. So I went and stared at `findSalesWithComplexFilterADT`, which builds a `createQueryBuilder('sale')` with `leftJoinAndSelect` for agent and fronter, and it was fine. The joins were there. The data came back hydrated.

The problem was everywhere *except* the list endpoint.

Telelinkz has 27 provider sale services — `adt-sale`, `xfinity-sale`, `spectrum-sale`, `frontier-sale`, on down the alphabet, each a table of its own (`adt_sale`, `xfinity_sale`, and so on) because every carrier has a different sale shape. They share a skeleton. Each has a `findByIdProvider` method, a create that returns the freshly-saved row, an update that does the same. And those single-record methods were the leak. Here's the ADT version, which was representative:

```ts
async findByIdADT(id: string): Promise<ADTSale> {
  const sale = await this.adtSaleRepository.findOne({
    where: { id },
    // relations: omitted
  });
  if (!sale) {
    throw new Error(`Sale with ID ${id} not found`);
  }
  return sale;
}
```

No `relations`. The entity comes back with `agentId` and `fronterId` populated as raw foreign-key columns, but `agent` and `fronter` are undefined object properties. And in isolation that looked harmless, because nothing in the service touched `sale.agent`. The service just returned the row.

The thing that touched `sale.agent` was GraphQL.

## The serialization trap

Look at the entity. The relations are plain `@ManyToOne`, and the GraphQL `@Field` on the agent is non-nullable:

```ts
@Field((type) => User, { description: 'Agent for the sale' })
@ManyToOne(() => User, (user) => user.adt_sale, { nullable: false })
@JoinColumn({ name: 'agentId', foreignKeyConstraintName: 'FK_adt_sale_agentId' })
agent: User;

@Field((type) => User, { description: 'The user who fronted the sale', nullable: true })
@ManyToOne(() => User, (user) => user.adt_sale, { nullable: true })
@JoinColumn({ name: 'fronterId', foreignKeyConstraintName: 'FK_adt_sale_fronterId' })
fronter: User;
```

When `@nestjs/graphql` serializes the response, it walks the selection set. The client asked for `agent { name }`. Apollo resolves `agent` against the returned entity, finds the property unhydrated, and — because there's a relation defined and the field is non-null — something has to go fetch a `User`. With a non-nullable field, Apollo can't just hand back `null`; it has to produce a `User` or blow up the whole row. So a query fires. Per row.

That's the part that fooled me. There was no explicit lazy relation in the codebase — no `Promise<User>`-typed property, no `lazy: true`. I'd have caught that on sight. This was lazier than lazy: the load was being triggered by the GraphQL layer reaching for a field the persistence layer never filled in, one row at a time, after the database had already said it was done.

The list endpoint hid it because the query builder eager-joined agent and fronter. But the moment any code path went through `findById` — opening a single sale, the optimistic refetch after a create, the update mutation returning the edited row — the relation was empty and the resolver paid for it. And several screens fetch a sale by id and then render a card with the agent, the fronter, the package, and the portal. Four relations, four extra round trips, on a single-record fetch that should have been one query.

## What I considered, and what I rejected

Three options.

**Mark the relations `eager: true` on the entity.** One line per relation, TypeORM auto-joins them on every `find`. Tempting. I rejected it. `eager: true` is a global decision made in the wrong place — it means every query that touches `adt_sale`, including aggregations and the salary-generation batch job that only wants ids and amounts, drags in two `user` joins and a `package_version` join whether it needs them or not. I'd already spent a week earlier in the year killing an N+1 in salary generation by being *more* surgical about what got loaded, not less. Turning on eager loading everywhere would have undone that. Eager relations are a sledgehammer; you reach for them when you genuinely want the relation every single time, and that wasn't true here.

**Add `@ResolveField` resolvers backed by a DataLoader.** This is the textbook GraphQL answer: don't join in the service, resolve each relation in the resolver, batch the loads per request so fifty rows become one `WHERE id IN (...)`. It's the right long-term shape. It's also 27 services × multiple relations of new resolver code, a DataLoader registered per request in the context, and a meaningful testing surface, to fix a bug that was actively slowing down production *today*. I wasn't going to ship a framework to plug a leak.

**Just add `relations` to every `findById`.** Boring. Explicit. Each single-record method names exactly the relations its callers render. The query builder paths already join what they need; this only touches the by-id reads.

I took the boring one.

## The change

For ADT, the fix was the line that was missing:

```ts
async findByIdADT(id: string): Promise<ADTSale> {
  const sale = await this.adtSaleRepository.findOne({
    where: { id },
    relations: ['agent', 'fronter', 'installationPackage', 'providerPortal'],
  });
  if (!sale) {
    throw new Error(`Sale with ID ${id} not found`);
  }
  return sale;
}
```

`findOne` with named relations issues one statement with left joins — the agent, the fronter, the package version, the provider portal, all hydrated before the entity leaves the repository. By the time GraphQL serializes it, every `@Field` it reaches for is already populated, so the resolver never falls through to a per-field fetch. Four queries collapse to one.

Then I did it 26 more times. Each provider got the relations its own entity and its own screens actually use — most carriers have `agent`, `fronter`, and a package; some have a `providerPortal`; the satellite and solar ones carry extra fields. I didn't paste a blanket list. The point of choosing explicit relations over `eager: true` is that they're local and honest about what the call needs, and a copy-paste blanket would have thrown that away. Where a create or update returned the saved row by re-reading it, I routed it through the now-fixed `findById` so the mutation response came back hydrated too:

```ts
const saved = await this.adtSaleRepository.save(sale);
return this.findByIdADT(saved.id); // hydrated, single query
```

After the sweep, the by-id fetch that had been firing five queries fired one. The single-sale view stopped hitching. The mutation responses came back whole instead of triggering a little storm of `SELECT * FROM user` on their way out.

## The tradeoffs I accepted, and the part that'll bite

This is not the clever fix and I want to be honest that I know that. The DataLoader approach is strictly better at scale — if a future endpoint returns five hundred sales each with an agent, my joined `findById` is fine (it's one record) but a list path that forgot its joins would still N+1, and DataLoader would catch it generically. I traded the general solution for the specific one because the specific one was correct, reviewable, and shippable in an afternoon.

The real cost is maintenance, and it's a real cost. The relations list is now duplicated knowledge: the entity declares the relations, and each `findById` re-declares which ones to load, and those two can drift. Add a `salesAgent` relation to a provider entity, expose it as a non-null `@Field`, forget to add it to that provider's `findById`, and you've reintroduced exactly this bug for exactly that field — silently, because it'll work in tests that don't assert query counts and only show up as a slow card in production. There's no compiler error for "this relation will be lazy-loaded by the serializer." TypeScript is perfectly happy; the property is typed `User`, and at runtime it's just `undefined` until something asks.

If I were doing it again from scratch I'd still start here, because correct-and-shippable beats elegant-and-pending. But I'd add the one thing that would have caught it for me in the first place: a test that counts queries. Wrap the repository, fetch a sale by id through the resolver, and assert the query count is one. That's the guardrail that turns "remember to add the relation" into "the build goes red if you don't." I haven't written it yet across all 27. When the 28th provider gets onboarded and someone forgets a relation, that's the day I'll wish I had.
