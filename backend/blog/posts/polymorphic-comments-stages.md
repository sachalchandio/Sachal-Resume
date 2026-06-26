---
title: "Polymorphic relations for comments and sale stages"
description: "A comment should attach to anything. Modeling that without a forest of nullable foreign keys."
date: "2024-07-10"
updated: "2024-07-10"
kind: "deepdive"
category: "Architecture"
tags: ["typeorm", "data-modeling"]
month: "2024-07"
repo: "backend"
author: "Sachal Chandio"
---

A comment is a comment. The thing it's stuck to isn't.

When I started, comments hung off Xfinity sales and nothing else. One foreign key, `xfinitySaleId`, clean and boring. Then AT&T sales got a comments tab. Then someone wanted to leave a note on a call log. Then the stage-tracking feature needed the same "who, when, on what" shape but for *sale stages* instead of comments. And the provider list kept growing — Spectrum, Frontier, Optimum, AltaFiber, a dozen more in the pipeline. The `comment` table was about to grow a foreign key per provider, almost all of them null on any given row.

I counted. We were heading toward thirty-plus nullable FK columns on one table, exactly one of which would be set per comment. That's not a schema. That's a confession that you don't know what a comment belongs to.

## The choice: a column per type, or a type *in* a column

Two honest options. Keep adding `xfinitySaleId`, `atntSaleId`, `astoundSaleId` columns — call it the wide table — or go polymorphic: store *which kind* of thing in one column and *which id* in another. The parent isn't a foreign key to a specific table; it's a `(type, id)` pair the application resolves.

The wide table buys you real referential integrity. Every FK is enforced by MySQL; you cannot orphan a comment. The cost is a column for every provider you'll ever add, a migration on the comment table every time the business signs a new telecom, and queries that have to `COALESCE` across thirty columns to answer "what sale is this comment about." The polymorphic table buys you a fixed shape that never changes when you add a provider. The cost is that you give up the database-enforced foreign key, and your joins stop being joins.

I went polymorphic. With thirty-odd provider tables and more coming, the wide table wasn't a tradeoff, it was a slow-motion outage of `ALTER TABLE`s. But I want to be precise about what I traded away, because the integrity loss is real and it's the part people gloss over.

## The shape

Here's the comment entity, trimmed to the polymorphic core. The pair is `saleId` plus `saleType`, where `saleType` is a MySQL enum naming the parent kind.

```ts
@Index('idx_comment_sale', ['saleId', 'saleType'])
@Entity('comment')
@ObjectType('CommentEntity')
export class Comment extends BaseEntity {
  @Column({ length: 300 })
  text: string;

  @Column()
  saleId: string; // the id of *some* sale — which table, we don't say here

  @Column({ type: 'enum', enum: SaleType })
  saleType: SaleType; // ...we say it here

  @ManyToOne(() => User, (user) => user.comments)
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_comment_userId' })
  user: User;

  // self-referential thread, this one IS a real FK
  @ManyToOne(() => Comment, (c) => c.replies, { nullable: true })
  @JoinColumn({ name: 'parentCommentId' })
  parentComment: Comment;
}
```

Note what is and isn't a foreign key. `userId` is a normal enforced FK — users live in one table, no polymorphism needed. `parentCommentId` is a normal FK too, for threaded replies. But `saleId` is just a `varchar`. There's no `@ManyToOne` to a `Sale`, because there's no single `sale` table to point at. The relationship lives in the application, not the schema.

`SaleStage` is the same trick, different payload. Instead of `text` it carries a `stage` enum (SOLD, INSTALLED, CANCELLED, and so on) and the agent who moved it there, but the polymorphic pair is identical:

```ts
@Entity('sale_stage')
export class SaleStage extends BaseEntity {
  @Column({ type: 'enum', enum: SaleFlag, default: SaleFlag.SOLD })
  stage: SaleFlag;

  @Column()
  saleId: string;

  @Column({ type: 'enum', enum: SaleType })
  saleType: SaleType;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'agentId', foreignKeyConstraintName: 'FK_sale_stage_agentId' })
  agent?: User;
}
```

Two tables, one pattern. That's the payoff already: the stage-history feature didn't need to invent its own parent-linking scheme. It borrowed `(saleId, saleType)` wholesale. When the same `SaleType` enum drives comments, stages, notifications, and audit forms, "attach this to a sale" becomes one vocabulary across the whole system.

## Why an enum and not a free-text type column

