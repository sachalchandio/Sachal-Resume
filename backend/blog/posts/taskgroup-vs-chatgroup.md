---
title: "Untangling two ‘groups’: task groups versus chat groups"
description: "One overloaded word, two domains, a pile of subtle bugs. Splitting the model and the resolvers."
date: "2026-02-23"
updated: "2026-02-23"
kind: "deepdive"
category: "Architecture"
tags: ["domain-design", "nestjs"]
month: "2026-02"
repo: "backend"
author: "Sachal Chandio"
---

A manager messaged me to say that archiving a column on the task board had kicked someone out of a team chat. Different feature, different screen, no obvious connection. Except they were both called "group," and somewhere in the GraphQL layer the names had finally collided hard enough to surface.

That was the moment I stopped treating it as a naming nit and started treating it as a design defect.

## How one noun ended up doing two jobs

Telelinkz grew chat first. A `Group` was a chat room: a name, a description, a set of members, a backing conversation. Months later we built a task board — clients get columns, columns hold task cards, you drag cards between them. The columns needed a name and an ordering and a parent. Somebody (me, probably) looked at the existing `Group` and thought: that's basically a group, reuse it.

So for a while a single `groups` concept tried to mean both "people who can talk to each other" and "a column of task cards for a client." The two never shared a row in the database — there were already two tables — but they shared the *word*, and that was enough. The GraphQL schema had `group`, `groups`, `createGroup`, `updateGroup`, and you genuinely could not tell from the query name which domain you were touching. The frontend had two Apollo services importing two different `Group` types that happened to have overlapping field names. Code review on anything touching "groups" meant first asking "which group?"

Here is the thing about an overloaded noun: it doesn't fail loudly. It fails in slow motion. Every developer who touches it makes a locally reasonable assumption about which "group" is in play, and most of the time they're right, so the bug doesn't show up in their change. It shows up three sprints later when someone copies a query they found, points it at the wrong resolver, and the types are *close enough* to compile.

## What the two things actually are

Once I stopped squinting and wrote both shapes down side by side, there was no real overlap at all. They're different aggregates with different lifecycles.

The chat group is a membership container with a conversation hanging off it:

```ts
@ObjectType()
@Entity('groups')
@Index('IDX_group_name', ['name'], { unique: true })
export class Group extends BaseEntity {
  @Field()
  @Column({ type: 'varchar', length: 150 })
  name!: string;

  @Field()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  // Link to the backing chat conversation
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 36, nullable: true })
  chatId?: string | null;

  @Field({ nullable: true })
  @Column({ type: 'datetime', nullable: true })
  lastAutoSyncAt?: Date | null;
}
```

Globally unique name. Owns members. Owns a `chatId`. Has a backfill-sync timestamp because group membership gets reconciled against org structure. None of that means anything to a task board.

The task group is a column scoped to a client:

```ts
@ObjectType()
@Entity('task_group')
export class TaskGroup {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field(() => Client)
  @ManyToOne(() => Client, (client) => client.groups, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'clientId' })
  client: Client;

  @Field(() => Int)
  @Column({ default: 0 })
  order: number;

  @Field(() => String, { nullable: true })
  @Column({ length: 7, nullable: true })
  color?: string; // hex for the column header

  @Field(() => [Task], { nullable: true })
  @OneToMany(() => Task, (task) => task.group)
  tasks?: Task[];

  @Field(() => Boolean)
  @Column({ default: false })
  isArchived: boolean;
}
```

Name is *not* globally unique — two clients can both have a "Follow-up" column. It belongs to a `Client` with `onDelete: 'CASCADE'`, so deleting the client takes the columns with it, which is exactly wrong behavior for a chat group. It has `order` and `color` and `isArchived`, none of which a chat room cares about. The membership it cares about is the client's, not a list of users.

Two aggregates. Different identity rules, different parents, different delete semantics, different fields. The only thing they shared was four letters.

## The approach I picked, and the ones I didn't

The clean-architecture move would be a discriminated base — `AbstractGroup` with a `type` column and two child entities via single-table inheritance. I rejected it in about thirty seconds. There's no shared behavior to factor out. Inheritance here would force the two domains to keep sharing a table and a migration history forever, purely to honor a similarity that doesn't exist. You'd inherit the coupling you were trying to remove.

