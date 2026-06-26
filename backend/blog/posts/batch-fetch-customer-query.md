---
title: "Cutting a heavy customer query down by batch-fetching"
description: "A query that fanned out per customer was the dashboard's slowest path. Batching it and moving sort off SQL."
date: "2025-10-19"
updated: "2025-10-19"
kind: "deepdive"
category: "Performance"
tags: ["mysql", "nestjs", "performance"]
month: "2025-10"
repo: "backend"
author: "Sachal Chandio"
---

The agent dashboard loads a list of interested customers. Ten per page, nothing exotic. It was taking close to two seconds for a manager who could see every row in the table, and the slow-query log made it obvious why: one list request was firing somewhere north of a dozen separate `SELECT`s. The list query, then one extra query per customer on the page, plus a sort MySQL was doing on an expression it had no index for.

This is the classic N+1, except I'd built it so casually I didn't recognize it as one. The fan-out wasn't an explicit loop anywhere. It was a GraphQL field resolver doing its job.

## Where the queries were coming from

`InterestedCustomer` is a TypeORM entity, and it exposes a threaded discussion as a GraphQL field. The naive version — the one that shipped — resolved that field with a repository call right on the entity:

```ts
@ObjectType()
@Entity()
export class InterestedCustomer extends BaseEntity {
  // ...columns...

  @Field(() => [Comment], { nullable: true })
  async discussionThread(): Promise<Comment[]> {
    const commentRepository = getRepository(Comment);
    return commentRepository.find({
      where: { saleId: this.id, saleType: SaleType.CALL_LOG },
    });
  }
}
```

`getRepository` inside an entity method is its own smell, but leave that. The real problem is `this.id`. Apollo resolves fields per object. Ask for `discussionThread` on a page of ten customers and this runs ten times — ten round trips to MySQL, each one a `WHERE saleId = ? AND saleType = ?`. The frontend's customer-list query asks for the discussion thread so it can show a comment count badge. So every list render paid for it.

The list query itself was `findPaginatedByUser`, which is a plain `findAndCount`:

```ts
const [items, total] = await this.interestedCustomerRepository.findAndCount({
  where: whereCondition,
  take: limit,
  skip: offset,
  order: { createdAt: 'DESC' },
  relations: ['user'],
});
```

That part is fine. `order: { createdAt: 'DESC' }` is a column sort, indexable. The expensive sort wasn't here — it was in a sibling path that listed customers by "most recently active," where activity meant the latest comment timestamp. That one was ordering on a correlated subquery, a `MAX(comment.createdAt)` per row, with no index that covered it. MySQL was materializing the whole set, computing the max for each, and sorting in a filesort. On a few hundred rows you don't notice. We were past a few thousand.

## The constraints I was actually under

I couldn't change the GraphQL contract. The frontend (Angular, Apollo) was already in production querying `discussionThread` on the list, and I wasn't going to coordinate a deploy across both repos to fix one slow query. So whatever I did had to keep the same field shape.

I also didn't want to reach for DataLoader yet. It's the textbook answer to N+1 in GraphQL and it's a good answer, but it's a dependency and a pattern the rest of the codebase wasn't using. For a single field on a single list, wiring up a request-scoped loader felt like bringing a forklift to move one box. I wanted to see how far plain batching got me first.

And the database is a shared AWS RDS MySQL instance that other teams hit. Anything I added to schema — indexes especially — had to be cheap to maintain on writes, because the customers table takes a steady stream of inserts from agents logging calls all day.

## Batching the discussion fetch

The move is boring and it works: stop resolving the field per row, resolve it for the whole page in one query, hand each row its slice.

I pulled the discussion off the entity method and into the service, where I had the full page of customers in hand. One `IN` query instead of ten point lookups:

```ts
async attachDiscussionCounts(
  customers: InterestedCustomer[],
): Promise<Map<string, number>> {
  if (customers.length === 0) return new Map();

  const ids = customers.map((c) => c.id);

  const rows = await this.commentRepository
    .createQueryBuilder('comment')
    .select('comment.saleId', 'saleId')
    .addSelect('COUNT(*)', 'count')
    .where('comment.saleId IN (:...ids)', { ids })
    .andWhere('comment.saleType = :type', { type: SaleType.CALL_LOG })
    .groupBy('comment.saleId')
    .getRawMany<{ saleId: string; count: string }>();

  return new Map(rows.map((r) => [r.saleId, Number(r.count)]));
}
```

The list resolver now calls this once, builds the map, and the per-row field resolver just reads from it. Ten round trips collapse to one. And since the badge only needed a count, I stopped hydrating full `Comment` entities entirely — `COUNT(*) ... GROUP BY saleId` returns one small row per customer instead of every comment body and its columns. That alone was most of the win on the wire.

