---
title: "Re-parenting audits from call logs onto dispositions"
description: "A structural change so one lead can carry many dispositions and many audits over time."
date: "2025-03-21"
updated: "2025-03-21"
kind: "deepdive"
category: "Architecture"
tags: ["data-modeling", "typeorm"]
month: "2025-03"
repo: "backend"
author: "Sachal Chandio"
---

A QA lead pinged me because she couldn't audit a customer twice. The lead had moved from "No Answer" to "Interested" to "Sold" over three weeks, and she wanted a separate audit on each of those calls. The form let her save the first one. The second one silently overwrote it. No error, no warning — the old audit just stopped existing.

That's not a UI bug. That's the schema telling the truth about a model that was wrong from the start.

## How audits were wired

A `LeadAuditForm` belonged to an `InterestedCustomer` — what we call a "lead" or, internally, a call log. One audit, one lead, joined directly. The original relation looked like this:

```ts
@Field(() => InterestedCustomer)
@OneToOne(() => InterestedCustomer, (lead) => lead.auditForm, {
  nullable: false,
  eager: true,
})
@JoinColumn({ name: 'leadId' })
lead: InterestedCustomer;
```

`@OneToOne`. That's the whole problem in one decorator. A lead can hold exactly one audit, forever, because `leadId` carries a unique index. The first time I shipped this it felt fine — back then an "audit" was a one-time thing a QA agent did on a fresh lead. The product grew past that assumption without anyone deciding it should.

The thing a lead actually accumulates is *disposition changes*. Someone calls, marks them "Callback." Calls again next week, marks them "Interested." Each of those transitions is a real event with its own recorded line, its own conversation, its own thing worth auditing. We already stored those as `CallDispositionHistory` rows — every change to a lead's disposition wrote one, with `previousDisposition`, `updatedDisposition`, a comment, and who made it. The audits were hanging off the wrong noun. They belonged to the *call*, not to the *customer*.

So the shape I wanted was a chain:

```
InterestedCustomer
   └── many CallDispositionHistory   (one per disposition change)
          └── many LeadAuditForm      (one per QA audit of that change)
```

A lead carries many dispositions. A disposition carries many audits. Walk both edges and you get the full history a single customer has ever generated.

## The version I rejected

My first instinct was to keep `leadId` and just drop the unique constraint — make it `@ManyToOne` straight to the customer. Two-line change. Cheap.

I'm glad I didn't. It would have let a lead hold many audits, sure, but every audit would still float free of *which call* it described. You'd have ten audits on one customer and no way to say "this one is about the day she went from Callback to Interested." The QA team's actual question — "show me the audit for this specific disposition change" — would still be unanswerable. The cheap fix solves the symptom (overwriting) and leaves the disease (audits aren't attached to the event they audit).

The other option floated in review was a polymorphic `auditableType` / `auditableId` pair so an audit could point at a call log *or* a disposition. We do that elsewhere for sale audits. But there was no second parent here. Audits attach to disposition changes, full stop. Polymorphism would have bought flexibility I'd never spend and cost me the foreign key — MySQL won't enforce referential integrity across a column whose target table changes per row. I'd rather have the constraint than the imaginary headroom.

## The re-parenting

Two migrations, deliberately split.

First, add the new parent column and its foreign key to the disposition table, leaving the old `leadId` in place so nothing breaks mid-deploy:

```ts
// 1743157507157-MultLogDispoistionsAndDispositionAudit
await queryRunner.query(
  `ALTER TABLE \`lead_audit_form\` ADD \`dispositionHistoryId\` varchar(36) NULL`,
);
await queryRunner.query(
  `ALTER TABLE \`lead_audit_form\` ADD CONSTRAINT \`FK_a3932c08ba3ef8d1938c687f68a\`
   FOREIGN KEY (\`dispositionHistoryId\`)
   REFERENCES \`call_disposition_history\`(\`id\`)
   ON DELETE NO ACTION ON UPDATE NO ACTION`,
);
```

Note it's nullable. It has to be — at this point existing rows have a `leadId` and no `dispositionHistoryId`. Then, once the new column was populated, the second migration dropped the old edge entirely:

```ts
// 1743164978846-DispositionsHaveAuditsInsteadOfCallLogs
await queryRunner.query(
  `ALTER TABLE \`lead_audit_form\` DROP FOREIGN KEY \`FK_8010582bf1edf1929302ffdb596\``,
);
await queryRunner.query(
  `DROP INDEX \`REL_8010582bf1edf1929302ffdb59\` ON \`lead_audit_form\``,
);
await queryRunner.query(
  `ALTER TABLE \`lead_audit_form\` DROP COLUMN \`leadId\``,
);
```

That `REL_...` index is the unique constraint TypeORM generates for a `@OneToOne` join column. Dropping it is the literal moment "one audit per lead" stops being a rule the database enforces. Generate these with `typeorm migration:generate` — do not hand-write the foreign-key names. I learned that the boring way; the autogenerated `FK_a3932c08...` hashes have to match what TypeORM expects on the next diff or you fight phantom changes forever.

The entities now read the way the domain actually works. On the disposition side:

```ts
// CallDispositionHistory
@Field(() => [LeadAuditForm], { nullable: true })
@OneToMany(() => LeadAuditForm, (auditForm) => auditForm.dispositionHistory, {
  cascade: true,
})
dispositionAudits: LeadAuditForm[];
```

And the audit points back up:

```ts
// LeadAuditForm
@Field(() => CallDispositionHistory, { nullable: true })
@ManyToOne(() => CallDispositionHistory, (history) => history.dispositionAudits, {
  nullable: true,
})
@JoinColumn({ name: 'dispositionHistoryId' })
dispositionHistory: CallDispositionHistory;
```

The `InterestedCustomer` keeps its `@OneToMany` to `CallDispositionHistory`, untouched. The lead still owns its dispositions; it just no longer pretends to own audits directly.

## Returning the history the UI needs

The lead detail page wants every audit a customer has ever received, grouped under the disposition it describes, with the auditor and the customer hydrated. The lead is now two joins away from its audits, so the read walks the chain backwards:

```ts
async findAuditForLead(leadID: string): Promise<AuditForLeadDto[]> {
  const audits = await this.leadAuditFormRepository.find({
    where: { dispositionHistory: { customer: { id: leadID } } },
    relations: ['auditBy', 'dispositionHistory', 'dispositionHistory.customer'],
  });

  return audits.map((audit) => this.mapAuditToAuditForLeadDto(audit));
}
```

That nested `where` — `dispositionHistory: { customer: { id } }` — is TypeORM compiling the two-hop join for you: audit → disposition → customer. Before the refactor this was a flat `where: { lead: { id } }`. One extra hop, and now it returns a list instead of swallowing all but the newest.

The filtered/paginated grid does the same thing in query-builder form, where the joins are explicit:

```ts
const queryBuilder = this.leadAuditFormRepository
  .createQueryBuilder('audit')
  .leftJoinAndSelect('audit.auditBy', 'user')
  .leftJoinAndSelect('audit.dispositionHistory', 'disposition')
  .leftJoinAndSelect('disposition.customer', 'lead')
  .leftJoinAndSelect('lead.user', 'leadUser');
