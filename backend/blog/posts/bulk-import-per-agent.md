---
title: "Bulk-importing AT&T sales per agent without melting the database"
description: "Ingesting spreadsheet rows straight into typed entities, one agent at a time."
date: "2024-08-20"
updated: "2024-08-20"
kind: "deepdive"
category: "Backend"
tags: ["import", "nestjs", "bulk"]
month: "2024-08"
repo: "backend"
author: "Sachal Chandio"
---

Onboarding AT&T meant we had two months of sales sitting in a spreadsheet that someone on their side maintained by hand. Per agent. One tab per rep, a few hundred rows each, and a header layout that drifted column-to-column depending on who'd last touched it. The ask was simple to say and annoying to do: get all of it into Telelinkz as real sale records, attributed to the right agent, with the right provider-specific status enums, so the dashboards and commission math just work.

No CSV upload endpoint existed yet. The existing sales flow assumed a human creating one sale at a time through the UI. So the first decision was whether to write a throwaway script or build an actual import feature. I built the feature, because I knew the next provider onboarding would want the same thing, and a script that lives in someone's `~/scratch` folder is a script nobody can find in three months.

## The shape of the problem

A sale in our world is not a flat row. It's a typed entity with foreign keys to an agent, a fronter, a provider, and a status that is meaningful per provider. AT&T does not have the same status vocabulary as the other carriers we carry. Their "Pending Install" is not our generic `PENDING`. So the import couldn't be a dumb column-to-column copy — it had to translate.

Here's the entity, trimmed to what matters:

```ts
@Entity('sales')
export class Sale {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  orderNumber: string;

  @Column({ type: 'enum', enum: AttSaleStatus })
  status: AttSaleStatus;

  @ManyToOne(() => Agent, { nullable: false })
  agent: Agent;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: string;

  @Column({ type: 'date' })
  saleDate: Date;
}
```

The `AttSaleStatus` enum is the provider-specific bit. The spreadsheet had a free-text "Status" column with values like `Pending Install`, `Installed`, `Cancelled - No Show`, and a few typos of each. Mapping that to a clean enum was the part that earned its keep, because once a bad status string slips into the table you're chasing it through the commission report a week later.

```ts
export enum AttSaleStatus {
  PendingInstall = 'PENDING_INSTALL',
  Installed = 'INSTALLED',
  Cancelled = 'CANCELLED',
  NoShow = 'NO_SHOW',
}

const ATT_STATUS_MAP: Record<string, AttSaleStatus> = {
  'pending install': AttSaleStatus.PendingInstall,
  installed: AttSaleStatus.Installed,
  cancelled: AttSaleStatus.Cancelled,
  'cancelled - no show': AttSaleStatus.NoShow,
};
```

I lowercased and trimmed the incoming string before the lookup. Anything that didn't resolve became a row-level error rather than a silent `null` — more on why that mattered in a second.

## Parse first, then validate, then map

The flow I settled on has three distinct stages, and keeping them separate is what kept the code from turning into a swamp.

Stage one is pure parsing: take the uploaded XLSX, pull out the rows for one agent's tab, and hand back an array of plain objects keyed by the header names. I used a small sheet-reading lib for this and did not let any business logic leak in. Garbage in, plain objects out.

Stage two validates and coerces each row into a typed shape — a DTO, basically — and this is where the status map, the date parsing, and the amount parsing live. A row either becomes a clean `ParsedSaleRow` or it becomes an error with its row number attached.

```ts
function parseRow(raw: Record<string, string>, rowIndex: number): ParsedSaleRow | RowError {
  const statusKey = (raw['Status'] ?? '').trim().toLowerCase();
  const status = ATT_STATUS_MAP[statusKey];
  if (!status) {
    return { rowIndex, reason: `Unknown status: "${raw['Status']}"` };
  }

  const amount = Number(raw['Amount']?.replace(/[$,]/g, ''));
  if (Number.isNaN(amount)) {
    return { rowIndex, reason: `Bad amount: "${raw['Amount']}"` };
  }

  return {
    rowIndex,
    orderNumber: raw['Order #'].trim(),
    status,
    amount: amount.toFixed(2),
    saleDate: parseSheetDate(raw['Sale Date']),
  };
}
```

Stage three is the insert. And here's the decision the whole post hangs on.

## One agent, one transaction — not one giant insert

The naive version, which I will admit I wrote first, was a single `repository.save(allRows)` across every agent at once. It worked in my local test with the two clean tabs I'd hand-picked. Then I ran it against the real export and one row in agent fourteen's tab had a malformed date, the transaction rolled back, and I had imported exactly zero sales for everyone. Forty-some agents held hostage by one bad cell.

So I scoped the unit of work to a single agent. Each agent's rows go in their own transaction. A bad row in one agent's batch fails that agent's batch and only that one — the other thirty-nine still land. The blast radius of any single mistake is one rep, not the whole carrier.