A lot of polymorphic designs store the type as a string — `commentable_type = 'XfinitySale'`. I made it a MySQL `enum` on purpose. A typo'd `'xfintySale'` is a row that joins to nothing and is invisible to every query that filters by the right spelling. The enum makes MySQL reject the bad value at write time. It's the one scrap of integrity you can keep when you've given up foreign keys: the *type* half of the pair is constrained even though the *id* half isn't.

There's a sharp edge hiding in that decision, and it cost me a slow migration to learn. A MySQL enum is ordered, and how you grow it matters:

```ts
export enum SaleType {
  XFINITY_SALE = 'XFINITY_SALE',
  ATNT_SALE = 'ATNT_SALE',
  // ...thirty more...
  DYNAMIC_SALE = 'DYNAMIC_SALE', // kept LAST on purpose
}
```

Appending a value to the **end** of a MySQL enum is an in-place metadata change — fast, no rebuild. Inserting one in the *middle*, to keep things alphabetical or grouped, forces MySQL to rewrite every row of the table because the enum's internal integer ordering shifts. On a `comment` table with millions of rows that's a long lock. So the rule in this codebase is written into a comment in the enum file: always append at the end, never tidy the middle. The day someone "cleaned up" the ordering in a PR, the migration would have rebuilt the table on deploy. Now it's load-bearing documentation.

## The join you don't get

Here's the bill for the flexibility. With a real FK you'd write `comment JOIN xfinity_sale`. With a polymorphic id you can't, because the database doesn't know which table to join to until it reads `saleType` on each row. There is no `JOIN ON comment.saleId = ???.id` you can write in one statement.

So fetching comments for a sale is a two-step in the application: query by the pair, then hydrate the parent yourself if you need it.

```ts
async findBySale(saleId: string, saleType: SaleType): Promise<Comment[]> {
  return this.commentRepository.find({
    where: { saleId, saleType },        // composite index does the work
    relations: ['user', 'parentComment'],
    order: { createdAt: 'ASC' },
  });
}
```

That query is fine — it's covered by `idx_comment_sale` on `(saleId, saleType)`, and going *from* a sale *to* its comments is the common direction. You always know the sale's type when you're standing on the sale. The expensive direction is the reverse: "here are 500 comments across every provider, show me each one's parent sale." That needs a fan-out — group the comment rows by `saleType`, then one batched `WHERE id IN (...)` per provider table, then stitch the results back together in memory. It's an N-queries-where-N-is-the-number-of-distinct-types problem, and there's no index that makes it a single join. I wrote that fan-out once for an admin "recent activity" screen and it's the ugliest data-access code in the module. It works, but every time I touch it I feel the absence of the foreign key.

The other thing you lose: `ON DELETE CASCADE`. Hard-delete an Xfinity sale and its comments don't go anywhere — MySQL has no idea they were related. Orphan rows just sit there, pointing at an id that no longer exists. We handle it in the service layer (delete the comments and stages in the same transaction as the sale) and lean on soft-deletes so the parent rarely actually vanishes, but that's discipline, not a guarantee. A new code path that forgets the cleanup step leaks orphans silently, and nothing in the database complains. With a real FK that's a constraint violation you'd notice immediately.

## What I'd do differently

I'd keep the polymorphic pair — for thirty-plus provider tables it's still the right call, and I'd make the same decision tomorrow. But two things I'd change.

First, I'd write the orphan-reaper from day one instead of after the first leak. A small scheduled job that, per `saleType`, finds `comment.saleId` values with no matching parent and flags them. Cheap to run, and it turns "silent integrity drift" into a number on a dashboard. I bolted it on later, which means there's a window of history where I genuinely don't know how many orphans accumulated.

Second, I'd be more disciplined about the *id* half being a real UUID and nothing else. Because `saleId` is just a `varchar`, nothing stops a careless caller from stuffing a non-UUID in there, and a bad id is indistinguishable from a valid-but-deleted one. The comment service already validates UUID shape for mention IDs going into `IN (...)` clauses; I should have applied the same guard to `saleId` at write time. The type column is constrained by the enum. The id column deserved a CHECK or at least an application-level validator, and it didn't get one early enough.

The honest summary of polymorphic relations: you trade a guarantee the database gives you for free — this row points at something real — for a shape that doesn't break every time the business grows. That trade is correct when the "many types" really is many and really does keep growing, which is exactly the telecom-provider situation. It's a bad trade when you have three fixed types that'll never change; there, just write the three foreign keys and let MySQL do its job. The mistake isn't going polymorphic. The mistake is going polymorphic and then pretending you didn't give anything up.
