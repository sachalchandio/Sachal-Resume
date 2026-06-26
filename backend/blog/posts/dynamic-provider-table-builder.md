---
title: "A no-code provider builder: generating sale entities from a JSON schema"
description: "Every new carrier meant a new entity, DTO, resolver and migration. So I made providers data, not code."
date: "2026-06-07"
updated: "2026-06-07"
kind: "deepdive"
category: "Architecture"
tags: ["meta-programming", "typeorm", "graphql", "no-code"]
month: "2026-06"
repo: "backend"
author: "Sachal Chandio"
---

Onboarding a new carrier was a checklist I had memorized, which is the first sign something is wrong. Copy `ZiplyFiberSale` to `NewIspSale`. Rename thirty columns. Copy the DTO. Copy the resolver. Copy the service — and the service is the big one, because it carries the validation, the package resolution, the fronter rules, the queue jobs that index the sale and compute PSU. Wire it into `app.module.ts`. Add the provider's value to the `saleType` enum. Generate a migration. Add the new sale type to `search-indexing.service.ts`, to `salary-generation.processor.ts`, to `sale-stage.service.ts`. Miss one of those last three and the sale saves fine but never shows up in search, or generates no commission, and you find out three weeks later when an agent asks where their money is.

By the time we had thirty providers this was a day of work and a guaranteed source of copy-paste bugs. Every provider was 95% identical to the last one. The 5% that differed — which fields exist, what the packages are, which field is the order number — was config wearing the costume of code.

So I stopped writing providers as code and made them rows in a database.

## What "a provider" actually is

