---
title: "A field called ‘name’ that was actually carrying the email"
description: "A mislabeled payload field bred a whole class of confusing bugs. Renaming it, and restricting who gets full user info."
date: "2025-02-14"
updated: "2025-02-14"
kind: "deepdive"
category: "Backend"
tags: ["bugfix", "dto", "graphql"]
month: "2025-02"
repo: "backend"
author: "Sachal Chandio"
---

A manager messaged me a screenshot of the comment feed on a sale. The byline read `belachandio@gmail.com left a comment`. Not "Sachal." The email. The literal email address, sitting where a human name was supposed to be, in a UI a customer-facing rep looks at fifty times a day.

My first thought was that someone's display name had been saved wrong — a fat-fingered profile edit, maybe an import that dumped the email into the `name` column. So I went to the database first. Wrong instinct, as it turned out, but a reasonable one.

```sql
SELECT id, name, email FROM user WHERE email = 'belachandio@gmail.com';
```

The row was fine. `name` said `Sachal Chandio`. `email` said `belachandio@gmail.com`. Two distinct columns, both correct, both exactly what the `user` table's `@Column` definitions promise — `name` is `length: 50`, `email` is `unique: true, length: 100`. So the data wasn't the problem. The data was pristine. Whatever was putting the email on screen was doing it *after* reading a perfectly good row.

## Following the value, not the field

The comment component on the front end binds to `comment.author.name`. That's the string showing up wrong. So either the resolver was returning the email in the `name` field, or something upstream had stuffed the email into a property the UI trusted to be the name.

I traced backwards from the comment author to where the acting user gets established on each request, and that's the auth layer. Our `JwtStrategy.validate` is the thing that turns a bearer token into the `req.user` object every resolver leans on. Here's what it returned at the time:

```ts
// jwt.strategy.ts — what validate() handed back
return {
  id: payload.sub,
  name: user.name,
  email: tokenEmail,
  profileImageURL: user.profileImageURL,
  userType: user.userType,
};
```

That looked correct. `name` is `user.name`. So the verified identity was fine too. The email wasn't leaking from here.

The leak was one hop earlier, in the shape the *client* held. When a rep logs in, `AuthService.login` builds a `LoginUserResponse` and the front end caches it as "the current user." That cached object is what the comment component reached for when it optimistically rendered a brand-new comment before the server round-tripped — it grabbed `currentUser.name` to show the byline immediately. And the cached object came from a different code path than `req.user`, one I'd stopped looking at because the database row was correct.

Here's the part that actually mattered. Somewhere in the front-end auth store, there was a normalization step that built a lightweight "session user" out of the login response, and one of its fields had been wired like this:

```ts
// the offending mapping, paraphrased
const sessionUser = {
  id: res.id,
  name: res.email,        // <-- "name" carrying the email
  email: res.email,
  userType: res.userType,
};
```

`name: res.email`. Someone — past me, almost certainly — had filled the `name` field with the email because at the time login only ever returned the email, and the byline "needed something." It worked. The email is a string, it's never empty, it rendered, the ticket closed. And then it sat there as a slow drip: every place that read `sessionUser.name` got an email, and every place that read it off a *fully* hydrated user got an actual name, and the two disagreed depending on which path populated the object.

## Why it hid for so long

The two values look similar enough that nobody flags them in passing. An email and a name are both short strings in a byline. In most views the user object came from a full GraphQL `me` query that returned the real `name`, so things looked right. Only the optimistic-render path — the few hundred milliseconds before the server's comment came back — used the cached session user, and only there did the email flash up. It was a race the bug only won sometimes, which is the worst kind. Reproducing it meant commenting fast and catching the pre-server frame.

The root cause wasn't a typo. It was a field whose *name lied about its contents*. Once a field called `name` is allowed to hold an email, every reader has to know, out of band, whether this particular instance is the kind that holds a real name or the kind that holds an email. That knowledge lives nowhere except in the head of whoever wrote the mapping, and that person leaves, or forgets, and now you have a class of bug instead of a bug.

## The fix: stop letting the field lie

I didn't want to patch the one byline. I wanted to make it impossible for `name` to ever carry an email again. That meant the login response had to return both, distinctly, and every consumer had to read the one it meant.

The backend already had the real name available — `AuthService.login` reads the full `user` row to check the password. It just wasn't passing `name` through. So the response object got the actual field:

```ts
// auth.service.ts — login(), the returned shape, before
const result: LoginUserResponse = {
  id: user.id,
  email: loginUserInput.email,
  userType: user.userType,
  accessToken,
};
```

```ts
// after — name is its own field, sourced from the row
const result: LoginUserResponse = {
  id: user.id,
  name: user.name,
  email: loginUserInput.email,
  userType: user.userType,
  accessToken,
};
```

`LoginUserResponse extends PartialType(UserDto)`, and `UserDto` already declares both `name` and `email` as separate `@Field`s, so the GraphQL schema needed nothing new — I'd just never been populating `name`. One line on the server. The interesting work was on the consumer side: I renamed the offending front-end field so the email could never masquerade as a name again.

```ts
// after — the session user reads the right field for each
const sessionUser = {
  id: res.id,
  name: res.name,         // the actual name, finally
  email: res.email,
  userType: res.userType,
};
```

Then I went and found every reader. `git grep` for `.name` in the auth and comment paths, walked each one, and decided per call site whether it wanted the human name or the login identifier. Most wanted the name and had been silently getting an email. A couple genuinely wanted the email — a "logged in as" tooltip, a support-contact mailto — and those I pointed explicitly at `.email`. The compiler helped here more than I expected: once the session-user type stopped claiming `name` was "whatever string," the few spots that had been leaning on the old behavior lit up as type errors instead of staying quiet.

## The thing I fixed while I was in there

Tracing the login response made me read it closely for the first time in a while, and I didn't love what a non-admin got back. The `me`-style hydration query was returning the full `UserDto` to everyone — and `UserDto` is not a small object. It carries `basicSalary`, `grossSalary`, `accountNumber`, `bankId`, `cnic`, `dateOfBirth`. That's HR and PII data, and a floor agent had no business receiving their own `grossSalary` in a payload just because the comment byline needed a name.

So the same change that split `name` from `email` also tightened what leaves the server for non-admins. The trimmed identity — `id`, `name`, `email`, `profileImageURL`, `userType` — is everything a rep's UI actually needs to render itself. The salary and bank fields only resolve for an admin context or for the user querying their own HR record explicitly, gated behind the role check the rest of the app already uses. The byline bug was the thread; pulling it unraveled a quiet over-share that had been riding along on the same query.

## When this bites

A field whose name disagrees with its contents is a debt that compounds. It costs nothing the day you write it — the email is a string, the byline renders, everyone moves on. The interest comes later, paid by whoever reads the field expecting what the name promises and getting something else, in a view they didn't write, on a day they were debugging something unrelated. The bug isn't in any one line; it's in the gap between the label and the value, and that gap is invisible until a value from the wrong side of it shows up on a screen a customer can see.

The rule I took from it: a field's name is a contract, and you don't get to quietly break it because the right value wasn't handy at the time. If `name` can't hold a name yet, the response shouldn't have a `name` field — make the consumer reach for `email` and *see* that it's an email. Half-filling a well-named field with the wrong thing is worse than leaving it out, because the omission fails loud and the lie fails late. And if you ever find yourself writing `name: something.email`, stop. That line is a future screenshot from a confused manager, and it will find you on a Friday.