The other tempting non-answer was to leave the entities alone and just rename things at the GraphQL boundary. Slap `chatGroup` and `taskGroup` on the queries, call it a day. That fixes the symptom the manager hit but leaves two classes named `Group` in the TypeScript, which is its own flavor of landmine when you're reading imports.

So: split fully, but keep it boring. The chat side already lived in `src/chat`, the task side in `src/tasks`. I kept the chat entity as `Group` (it owned the original `groups` table; renaming the class would have been churn for no payoff) and made sure the *task* side was unambiguously `TaskGroup` everywhere — entity, service, resolver, DTOs. The disambiguation that mattered was at the seams people actually read: the resolver class names and every GraphQL operation name.

```ts
@Resolver(() => TaskGroup)
@UseGuards(GqlAuthGuard)
export class TaskGroupResolver {
  @Query(() => [TaskGroup], { name: 'listTaskGroupsByClient' })
  async listTaskGroupsByClient(@Args('clientId') clientId: string, ...) { ... }

  @Mutation(() => TaskGroup, { name: 'createTaskGroup' })
  async createTaskGroup(@Args('input') input: CreateTaskGroupInput, ...) { ... }

  @Mutation(() => [TaskGroup], { name: 'reorderTaskGroups' })
  async reorderTaskGroups(@Args('groupIds', { type: () => [String] }) groupIds: string[], ...) { ... }
}
```

```ts
@Resolver()
@UseGuards(GqlAuthGuard)
export class ChatGroupResolver {
  @Mutation(() => Group, { name: 'createChatGroup' })
  async createChatGroup(@Args('name') name: string, ...) { ... }

  @Query(() => [Group], { name: 'chatGroups' })
  async chatGroups(@Args('search', { nullable: true }) search?: string, ...) { ... }
}
```

The bare `group`/`groups` operations are gone. Every operation now says which domain it belongs to in its own name. `reorderTaskGroups` will never get confused for a chat call, and `chatGroups` will never accidentally page through task columns.

## The part that was actually annoying

GraphQL operation names are public API. The Angular app and a couple of internal scripts called `createGroup` and `groups` by those exact strings. Rename the resolver and every one of those clients breaks at runtime — not at compile time, because GraphQL operations are strings the server validates on the way in. A typo'd field is a 400 the moment that screen loads, not a red squiggle in anyone's editor.

The honest play would have been to alias the old names to the new resolvers for a release, ship a deprecation note, then delete them. In a public API I'd insist on it. Here the only consumer was our own frontend in the same release train, so I renamed both ends in lockstep and grepped the Angular repo for every literal `Group` operation string before merging. Faster, and I knew the full set of callers. If a third party had been on these queries I would not have done it this way.

The class-name overlap inside the codebase was the smaller problem but the more insidious one. Two `Group` classes, two `Group.entity.ts`-shaped files, import lines like `import { Group } from '...'` where "..." is the only thing telling you which one you got. TypeScript will happily let you pass a chat `Group` into a function typed for a task group if enough fields line up. The fix was just discipline: the task entity is `TaskGroup`, full stop, and the chat `Group` only ever imported inside `src/chat`. Aliasing on import (`import { Group as ChatGroup }`) papers over it but I'd rather the name be right at the source than corrected at every call site.

## What I'd tell myself two years ago

The bug the manager reported turned out not to be a shared row — it was a frontend service that had imported the wrong `Group` type and called the wrong mutation, and the types were similar enough that nothing complained until a real user clicked the button. Exactly the slow-motion failure mode. The split didn't just rename things; it made that specific class of mistake un-typeable, because now there's no `group` operation to call by accident and no ambiguous `Group` import outside chat.

The lesson I keep relearning: reusing a model because two things *feel* alike is borrowing against the future. The cost shows up as a tax on every reader who now has to disambiguate in their head, and occasionally as a bug that ships because two people disambiguated differently. When you catch yourself saying "it's basically a group," stop and write down both shapes. If the identity rules, the parent, or the delete semantics differ, they are not the same thing, and the few minutes you save by reusing the noun will be repaid with interest by whoever debugs it at 11pm. Cheap names are expensive.
