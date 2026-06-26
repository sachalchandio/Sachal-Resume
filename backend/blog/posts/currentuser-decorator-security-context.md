---
title: "@CurrentUser: deriving the acting user from the request, not the client"
description: "A security context the server controls, so a mutation always knows who's really making the change."
date: "2024-12-12"
updated: "2024-12-12"
kind: "deepdive"
category: "Security"
tags: ["nestjs", "auth", "decorators"]
month: "2024-12"
repo: "backend"
author: "Sachal Chandio"
---

The mutation took a `userId` argument. That was the bug, and it sat in the schema for months looking completely reasonable.

When a rep moved a sale from `SOLD` to `INSTALLED`, the front end called `setSaleStage` and passed along who did it. The server wrote that down in the stage history, dutifully, exactly as told. Which means the stamp on "who advanced this sale" was whatever the client typed into a variable. Anyone with the GraphQL endpoint and a valid token for *any* account could move *any* sale and attribute it to *anyone*. The audit trail was a suggestion box.

The fix isn't clever. It's a posture change: the server already knows who you are — it verified your token to let you in the door — so it should never ask the client to tell it again. The acting user gets derived from the request, full stop. The client doesn't get a vote.

## Where the identity actually lives

By the time a resolver runs, Passport has already done its job. Our `JwtStrategy` pulls the bearer token off the `Authorization` header, verifies the signature, checks the `jti` against a Redis session allowlist, and then — the important part — re-reads the user from the database and returns a trimmed object:

```ts
// jwt.strategy.ts — the tail end of validate()
const user: User = await this.usersService.findUserByID(payload.sub);

if (!user || (headerEmail && tokenEmail !== headerEmail)) {
  throw new UnauthorizedException('User mismatch detected');
}

return {
  id: payload.sub,
  name: user.name,
  email: tokenEmail,
  profileImageURL: user.profileImageURL,
  userType: user.userType,
};
```

Whatever this returns, Passport hangs on `request.user`. That object is the only trustworthy identity in the whole request lifecycle, because it came from the `sub` claim of a signed token cross-checked against the actual users table — not from a mutation argument. The `userType` rides along too, which matters later: roles are part of identity here, not a separate lookup the client could skew.

So the resolver's job is just to read `request.user`. The annoying part is *getting* at it, because in a GraphQL app there's no plain Express request sitting in scope.

## The decorator

`@nestjs/graphql` wraps the execution context, so `request.user` lives a couple of hops down. A param decorator is the clean way to dig it out without every resolver re-deriving the path:

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const ctx = GqlExecutionContext.create(context);
    return ctx.getContext().req.user;
  },
);
```

Five lines, and now any resolver can write `@CurrentUser() user: User` and get the verified identity injected as an argument. The decorator is read-only by construction — there's no setter, no path for a caller to influence what comes out. It reads `req.user` or it returns nothing.

That naive version shipped first and worked for every plain HTTP GraphQL request. Then subscriptions broke it, which I'll get to.

## Gating the mutations

With the decorator in place, the sale-stage resolver stops trusting arguments and starts trusting the context. Here's `setSaleStage` after the change:

```ts
@Mutation(() => SaleStage)
@UseGuards(GqlAuthGuard)
@Roles(UserType.ADMIN)
async setSaleStage(
  @Args('saleId', { type: () => ID }) saleId: string,
  @Args('saleType', { type: () => SaleType }) saleType: SaleType,
  @Args('stage', { type: () => SaleFlag }) stage: SaleFlag,
  @CurrentUser() user: User,
): Promise<SaleStage> {
  return this.saleStageService.updateOrCreateSaleStage(saleId, saleType, stage, user);
}
```

Notice what's *not* in the args anymore. No `userId`, no `agentEmail`, no actor field of any kind. The sale id, the type, and the target stage are inputs the client legitimately chooses. The person performing the move is the last parameter, and it's the one thing the client can't touch. The service writes `user` into the stage-history row, so the record now says who the server confirmed, not who the request claimed.

The same shape applies to history mutations. `createSaleStageHistory` takes the stage, the sale, the sale type — and then `@CurrentUser() user: User`. If you want to know who logged an event, you read it off the verified identity, never off an argument.

Two decorators do the gating, and the order they run in matters:

- `@UseGuards(GqlAuthGuard)` runs first. No valid token, no `req.user`, request dies with a 401 before the resolver body is ever reached.
- `@Roles(UserType.ADMIN)` runs second. It checks that the verified user's `userType` is in the allowed set, and throws `ForbiddenException` otherwise.

`@Roles` is itself a composed decorator — it stamps metadata and wires up the guard in one shot, so I'm not hand-repeating `@UseGuards` everywhere:

```ts
export function Roles(...roles: string[]) {
  return applyDecorators(
    SetMetadata('roles', roles),
    UseGuards(GqlAuthGuard, RolesGuard),
  );
}
```

And the guard reads the same `req.user` the decorator does, then re-confirms the role against the database rather than trusting the token's copy:

```ts
const user = ctx.getContext().req.user;
if (!user) throw new ForbiddenException('No user found');