```ts
async importAgentSales(agentId: string, rows: ParsedSaleRow[]): Promise<ImportResult> {
  return this.dataSource.transaction(async (manager) => {
    const agent = await manager.findOneByOrFail(Agent, { id: agentId });

    const sales = rows.map((r) =>
      manager.create(Sale, {
        agent,
        orderNumber: r.orderNumber,
        status: r.status,
        amount: r.amount,
        saleDate: r.saleDate,
      }),
    );

    // chunk so we don't build one absurd multi-thousand-row INSERT
    await manager.save(sales, { chunk: 100 });
    return { agentId, inserted: sales.length };
  });
}
```

The `chunk: 100` is not decoration. TypeORM's `save` builds a single multi-row `INSERT` by default, and MySQL has a hard ceiling on packet size (`max_allowed_packet`) plus a placeholder limit you'll hit long before that. A few hundred rows per agent is fine, but I'd rather the code not care how big a tab gets. Chunking caps each statement at a sane size and the whole thing still runs inside the one transaction.

At the orchestration level I loop the agents and collect outcomes instead of letting one rejection kill the loop:

```ts
const results: ImportResult[] = [];
for (const [agentId, rows] of groupedByAgent) {
  try {
    results.push(await this.importAgentSales(agentId, rows));
  } catch (err) {
    results.push({ agentId, inserted: 0, error: String(err.message) });
  }
}
```

Sequential, deliberately. I considered firing them all off with `Promise.all`, but forty concurrent transactions against the same MySQL box during business hours is a good way to find out what your connection pool's max is, the hard way. The whole import takes a few seconds run serially. Not worth the lock contention to shave it.

## Wiring the resolver and the upload

The GraphQL side is thin on purpose. The mutation takes the uploaded file and the provider, parses, and returns a per-agent summary so the frontend can show exactly what landed and what didn't.

```ts
@Mutation(() => SaleImportSummary)
async importAttSales(
  @Args({ name: 'file', type: () => GraphQLUpload }) file: FileUpload,
  @Args('providerId') providerId: string,
): Promise<SaleImportSummary> {
  const grouped = await this.importParser.parseWorkbook(file, providerId);
  return this.salesImportService.run(grouped);
}
```

On the Angular side it's a file input, an Apollo mutation, and a results table. The one thing I made sure of: the summary that comes back lists every agent with their inserted count and any row-level errors, so whoever ran the import sees `Agent 14: 2 rows skipped — Bad amount on row 31` instead of a green checkmark that lies. An import tool that only tells you it succeeded is worse than no tool, because people trust it.

## The sharp edges

Dates were the worst of it. The spreadsheet stored some dates as real Excel serial numbers and others as the string `8/3/2024`, in the same column, because two different people had typed into it. `new Date('8/3/2024')` parses in a way that depends on locale and silently gives you the wrong day half the time. I ended up with an explicit `parseSheetDate` that checks if the cell is a number (serial) versus a string and handles each path, and throws loudly on anything else rather than guessing.

Duplicate order numbers were the second edge. Re-running the import — which people do, because the first run surfaces errors they then go fix in the sheet — would have created doubles. I added a unique constraint on `(provider, orderNumber)` and made the importer treat a duplicate-key error as a skip-with-reason, not a failure. Idempotent enough that a second run only inserts the rows that the first run rejected.

The third was trusting headers. Early on I keyed off column position. The day someone inserted a column in the middle of one tab, every field shifted by one and I was writing the amount into the date field. Keying off the header name fixed it, at the cost of having to normalize header strings because `Order #` and `Order#` and `ORDER #` all show up.

## What I'd do differently

I'd push the actual insert work onto a Bull queue. Right now the import runs inside the request and the user waits on the HTTP response. For a few hundred rows that's fine — it's seconds. But the moment a carrier shows up with twelve thousand rows, that request is going to time out behind a load balancer and the user will retry, and now I've got two imports racing. A queued job with a progress channel over Redis pub/sub is the right shape, and the per-agent transaction design already maps cleanly onto one job per agent. I just didn't need it yet, and I'd rather not build the queue plumbing before there's a row count that demands it.

The other thing: I'd move the status map out of code and into a small config table per provider. Every new carrier means a new enum and a new hand-written map, and that's a deploy each time. A `provider_status_mappings` table that an admin can edit would let onboarding happen without me. I knew that while I was writing the AT&T map. I shipped the hardcoded version anyway, because AT&T was the one carrier in front of me and I'd rather solve the second one when it's real than guess at the abstraction now.

If there's a lesson in here it's the per-agent transaction boundary. Pick the unit of work that matches the unit of human ownership. One agent's data failing should never take down another agent's data, because the person fixing it only owns the one tab — and an import that fails all-or-nothing turns a five-minute spreadsheet correction into a forty-agent incident.
