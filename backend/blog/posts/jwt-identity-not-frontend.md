---
title: "Don't let the client tell you who the agent is: identity from the JWT"
description: "Agent attribution came up from the frontend. Moving it to the token, where it can't be forged."
date: "2025-03-13"
updated: "2025-03-13"
kind: "deepdive"
category: "Security"
tags: ["jwt", "auth", "graphql", "nestjs"]
month: "2025-03"
repo: "backend"
author: "Sachal Chandio"
---

A rep messaged me saying he could see another rep's sales. Not all of them — just the ones that showed up when he searched by a teammate's name in the agent filter. He'd typed it in half by accident, hit enter, and there they were: someone else's customers, phone numbers, order numbers, the lot.

That should not have been possible. Agents are supposed to see their own book and nothing else.

## The first guess was wrong

My first instinct was the role guard. We gate every sale query with `@Roles`, and I assumed an agent had been mislabeled — promoted to manager in the users table by mistake, or the role check was reading a stale `userType`. So I pulled his record. `userType` was `AGENT`, clean. I logged what the role guard saw on his request, and it saw `AGENT` too. The guard was doing exactly what it was told; it let the query through because agents *are* allowed to call `findSalesWithComplexFilterDynamic`. Being allowed to call the query is not the same as being allowed to see every row it can return. I'd conflated the two.

So the guard wasn't the bug. The bug was one level down, in what the query did with the filter once it was inside.

## The root cause

Sale search took a filter object straight from the client, and that filter carried `agentName`. The service used it to decide whose sales to return:

```ts
// before — the scoping came from whatever the client sent
async findSalesWithComplexFilter(filter, limit, offset, search, user) {
  const qb = this.repo.createQueryBuilder('sale');
  qb.leftJoinAndSelect('sale.agent', 'agent');

  if (filter.agentName) {
    qb.andWhere('agent.name = :agentName', { agentName: filter.agentName });
  }
  // ...date, search, pagination
}
```

Read that `if` the way an attacker reads it. The set of sales you get back is a pure function of the string you put in `agentName`. There is no clause anywhere that ties the result to *who is asking*. The `user` argument was there — passed down from the resolver — and the method completely ignored it for scoping. An admin querying `agentName = "Maria"` and an agent querying `agentName = "Maria"` got the identical result set. The server was deciding identity from a value the frontend sent, which is exactly the one thing you never let a client assert.

The frontend "behaved" only because our own UI hid the agent filter from agents and pre-filled it with their own name. That's not a security boundary. That's a painted line on the floor. Anyone with the rep's token and the GraphQL endpoint — which is to say, the rep himself with the network tab open — could send any `agentName` they liked.

Same disease on the write side, milder. At sale creation we were trusting the form to tell us which agent the sale belonged to instead of stamping it from the session. So a forged or fat-fingered create could attribute a sale to the wrong person, and every downstream thing keyed on `agentId` — commission, the analytics rollups, the leaderboard — would happily believe it.

## Who the server already knows you are

The fix is a posture change, not a clever trick. By the time the resolver runs, Passport has already verified the bearer token. Our `JwtStrategy` reads the `Authorization` header, checks the signature, validates the `jti` against a Redis session allowlist, then re-reads the user from MySQL and hands back a trimmed object:

```ts
// jwt.strategy.ts — tail of validate()
const user: User = await this.usersService.findUserByID(payload.sub);

if (!user || (headerEmail && tokenEmail !== headerEmail)) {
  throw new UnauthorizedException('User mismatch detected');
}

return {
  id: payload.sub,
  name: user.name,
  email: tokenEmail,
  userType: user.userType,
};
```

The token payload is just `{ sub, email, jti, exp }`. `sub` is the user id, signed with `JWT_ACCESS_SECRET`. You can't change `sub` without re-signing, and you can't re-sign without the secret. That's the whole point of the thing — it's an identity the client carries but cannot rewrite. The `userType` doesn't even come from the token; it's re-read from the database on every request, so a promotion or a demotion takes effect immediately and a stale claim in an old token buys you nothing.

A `@CurrentUser()` param decorator pulls that object off the GraphQL context so the resolver gets it as an argument:

```ts
@Query(() => DynamicSalePaginatedSales, { name: 'findSalesWithComplexFilterDynamic' })
@UseGuards(GqlAuthGuard)
@Roles(UserType.ADMIN, UserType.MANAGER, UserType.AGENT, UserType.QA, UserType.QA_MANAGER)
async findSalesWithComplexFilterDynamic(
  @Args('filter') filter: Partial<DynamicSaleFilterInputDto>,
  @Args('limit', { type: () => Int }) limit: number,
  @Args('offset', { type: () => Int }) offset: number,
  @Args('search', { type: () => String, nullable: true }) search: string,
  @CurrentUser() user: User,
): Promise<DynamicSalePaginatedSales> {
  return this.dynamicSaleService.findSalesWithComplexFilter(filter, limit, offset, search, user);
}
```

`GqlAuthGuard` extends `AuthGuard('jwt')`, so no token means no `user`, which means the query never runs. Before that guard went on, an unauthenticated call would at least have reached the service with `user` undefined. Now it can't.

## Scope from identity, not from the filter

Inside the service, the agent's view is now derived from `user.id` and `user.userType` — values that came off a verified token — and the client's `agentName` is demoted to a convenience that only privileged roles can use:

```ts
// after — agents are scoped by who they are, full stop
if (user.userType === UserType.AGENT) {
  qb.andWhere(
    `(
      agent.id = :userId
      OR fronter.id = :userId
      OR EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.saleId = sale.id
          AND t.saleType = :saleType
          AND (
            t.assignedToId = :userId
            OR EXISTS (
              SELECT 1 FROM task_assignment_history tah
              WHERE tah.taskId = t.id
                AND (tah.toUserId = :userId OR tah.fromUserId = :userId)
            )
          )
      )
    )`,
    { userId: user.id, saleType: this.saleType },
  );
} else if (filter.agentName) {
  // only admins/managers reach this branch
  qb.andWhere('agent.name = :agentName', { agentName: filter.agentName });
}
```

The shape that matters is the `if/else`. If you're an agent, the `agentName` branch is unreachable — you get your own sales (as agent or fronter), plus sales you're attached to through a task or a task reassignment, and that's the entire universe available to you. There is no string you can put in the filter that widens it. The named-agent filter still exists for the people who are *supposed* to look across the team, and they reach it only by failing the `AGENT` check, which they can't fake because `userType` was re-read from the database, not parsed from input.

The same `user` flows into creation, where `agentId` gets stamped from the session instead of the payload:

```ts
const sale = this.dynamicSaleRepository.create({
  // ...customer fields from input
  agent,        // the @CurrentUser(), not anything the form sent
  fronter,      // resolved by email, and never equal to the agent
});
```

So the row is born owned by whoever was holding the token, and the read path scopes off that same identity. The two sides finally agree on who the agent is, and neither of them asks the browser.

## When this bites

It bites the moment a "who" travels in the request body. Any `userId`, `agentId`, `ownerId`, `createdBy` that arrives as an argument is a forgeable claim until you prove otherwise, and the proof is almost always to throw the field away and read the identity off the token instead. The tell in this codebase was a method that accepted a `user` parameter and then never used it for the decision it was making — the trustworthy value was right there, sitting unused, while the query keyed off the untrusted one.

The reason it hid for so long is the most ordinary reason in the world: our own frontend never sent a hostile value, so in every normal session the wrong design produced the right answer. Authorization tested through the happy path always passes. You only find these by asking who could send the request you *didn't* build the UI for — and then assuming someone will.
