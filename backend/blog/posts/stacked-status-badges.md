---
title: "Showing overlapping states without confusing the user"
description: "A record could be pending-penalty, sale-penalty and audited at once, but the UI showed one. Stacking them legibly."
date: "2026-05-10"
updated: "2026-05-10"
kind: "deepdive"
category: "Frontend"
tags: ["angular", "ui", "css"]
month: "2026-05"
repo: "frontend"
author: "Sachal Chandio"
---

A sale in our CRM is not a single state. It's a small pile of independent facts that happen to live on the same row. A sale can have a penalty request sitting in the admin queue, *and* an approved sale penalty already deducting from commission, *and* a QA audit on file — all three at once, all true, none of them cancelling the others out. The record search table showed one. Whichever branch of the `@if` chain fired first won, and everything underneath it just silently didn't render.

So a row that was genuinely "pending review, already penalized 25%, and audited last Tuesday" displayed as... pending. The penalty was real money off someone's paycheck and the table was hiding it behind a hourglass icon. That's not a styling bug. That's the UI lying by omission, and it cost me an afternoon of "why does the report say this sale was penalized when the table says it's still pending."

## Why one badge was never going to be enough

The original markup was the obvious thing you write when you assume states are mutually exclusive:

```html
@if (element["hasPendingPenalty"] === true) {
  <!-- pending badge -->
} @else if (element["isPenalized"] === true) {
  <!-- penalty badge -->
} @else if (element["hasSaleAudit"] === true) {
  <!-- audit badge -->
}
```

`@else if`. That's the whole bug, right there. The states aren't exclusive — they're orthogonal. A penalty request and an audit are produced by different people at different times for different reasons. Treating them as an ordered priority list meant the table picked a winner and threw away the losers.

The fix is conceptually trivial and I want to be honest that the hard part wasn't the code. It was deciding what "three things are true" should *look like* without the row turning into a confetti cannon. A penalty already shades the whole table row with a colored gradient. Stack three loud badges on top of that and the eye has nowhere to rest.

So the rules I settled on, before writing any markup:

