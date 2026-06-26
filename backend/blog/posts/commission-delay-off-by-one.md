---
title: "Commission delays: the zero-month and off-by-one bugs"
description: "Payouts don't fire instantly, and the delay math had two classic edge cases. Finding and fixing both."
date: "2025-07-22"
updated: "2025-07-22"
kind: "deepdive"
category: "Backend"
tags: ["bugfix", "commissions", "dates"]
month: "2025-07"
repo: "backend"
author: "Sachal Chandio"
---

An agent pinged me on a Friday: his June salary report showed commission for a sale he closed in June, but the deal was supposed to pay out a month later. The number was real, the sale was real, the math was just early. Then the next message: another agent's report was showing the *same* commission twice across two months. Same feature, two opposite symptoms. That's usually a sign the underlying logic is right in spirit and wrong at the edges.

Some context on why there's a delay at all. Commission on a telecom sale doesn't become payable the instant the deal is marked closed. There's a clawback window — the customer can cancel, the carrier can reject the activation, the order can fall out before it's truly booked. So each commission plan carries a `paymentDelayMonths` value. A plan with a one-month delay means a sale closed in May is payable in June. A plan with zero delay pays in the same month it closed. Simple enough to describe, and that description is exactly where both bugs lived.

## The symptom, precisely

The salary report is built per agent, per month. For a given report month it asks: which commissions are *payable this month*? A commission earned on a sale in month `S` with delay `D` is payable in month `S + D`. So for report month `R`, I want every sale where `S + D === R`, i.e. `S === R - D`.

The first report — paying early — was an agent whose plan had `paymentDelayMonths = 0`. His June sale showed up in June. That's actually correct. But he'd been told his plan was "next month," and when I checked the plan record, the value really was `0`. So the bug wasn't in the code yet; the data said zero, and zero means same month. I almost closed it as "working as intended."

The second report was the one that mattered. `paymentDelayMonths = 1`, and a May sale was appearing in *both* June and July. That can't be a rounding thing. A commission is payable in exactly one month. Showing up in two means my month arithmetic was producing two different "payable" months for the same row, depending on which report I was generating.

## The wrong guess

My first instinct was the classic: timezones. We store `closedAt` as a `DATETIME` in MySQL, the server runs UTC, and a sale closed at 23:40 local at the end of May could be June in UTC. I'd been bitten by that before. So I went looking for a `new Date()` somewhere stripping the time and shifting the day across a month boundary.

I spent a good half hour there. Logged the raw `closedAt`, logged the derived month key, compared them for the duplicated row. The month key was stable — `"2025-05"` every time. The sale's month wasn't drifting. The duplicate wasn't coming from the *sale* side at all. It was coming from how I computed the *target* month for the report, and how I compared it back.

This is the part I want to be honest about: I had two different bits of date math in the codebase doing the "add the delay" step, written months apart, and they didn't agree on what month arithmetic meant.

## Root cause

Here's the original helper. It took a sale's close date and a delay and returned a month key like `"2025-06"`.

```ts
// before
function payableMonthKey(closedAt: Date, delayMonths: number): string {
  const d = new Date(closedAt);
  if (delayMonths) {
    d.setMonth(d.getMonth() + delayMonths);
  }
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  return `${year}-${month}`;
}
```

Two things wrong, and they map exactly onto the two symptoms.

**The zero-month bug is the `if (delayMonths)` guard.** `0` is falsy in JavaScript. The guard reads like "only shift if there's a delay," which sounds harmless — adding zero does nothing anyway, so why bother branching? But the branch wasn't free. Look one line down: when `delayMonths` is `0` the `if` is skipped, fine, but elsewhere in the report builder I had a *parallel* path that treated a missing/zero delay as "use the plan default," and the default for unconfigured plans was `1`. So a genuine `0` and an absent value both fell through the same falsy check and got coerced to the default. The agent with `paymentDelayMonths = 0` wasn't being paid same-month because of this helper; he was being paid same-month because the helper *worked*, while the report builder's falsy guard quietly turned his zero into a one elsewhere and then a different code path corrected it back. Two falsy checks fighting. The result happened to look right for him and wrong for the next person.