const validUser = await this.usersService.findUserByEmail(user.email);
if (!validUser || !roles.includes(validUser.userType)) {
  throw new ForbiddenException(
    `Access denied: Requires one of the following roles: ${roles.join(', ')}`,
  );
}
```

There's a real cost in that last query — every gated request does an extra `findUserByEmail` — and you could argue the `userType` already in `req.user` is good enough. I kept the lookup because a role can change mid-session (someone gets demoted off the floor), and I'd rather the next privileged action re-checks against the live row than honors a stale token for the next eight hours. Identity from the token, authority from the database.

So the full picture: only an `ADMIN` can call `setSaleStage`. The guard proves they're an admin against current data. The resolver records the move under the identity Passport verified. Three independent checks, and at no point does the client get to name the actor.

## The sharp edge: subscriptions

The clean five-line decorator broke the moment a WebSocket subscription tried to use it. Over WS there's no Express `req` in the GraphQL context — the user got attached during the connection handshake (`onConnect`), and it lands in a different spot depending on which transport and graphql-subscriptions version you're on. `ctx.getContext().req.user` threw a `TypeError: Cannot read properties of undefined` because `req` simply wasn't there.

The decorator had to learn every place the user might be hiding:

```ts
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    // Plain REST controllers (file uploads, the few non-GraphQL routes)
    if (context.getType() === 'http') {
      return context.switchToHttp().getRequest().user;
    }

    const ctx = GqlExecutionContext.create(context);
    const contextValue = ctx.getContext();

    // Subscriptions: attached directly in onConnect
    if (contextValue.user) return contextValue.user;

    // HTTP GraphQL: the usual home
    if (contextValue.req?.user) return contextValue.req.user;

    // Older graphql-subscriptions: buried in connection.context
    if (contextValue.connection?.context?.user) {
      return contextValue.connection.context.user;
    }

    return null;
  },
);
```

It's uglier than I want, and that ugliness is honest — it's the actual shape of supporting one decorator across REST, HTTP GraphQL, and two eras of WebSocket transport in the same app. The guard has the mirror-image problem and solves it by normalizing: when a subscription comes in with the user already on the context, `GqlAuthGuard` copies it onto `gqlCtx.req.user` before anything downstream looks, so the decorator and the roles guard both find it in the expected place. I'd rather the messiness live in two well-tested spots than leak into every resolver.

The other thing that bit me: returning `null` instead of throwing. If the decorator can't find a user, it hands back `null`, and a resolver that forgot its `@UseGuards` will happily run with `user === null` and blow up somewhere deeper with a much less obvious error. The decorator is not an auth check. It only reads what the guard already established. Skip the guard and you've skipped the security — the decorator will not save you, and for a stretch it was quietly not saving a couple of endpoints I'd assumed were covered.

## What I'd do differently

I'd make the decorator throw, or stop returning `null`, the day a guard is missing — fail loud instead of injecting an empty actor into a resolver that thinks it's protected. Better still, register the auth guard globally and opt routes *out* with a `@Public()` decorator, so the default is locked and forgetting an annotation makes an endpoint *more* restricted, not less. Right now the default is open and every resolver has to remember to close itself, which is exactly backwards for a security control.

And those `console.log` lines still sitting in `JwtStrategy.validate`, printing the token email and header email on every authenticated request — those need to go. Logging identity material on the hot path is the kind of thing that's invisible until someone ships those logs somewhere they shouldn't.

The lesson that stuck: any field that says *who did this* must be derived server-side from the verified request, never accepted as input. The second a client can name the actor, your audit log is writing fiction, and it'll do it cheerfully for months before anyone notices the sales all got moved by someone who wasn't there.