The `IN (:...ids)` clause hits the existing index on `comment.saleId`, so the single query is a cheap index range scan. I checked it under `EXPLAIN` to be sure it wasn't quietly doing a full table scan on the comments table, which is large. It wasn't — `type: range`, `key: IDX_comment_sale`. Good enough.

## Moving the sort off SQL

The "most recently active" sort was the other half. My first instinct was to add a covering index to make the correlated subquery fast. But you can't really index your way out of `ORDER BY (correlated MAX subquery)` — MySQL still has to evaluate the subquery for the candidate set before it can sort, and a page offset of, say, 200 means it can't stop early either.

So I stopped asking SQL to do the sort. The page is small — `limit` is 10, 25 at the most. I already had to fetch the latest-comment timestamp per customer for the batched discussion data, so I folded the `MAX(createdAt)` into that same grouped query and sorted in application code:

```ts
const activity = await this.commentRepository
  .createQueryBuilder('comment')
  .select('comment.saleId', 'saleId')
  .addSelect('MAX(comment.createdAt)', 'lastActivity')
  .where('comment.saleId IN (:...ids)', { ids })
  .groupBy('comment.saleId')
  .getRawMany<{ saleId: string; lastActivity: Date }>();

const lastActivity = new Map(
  activity.map((r) => [r.saleId, r.lastActivity?.getTime() ?? 0]),
);

items.sort(
  (a, b) =>
    (lastActivity.get(b.id) ?? 0) - (lastActivity.get(a.id) ?? 0),
);
```

Sorting ten objects in Node is free. The honest tradeoff: this only works because I'm sorting *within* a page that's already been narrowed by an indexed `createdAt DESC` and an offset. If the requirement were truly "globally order the entire customers table by last-comment time, then paginate," moving sort into the app would be wrong — you'd be pulling the whole table into memory to sort it. It works here precisely because the page is the unit of work. I wrote a comment to that effect above the `.sort`, because the next person to read it will assume it's a bug.

## The task-status counts didn't belong here

While I was in the path I found the other thing dragging it down. The same dashboard resolver was also computing task-status counts — how many tasks are `PENDING`, `IN_PROGRESS`, `SUBMITTED`, and so on — and it was doing it inline, on every customer-list load, even when the part of the UI that shows those counts wasn't on screen.

The counts come back as a fixed-shape DTO:

```ts
@ObjectType()
export class TaskStatusCountsDto {
  @Field(() => Int) PENDING: number;
  @Field(() => Int) IN_PROGRESS: number;
  @Field(() => Int) SUBMITTED: number;
  @Field(() => Int) COMPLETED: number;
  @Field(() => Int) ON_HOLD: number;
  @Field(() => Int) REJECTED: number;
  @Field(() => Int) STUCK: number;
  @Field(() => Int) CLIENT_AWAITED: number;
  @Field(() => Int) total: number;
}
```

That's an aggregate over the tasks table — a `GROUP BY status` — and it has nothing to do with which page of customers you're looking at. It was riding along because both happened to live behind the same dashboard query when I first stitched it together. Coupling by accident.

I split it into its own analytics resolver. Now the counts are a separate GraphQL field the dashboard requests on its own cadence, and Redis caches them with a short TTL since they barely move minute to minute. The customer list stops paying for an aggregate it never used. The single most effective performance change I made wasn't an index or a batch — it was deleting work that didn't need to happen on that path at all.

```ts
@Query(() => TaskStatusCountsDto, { name: 'taskStatusCounts' })
@UseGuards(GqlAuthGuard)
async taskStatusCounts(
  @CurrentUser() user: User,
): Promise<TaskStatusCountsDto> {
  return this.taskAnalyticsService.getStatusCounts(user);
}
```

## What it cost and what I'd watch for

The list path went from a dozen-plus queries to three: the paginated `findAndCount`, one grouped query for discussion counts, one grouped query for activity timestamps (and I could merge those last two into a single `GROUP BY` if I cared to). The manager view that was near two seconds came back in the low hundreds of milliseconds. The status counts disappeared from the path entirely and now serve from Redis most of the time.

The thing that'll bite later: the application-side sort is correct only as long as the page stays small and the page boundary is set by the indexed column. If someone "improves" the UI to let users sort the global list by activity, this quietly becomes a memory hog and a wrong-looking page, because you'd be sorting one page's worth of rows and calling it the order of the whole table. The fix at that point is a real materialized `last_activity_at` column on the customer, updated when a comment lands, indexed, sorted in SQL. I didn't build that because we don't need it yet. But I left the door visible, which is the most you can do for a query you're deliberately under-engineering.