- Each fact gets its own badge. No combining, no "2 issues" summary count — those hide exactly the detail people need.
- Badges stack vertically, not inline. Inline wraps unpredictably at narrow widths and you lose the read order.
- Each badge carries an icon, a primary label, and an optional secondary detail line. The icon is for scanning, the primary line is for reading, the secondary line is for the number.
- One ordering, always the same: pending first (it's an open action item), then the applied penalty (it's the consequence), then the audit (it's the paper trail). Consistent order means muscle memory.

## Pushing the logic out of the template

The thing I did *not* want was three blocks of ternaries inside the HTML computing labels and CSS classes. Angular templates are a miserable place to do branching logic, and I had ~40 provider modules each with their own record-search template that would all need the same rules. If the penalty-percent label lived in the template, I'd be copy-pasting it forty times and fixing the bug in thirty-nine of them later.

So the display logic lives in two plain TypeScript modules — `sale-penalty-display.ts` and `sale-audit-display.ts` — that take a sale-shaped object and return strings or `null`. `null` is the signal for "this fact isn't present, render nothing." For example, the pending-penalty label:

```ts
export function isPendingPenalty(sale?: SalePenaltyLike | null): boolean {
  return (
    sale?.hasPendingPenalty === true ||
    hasPendingSalePenaltyRequest(sale) ||
    hasPendingNonUpsellingPenaltyRequest(sale)
  );
}

export function getPendingPenaltyLabel(sale?: SalePenaltyLike | null): string | null {
  if (!isPendingPenalty(sale)) {
    return null;
  }
  const penaltyLabel = getPenaltyPercentLabel(getPenaltyPercentValue(sale));
  return penaltyLabel ? `Pending ${penaltyLabel}` : 'Pending penalty review';
}
```

Note `SalePenaltyLike` is a loose structural type — a bag of optional, nullable fields — not the generated GraphQL type. The penalty data comes back under slightly different field names across older provider schemas, and I'd rather accept anything shaped roughly right than fight the type system on forty different query results.

The audit module mirrors it. `hasAuditRecord` returns true on any of: an explicit `hasSaleAudit` flag, a positive `saleAuditCount`, or any non-empty audit metadata (latest auditor name, timestamp, id). That last fallback exists because some rows carry the audit detail without the boolean ever being set — a data inconsistency I'd rather paper over in display code than chase across the backend.

Then a row decorator stitches the helper outputs onto each table row as non-enumerable properties, so the template reads plain field accesses instead of calling functions:

```ts
Object.defineProperties(internalRow, {
  pendingPenaltyDisplay: {
    value: getPendingPenaltyLabel(sale) ?? '',
    enumerable: false,
    configurable: true,
  },
  salePenaltyLevelClass: {
    value: approvedPenalty ? (getSalePenaltyLevelClass(sale) ?? '') : '',
    enumerable: false,
    configurable: true,
  },
  auditStatusClass: {
    value: auditDeduction ? 'audit-deduction' : auditedSale ? 'audit-reviewed' : '',
    enumerable: false,
    configurable: true,
  },
  // ...pendingPenaltyDetail, salePenaltyDisplay, auditDisplay, tooltips, etc.
});
```

`enumerable: false` matters: these rows get spread, serialized, and dumped into CSV exports elsewhere, and I didn't want fifteen synthetic display fields leaking into the export. They're presentation, not data.

## The stack itself

With the labels and classes precomputed, the template stops being clever. The outer condition is just "is any of these true," and inside it each fact is an independent `@if` — no `@else`:

```html
@if (
  element["hasPendingPenalty"] === true ||
  (element["isPenalized"] === true && element["hasSalePenalty"] === true) ||
  element["hasNonUpsellingPenalty"] === true ||
  element["hasSaleAudit"] === true
) {
  <div class="row-status-stack">
    @if (element["hasPendingPenalty"] === true) {
      <div class="row-penalty-summary" [attr.title]="element['pendingPenaltyTooltip']">
        <span class="penalty-badge pending">
          <i class="material-icons">hourglass_empty</i>
          <span class="penalty-badge__content">
            <span class="penalty-badge__primary">
              {{ element["pendingPenaltyDisplay"] || "Pending penalty" }}
            </span>
            @if (element["pendingPenaltyDetail"]) {
              <span class="penalty-badge__secondary">{{ element["pendingPenaltyDetail"] }}</span>
            }
          </span>
        </span>
      </div>
    }

    @if (element["isPenalized"] === true && element["hasSalePenalty"] === true) {
      <div class="row-penalty-summary" [attr.title]="element['salePenaltyTooltip']">
        <span class="penalty-badge penalized"
              [ngClass]="element['salePenaltyLevelClass'] || element['penaltyLevelClass']">
          <i class="material-icons">gavel</i>
          <!-- primary + secondary -->
        </span>
      </div>
    }

    @if (element["hasSaleAudit"] === true || element["hasNonUpsellingPenalty"] === true) {
      <div class="row-penalty-summary" [attr.title]="element['auditTooltip']">
        <span class="penalty-badge audit" [ngClass]="element['auditStatusClass']">
          <i class="material-icons">
            {{ element["hasNonUpsellingPenalty"] === true ? "rule" : "fact_check" }}
          </i>
          <!-- primary + secondary -->
        </span>
      </div>
    }
  </div>
}
```

The `[ngClass]` bindings are how the same badge component carries different weight. `salePenaltyLevelClass` resolves to `penalty-level-10` through `penalty-level-100` depending on the deduction percent, so a 100% penalty is visibly heavier than a 10% one without a separate template. The audit badge swaps its icon — `rule` when the audit produced a no-upselling deduction, `fact_check` when it's just a clean review — because an audit that took money is a different thing than an audit that didn't, and the icon is the fastest way to say so.

The CSS for the stack is deliberately boring. It's a flex column with a gap, capped width so it doesn't shove the rest of the row around:

```scss
.row-status-stack {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  margin-top: 0.55rem;
  max-width: 15.25rem;
}

.row-status-stack .row-penalty-summary {
  margin-top: 0; // single-badge case has top margin; in the stack the gap handles it
  max-width: none;
}
```

That `margin-top: 0` override is the kind of thing you only find by looking at it. The single-badge `.row-penalty-summary` (the `@else` path, when a row has exactly one state) sets its own top margin. Drop it into the flex stack and you get the margin *plus* the flex gap between the first and second badge — uneven spacing that looks like a rendering glitch. Zeroing it inside the stack lets the gap be the single source of vertical rhythm.

## Where it bit me

The row-level background was the real trap. We tint the whole table row by status — `penalized-row` gets a red-ish gradient, `pending-penalty-row` gets amber with a left accent bar, `audited-row` gets a cool tint. Those are mutually exclusive in a way the badges are not, because a row can only have one background. So I had to decide which status owns the row tint when several are live.

I went with: penalty background wins, but a pending penalty *on top of* an existing penalty repaints it amber via a `.penalized-row.penalty-pending` compound selector. The badges show the full truth; the background shows the most urgent single thing. Trying to make the background also represent all three — striping it, splitting it — looked like a bug every single time I tried it. Some information genuinely wants one channel, and the badge stack is that channel here.

The other thing I'd flag: the giant `||` condition gating the stack has to stay in sync with the three inner `@if`s. If you add a fourth status badge and forget to add its clause to the outer guard, the whole stack silently won't render even though the inner condition would have matched. I've eyed pushing a single `hasAnyStatus` boolean onto the decorated row so the template has one thing to check instead of four — and I should, because "forgot to update two places" is exactly the bug class that started all this.

If I rebuilt it now I'd make the badge a real standalone component taking a typed `{ icon, primary, secondary, tooltip, variant }` input, and have the stack `@for` over an array the decorator builds. The current shape — flat `element['...']` accesses scattered across forty templates — works, but it's the version you ship under deadline, not the version you're proud of. The win that mattered was the cheap one: deleting three `@else`s and letting each fact speak for itself.