**The off-by-one is `Date.prototype.setMonth` rolling over.** This is the real duplicate. `setMonth` doesn't clamp — it overflows into the next year and, worse, interacts with the day-of-month. Take a sale closed on May 31 with a one-month delay. `setMonth(month + 1)` asks for "June 31," which doesn't exist, so JavaScript rolls it forward to July 1. Now the payable month key is `"2025-07"`, not `"2025-06"`. The June report, computing `R - D` from its side (June minus one = May, look for May sales), matched the row and paid it. The July report, when I derived the payable month *forward* from the sale (`May 31 + 1 month` → July 1 → `"2025-07"`), *also* matched. Same row, two months, because the forward and backward computations disagreed at the end-of-month boundary.

So it wasn't timezones. It was the 31st. The duplicated rows were all sales closed on the 29th, 30th, or 31st of a month with a one-month delay landing on a shorter month. Once I filtered the report data to those close dates, every duplicate lined up. That's the moment it clicked.

## The fix

Stop doing date-with-day arithmetic for something that's purely about months. A month is `year * 12 + month` — an integer. Add the delay to the integer, never touch the day. No `setMonth`, no rollover, no day-of-month in the mix at all.

```ts
// after
function payableMonthKey(closedAt: Date, delayMonths: number): string {
  // Work in absolute month-index space so day-of-month can't roll us over.
  const baseIndex = closedAt.getFullYear() * 12 + closedAt.getMonth();
  const payableIndex = baseIndex + delayMonths; // delayMonths === 0 is fine

  const year = Math.floor(payableIndex / 12);
  const month = `${(payableIndex % 12) + 1}`.padStart(2, '0');
  return `${year}-${month}`;
}
```

`delayMonths` of `0` adds nothing and needs no guard — that's the whole point of doing it in integer space. And `May (index … + 4) + 1 = June`, full stop, regardless of whether the sale closed on the 1st or the 31st. I deleted the parallel "default to 1" coercion in the report builder too and made the delay an explicit, non-null column with a default of `0` at the schema level, so the application code never has to guess what an absent value means.

The comparison side got the same treatment so the two directions can't drift apart again. The report for month `R` computes its own month index once and asks for sales whose `payableIndex` equals it:

```ts
const reportIndex = reportYear * 12 + reportMonth; // 0-based month
const due = sales.filter(
  (s) => baseIndexOf(s.closedAt) + s.plan.paymentDelayMonths === reportIndex,
);
```

One source of truth for "what month index is this," used both forward and backward. If they're literally the same arithmetic, they can't disagree on May 31.

## The second half: paid commission was getting double-counted

Fixing the boundary math stopped the *display* duplication, but it surfaced a related problem I'd been papering over. A commission, once actually paid out in a salary run, should never be recomputed into a later report. We were leaning on the date math alone to guarantee a commission appeared in exactly one month — and we just saw how fragile that assumption was. If the math is ever wrong again, money moves twice.

So I added a hard flag. When a salary report is finalized and its commissions are disbursed, each contributing commission row gets `commissionPaid = true`. Reports then exclude anything already paid, no matter what the month math says:

```ts
const due = sales.filter(
  (s) =>
    !s.commission?.commissionPaid &&
    baseIndexOf(s.closedAt) + s.plan.paymentDelayMonths === reportIndex,
);
```

The flag flips inside the same transaction that writes the salary report, so a half-finished run can't mark commissions paid without the report existing, and vice versa. Date math decides *when* something becomes payable; the `commissionPaid` flag decides *whether* it's still owed. Those are two different questions and I'd been answering both with one. Now the report builder is allowed to be wrong about timing without that wrongness turning into a second payout. Belt and suspenders, and after this bug I'm fine wearing both.

## What I'd take from this

Calendar months are not durations. `setMonth(getMonth() + n)` looks like month addition and behaves like it about 90% of the time — every month except when the source day doesn't exist in the target month. The 31st finds that 10% every single time, and in a payroll system the 10% is real money. If you're only adding months, throw the day away first: convert to a `year*12 + month` integer, add, convert back. There's no end-of-month case to handle because there's no day involved.

And `if (delayMonths)` to mean "if there's a delay" is a bug waiting for a `0`. Any time a real, meaningful value can be zero or empty string, the truthiness shortcut will eventually eat it. Check `!= null` or compare explicitly. It cost me an hour chasing timezones because the symptom — a same-month payout — happened to look almost correct.

This bites hardest where two pieces of code do "the same" calculation in two directions and you trust them to agree. They won't, not at the boundaries, unless they're literally the same function. Make them the same function. And when the thing being computed is money that's already left the building, don't trust the computation at all — write down that it was paid, and check the flag.