```

The DTO mapper had to learn the new path too. Customer fields used to come off `audit.lead`; now they come off `audit.dispositionHistory.customer`. Tedious rename, but it's where the data lives now:

```ts
lead: audit.dispositionHistory?.customer
  ? {
      id: audit.dispositionHistory.customer.id,
      firstName: audit.dispositionHistory.customer.firstName,
      phoneNumber: audit.dispositionHistory.customer.phoneNumber,
      callDisposition: audit.dispositionHistory.customer.callDisposition,
      // …
    }
  : null,
```

## The guardrail I almost forgot

Here's where the model bites back if you're not careful. A disposition change isn't real until someone approves it — agents *request* a change, and it sits at `ApprovalStatus.PENDING` until a manager signs off or rejects it. So what happens if QA audits a disposition that's still pending, and then the manager rejects it?

You'd have an audit attached to a call transition that, officially, never happened. The audit hangs off a `CallDispositionHistory` row that's about to be reversed. Garbage data with a foreign key pointing at it.

So the create path refuses it:

```ts
const dispositionHistory =
  await this.callDispositionHistoryService.findOne(dispositionHistoryId);

if (!dispositionHistory) {
  throw new NotFoundException('Disposition History not found');
}

if (dispositionHistory.approvalStatus === ApprovalStatus.PENDING) {
  throw new BadRequestException(
    'Cannot create audit for pending disposition history',
  );
}
```

Three lines. You audit a change after it's settled, never while it's in limbo. The `@OneToOne` schema couldn't have expressed this rule even if I'd wanted it to, because under the old model an audit wasn't attached to a transition at all — there was no approval state in scope to check.

## What I'd watch for

The `dispositionHistoryId` column is still nullable, and that's a small lie I'm living with. Every audit created through the service has a parent — the create path won't let it be otherwise — but the column can't promise it the way a `NOT NULL` would. The honest move is a follow-up migration to backfill any orphans and tighten the column, and I haven't done it. It's on the list, under things that aren't on fire.

The lesson that actually transfers: when a "save" silently overwrites instead of erroring, look at the cardinality before you touch the form. The bug wasn't in the UI and it wasn't in the validation. It was a `@OneToOne` that should have been a `@ManyToOne`, two tables over from where the symptom showed up. The fix was to attach the record to the event it describes — the disposition change — instead of to the customer it vaguely concerned. Audits describe calls. They should hang off calls. Everything after that was just migrations.