Strip away the ceremony and a provider is four things: a set of fields, the types and validation on those fields, a mapping from some of those fields to the canonical concepts the rest of the system needs (which column is the customer's phone, which is the order date), and a set of package pickers bound to entries in the package catalog. That's it. None of it needs a TypeScript class. All of it fits in a schema you can store and edit.

The builder defines a provider as data across four definition tables and writes sales into two shared runtime tables. The definition side:

- `provider_form` — one row per provider. Identity and presentation: `providerCode`, `name`, nav `icon`, `accentColor`, and a pointer to the currently published version.
- `provider_form_version` — an immutable snapshot of a definition, same pattern as our `package_version` table. Every sale pins the version it was created under.
- `provider_form_field` — one row per field per version. Its `dataType`, whether it's `required`, its `validation` and `rules` as JSON, and — the load-bearing part — an optional `systemMapping`.
- `provider_form_audit_log` — append-only, who changed what.

And the runtime side is two tables, `dynamic_sale` and `dynamic_sale_package_value`, shared by every builder-made provider. One table for all of them, not one per provider. I'll come back to why that's the whole ballgame.

A field row looks like this. The JSON-ish payloads live in `text` columns and surface as `String` in GraphQL — the same convention we use for grouped package data:

```ts
@Entity('provider_form_field')
@Index('UQ_provider_form_field_version_fieldKey', ['formVersionId', 'fieldKey'], { unique: true })
export class ProviderFormField extends BaseEntity {
  @Column({ length: 50 }) fieldKey: string;       // stable machine name, e.g. "internet"
  @Column({ length: 150 }) label: string;
  @Column({ type: 'varchar', length: 30 }) dataType: FieldDataType;

  // the canonical slot this field feeds, if any
  @Column({ type: 'varchar', length: 30, nullable: true })
  systemMapping?: SystemFieldMapping | null;

  @Column({ default: false }) required: boolean;
  @Column({ type: 'text', nullable: true }) validation?: string | null;   // JSON
  @Column({ type: 'text', nullable: true }) rules?: string | null;        // JSON
  @Column({ type: 'text', nullable: true }) packageBinding?: string | null; // JSON

  // a field that already holds sale data can be hidden but never deleted
  @Column({ default: true }) isActive: boolean;
  @Column({ default: false }) fronterEditable: boolean;
  @Column({ default: true }) showInTable: boolean;
}
```

## The decision that makes the rest tractable: system slots

The hard part of going schema-driven isn't rendering a form. It's that the rest of the system has hard expectations. The search indexer wants a customer first name. Salary generation wants an order date and a sale status to decide if commission is owed. The sale-stage system keys on a phone number. If a provider's fields are arbitrary, none of those subsystems know which arbitrary field is the phone.

The naive version I sketched first let every field be free-form and tried to guess — match a field labelled "Phone" or typed `PHONE` to the phone concept. That falls apart the moment a provider has two phone fields, or labels it "Contact Number," or has a `PHONE`-typed field that's actually the *fronter's* callback line, not the customer's. So I made the mapping explicit. There's a fixed enum of canonical slots, and a field can claim one:

```ts
export enum SystemFieldMapping {
  FIRST_NAME = 'FIRST_NAME',
  LAST_NAME = 'LAST_NAME',
  PHONE = 'PHONE',
  EMAIL = 'EMAIL',
  ORDER_NUMBER = 'ORDER_NUMBER',
  ORDER_DATE = 'ORDER_DATE',
  STATE = 'STATE',
  SALE_STATUS = 'SALE_STATUS',
  INSTALLATION_DATE = 'INSTALLATION_DATE',
  // … 17 in total
}

// these eight must be mapped before a form can go live
export const REQUIRED_SYSTEM_MAPPINGS: SystemFieldMapping[] = [
  SystemFieldMapping.FIRST_NAME,
  SystemFieldMapping.LAST_NAME,
  SystemFieldMapping.PHONE,
  SystemFieldMapping.EMAIL,
  SystemFieldMapping.ORDER_NUMBER,
  SystemFieldMapping.ORDER_DATE,
  SystemFieldMapping.STATE,
  SystemFieldMapping.SALE_STATUS,
];
```

A provider can call its fields whatever it wants, in whatever order. But to publish, it has to tell the platform which field *is* the order number. The canonical eight become real, indexed columns on `dynamic_sale`; everything else lands in a `customData` JSON blob. That split is the design's spine — every hot query (by provider, date, agent, order number, status) hits a real indexed column, and the long tail of provider-specific fields rides along in JSON where it's cheap and rarely filtered.

The mapping back out, at sale time, is a lookup table:

```ts
const SYSTEM_MAPPING_TO_INPUT_KEY: Partial<Record<SystemFieldMapping, keyof CreateDynamicSaleInput>> = {
  [SystemFieldMapping.FIRST_NAME]: 'cx_firstName',
  [SystemFieldMapping.PHONE]: 'phoneNumber',
  [SystemFieldMapping.ORDER_NUMBER]: 'orderNumber',
  [SystemFieldMapping.ORDER_DATE]: 'orderDate',
  // …
};
```

## Validation without an entity to hang it on

Legacy providers validated in `@BeforeInsert` hooks on the entity class. No entity here, so validation became a function that walks the definition and checks the payload against it. It returns every problem at once rather than failing on the first — fronters submit a dozen fields, and trickling out one error per round-trip is its own special cruelty.

The interesting part isn't the per-type checks (a `PHONE` is ten digits, a `ZIPCODE` is five), it's the dependency rules. A field can declare `REQUIRE_IF` / `FORBID_IF` against another field's value — how "if service type is OTHER, sub-category is required" becomes data instead of a hand-coded branch:

```ts
function isFieldRequired(field, values) {
  let required = field.required;
  let forbidden = false;

  for (const rule of field.rules || []) {
    const other = String(values[rule.whenField] ?? '');
    let matches = false;
    if (rule.equals !== undefined) matches = other === rule.equals;
    else if (rule.notEquals !== undefined) matches = other !== rule.notEquals;

    if (rule.type === 'REQUIRE_IF' && matches) required = true;
    if (rule.type === 'FORBID_IF' && matches) forbidden = true;
  }
  return { required, forbidden };
}
```

One guard I'm glad I added: any key in the submitted `customData` that isn't part of the form version is rejected outright. Without it, a stale frontend or a hand-crafted mutation could smuggle arbitrary keys into the JSON blob, and JSON blobs are exactly where garbage goes to live forever undetected.

## Packages as rows, not columns

Legacy sales stored package choices as foreign-key columns — `internetPackageId`, `tvPackageId`, hardcoded per provider. Then commission code carried a per-provider `packageFields[]` list naming which columns count toward commission. Add a provider, edit three of those hardcoded maps, hope you got all three.

A builder provider can have any number of package pickers, so columns are out. Each selection becomes a row in `dynamic_sale_package_value` carrying the `package_version` FK and a `countsCommission` flag read straight off the field's binding. Commission and PSU computation became one generic query over rows instead of N hardcoded column maps. The price is a join — bounded by package fields per form, two to six, batched everywhere it's read. I'll take a bounded, batched join over a hardcoded map I have to remember to edit.

The publish gate enforces that bindings are real. You can't ship a `PACKAGE_SELECT` field pointing at a provider/service-type combination with zero active packages:

```ts
const matching = await this.packageRepository.count({ where });
if (matching === 0 && field.required) {
  throw new BadRequestException(
    `Field "${field.fieldKey}": no active packages match its binding ` +
      `(${binding.providerCode}/${binding.serviceType}) — ` +
      'create the packages in package management first',
  );
}
```

## Publishing, and why versions are immutable

Drafts are mutable. Published versions are frozen — same temporal pattern as packages. Editing a published form doesn't rewrite it; it opens a new draft version, and the old sales keep pointing at the version they were born under. That single rule is what spares me a class of migration I never want to write again: I never have to backfill old `dynamic_sale` rows when a definition changes, because old rows are interpreted by their own pinned version, not the current one.

Publishing does three things in order: validate the definition (all eight required slots mapped, every package binding real, `SALE_STATUS` mapped to an actual package picker), create the `provider` catalog row if it doesn't exist yet, then flip the version to published. That `ensureProviderRow` step closed an old papercut — providers used to be born only from seed scripts, so package management couldn't see a new provider until someone ran one by hand. Now publishing a form makes the provider appear in package management automatically.

What that buys, end to end: an admin builds a form in the UI, publishes it, a nav tab appears, agents start submitting sales — and sale stages, comments, tasks, penalties, QA audits, search indexing, salary reports all work, because every one of those keys on `(saleId, DYNAMIC_SALE)` and reads the canonical columns the slots populate. Zero new entities. Zero migrations. Zero deploys.

## The sharp edges, because there are several

Going schema-driven is a trade, not a free win. Here's where it bit.

**The shared enum value will rebuild your tables if you let it.** Every sale-bearing table has a `saleType` enum column. I had to add one `DYNAMIC_SALE` value to all of them. An earlier provider migration had inserted its enum value *in the middle* of the list, which forces MySQL to rewrite the entire table — and `comment`, `tasks`, and `sale_stage` are big — plus a drop-and-recreate of indexes. Appending the value at the **end** of the enum instead makes the `ALTER` an in-place metadata change: `LOCK=NONE`, near-instant on a table of any size. The catch is forever: every future enum value has to be appended last, and I had to reorder the TS enum to match the DB. Cheap discipline, but it's discipline you can't forget.

**Custom fields in JSON can't be indexed — until they can.** Anything not promoted to a system slot lives in `customData` TEXT. Filtering on one means a JSON parse over the provider's slice of the table. Fine until a custom field becomes a hot filter, at which point the escape hatch is one statement, no redesign:

```sql
ALTER TABLE dynamic_sale
  ADD COLUMN custom_planTier VARCHAR(50)
    GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(customData, '$.planTier'))) STORED,
  ADD INDEX IDX_dynamic_sale_planTier (providerCode, custom_planTier);
```

I deliberately did *not* pre-create generated columns for every custom field. That pays a write cost on every insert for filters nobody runs. Promote a column the day it earns it.

**You cannot delete a field that holds data.** Once a provider has sales, a field from the published version can be hidden (`isActive = false`) but never removed — historical rows reference it by `fieldKey` inside `customData` and the package-value rows. The builder enforces it: it counts existing sales and refuses to publish a version that drops a data-bearing field, telling you to hide it instead. Get this wrong and old sales become unreadable, which is the no-code equivalent of a `DROP COLUMN` in production.

**One table, every provider — and that's the point, not a compromise.** I considered table-per-provider with runtime DDL. It's a trap. No TypeORM entity, no repository, migration chaos, and `CREATE TABLE` from user input is an injection surface I refuse to own. The shared table works because every hot index is prefixed by `providerCode`, so one provider's volume only deepens its own B-tree slice — roughly one extra page read per hundredfold growth. We have headroom to about ten million `dynamic_sale` rows before any structural change, with `PARTITION BY KEY(providerCode)` as an online fallback past that. The cross-provider paths that do exist (global search, salary) already run through `search_index` and `sale_stage`, which all thirty legacy providers share anyway. Nothing got worse; one thing got generic.

## Where I'd draw the line differently

I would not build this for a system with three providers. The whole thing earns its complexity precisely because we had thirty near-identical ones and a steady drip of new carriers. Below some threshold, the clone-an-entity tax is cheaper than a meta-programming layer, a builder UI, a validation engine, and a publish state machine you now have to maintain forever. Schema-driven trades per-provider code for a permanent platform you own. That's a good trade at thirty, a bad one at three.

The honest limit of "no-code" is that it's really "no-code for the shapes you anticipated." My field types and rules cover the providers we have. The day a carrier needs a field that depends on *two* others, or a package picker filtered by an earlier selection at runtime, or a computed field — that's a new capability in the engine, written in code, by me. The builder didn't abolish provider engineering. It moved it from "once per provider" to "once per genuinely new kind of field," and on a platform where the providers rhyme, that's most of the win. The first time someone asks for something the schema can't express, resist the urge to bolt a `customScript` field onto it. That's the door to a worse codebase than the thirty copy-pasted services I started with.

The thing I keep coming back to: the design didn't get good when I figured out how to generate a form from data. It got good when I admitted which eight things every provider *must* have in common and made the system refuse to publish until you'd said where they were. The flexibility is the easy half. The non-negotiable spine is what makes the flexibility safe.
