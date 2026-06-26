// Build-log content, sourced from the commit history of the Telelinkz
// backend (NestJS/GraphQL) and frontend (Angular) repositories. Newest first.

export interface DevlogSection {
  heading: string;
  icon: string;
  body: string;
  bullets?: string[];
}

export interface DevlogPost {
  slug: string;
  period: string;
  date: string;
  title: string;
  summary: string;
  tags: string[];
  stats: { commits: number; backend: number; frontend: number };
  sections: DevlogSection[];
}

export const POSTS: DevlogPost[] = [
  {
    "slug": "2026-06",
    "period": "June 2026",
    "date": "2026-06-30",
    "title": "No-code providers, an app-wide profile primitive, and two new carriers",
    "summary": "The month I turned provider onboarding into a no-code table builder, shipped AltaFiber and Blazing Hog end to end, and made every name in the app click through to a profile.",
    "tags": [
      "Dynamic systems",
      "NestJS",
      "Angular",
      "GraphQL",
      "AltaFiber"
    ],
    "stats": {
      "commits": 80,
      "backend": 34,
      "frontend": 46
    },
    "sections": [
      {
        "heading": "Providers without a deploy",
        "icon": "layers",
        "body": "Every new carrier used to mean a new entity, DTO, form, and migration. This month I built a Provider Table Builder — a no-code path where a provider's fields, sale form, and runtime are defined as data instead of code. Onboarding a carrier becomes configuration, not a release.",
        "bullets": [
          "Dynamic provider forms plus a generic runtime module on the frontend",
          "Server-side dynamic sales keyed off a provider code and schema",
          "A DevLens request tracer to watch the dynamic queries in flight"
        ]
      },
      {
        "heading": "Two carriers, fully wired",
        "icon": "bolt",
        "body": "AltaFiber and Blazing Hog both went live — not just a form, but the whole spine: enums, entities, GraphQL, sale filters, commission and payout stats, and PII anonymization. A sale is useless until it flows through earnings, so this is the unglamorous wiring that makes it real.",
        "bullets": [
          "AltaFiber into salary generation, commissions, and performance stats",
          "Blazing Hog provider module with its own seed and tests"
        ]
      },
      {
        "heading": "One name, one click, everywhere",
        "icon": "user",
        "body": "I extracted a single app-wide profile primitive: any name or avatar — an agent, a fronter, or the current user — opens the same profile dialog. Dozens of one-off open-profile call sites collapsed into one service.",
        "bullets": [
          "An openSelf() shortcut and a shared profile-open service",
          "Clickable agent and fronter names straight from record search and sales"
        ]
      },
      {
        "heading": "Inventory that remembers",
        "icon": "data",
        "body": "I finished the inventory assignment-history subsystem and a mandatory-condition return-to-inventory flow, so every unit carries a full, auditable trail of who held it and in what state it came back."
      }
    ]
  },
  {
    "slug": "2026-05",
    "period": "May 2026",
    "date": "2026-05-31",
    "title": "Scaling penalties to bulk, making sales searchable, and fixing the call audio",
    "summary": "The month I matured the penalty system into bulk approvals and summaries, added full-text sale search backed by real indexing, and cleaned up call-recording playback across the app.",
    "tags": [
      "Penalties",
      "Search",
      "Indexing",
      "Audio",
      "Access control"
    ],
    "stats": {
      "commits": 75,
      "backend": 17,
      "frontend": 58
    },
    "sections": [
      {
        "heading": "Penalties at scale",
        "icon": "check",
        "body": "Reviewing penalties one at a time didn't hold up, so I added bulk sale-penalty approval APIs and a UI to match. I introduced a LEVEL_10 ten-percent tier, penalty summary lookups with admin checks, and commissionableFields so penalties correctly shape what gets paid. Audit and pending-penalty badges now show right on the records, and I revamped the penalty UI with a user filter dropdown.",
        "bullets": [
          "Bulk penalty approval APIs and matching UI",
          "LEVEL_10 (10%) penalty tier and commissionableFields for commission control",
          "Audit and pending-penalty badges on records, plus a user-filter dropdown"
        ]
      },
      {
        "heading": "Making sales searchable",
        "icon": "search",
        "body": "Sales had grown to the point where filtering wasn't enough. I added full-text search over sales with package lookup, then backed it with real indexing across sales, audit-penalty, and billing-visibility paths. I also refactored sale queuing and did a targeted index re-sync so search stays fast without re-indexing the world.",
        "bullets": [
          "Full-text sale search with package lookup",
          "Indexes on sales, audit-penalty, and billing visibility",
          "Refactored sale queuing with targeted index re-sync"
        ]
      },
      {
        "heading": "Call audio that actually plays",
        "icon": "message",
        "body": "Call recordings had inconsistent durations and a janky seek, so I normalized audio duration and time handling, improved seeking, and propagated and cached durations so they don't recompute on every load. I also fixed a disposition display bug where the call log showed the literal label instead of the real disposition.",
        "bullets": [
          "Normalized audio duration/time and improved seek",
          "Propagated and cached audio durations to avoid recomputation",
          "Fixed disposition showing a placeholder instead of the actual call log value"
        ]
      },
      {
        "heading": "Roles and access tightening",
        "icon": "lock",
        "body": "I expanded the access model with QA Manager access, retention user types, and broader bank roles, while blocking HR password changes and redirecting billing users away from the task root they shouldn't land on. Small guardrails, but they keep each role inside its lane — and I added tests around the billing redirect.",
        "bullets": [
          "QA Manager access, retention user types, and expanded bank roles",
          "Blocked HR password changes; redirected billing users from the task root",
          "Renamed AMERICAN_BUSINESS to GENERIC_BUSINESS_FORM for clarity"
        ]
      }
    ]
  },
  {
    "slug": "2026-04",
    "period": "April 2026",
    "date": "2026-04-30",
    "title": "Wiring in the dialer, auditing sales, and putting penalties on the books",
    "summary": "The month I integrated Dialer360 and reconciled its agents against our users, built a sale-audit and QA pipeline, and shipped a full penalty system with levels and role-gated access.",
    "tags": [
      "Dialer360",
      "Sale Audits",
      "Penalties",
      "Access control",
      "DishTV"
    ],
    "stats": {
      "commits": 313,
      "backend": 52,
      "frontend": 261
    },
    "sections": [
      {
        "heading": "Dialer360 integration and agent reconciliation",
        "icon": "api",
        "body": "I connected the CRM to Dialer360 with mapping APIs and a reconciliation flow that ties dialer agents back to our own users through a dialerAgentUser mapping. With the link in place I started surfacing call telemetry like average milliseconds and average bytes, and laid out an HR call-records plan plus an inbound disposition report on top of it.",
        "bullets": [
          "Dialer360 integration with mapping APIs and agent reconciliation",
          "dialerAgentUser mapping linking dialer identities to CRM users",
          "Inbound disposition report and call-metric fields (avg ms, avg bytes)"
        ]
      },
      {
        "heading": "Sale audits and QA",
        "icon": "search",
        "body": "I built a sale-audit subsystem so QA can review sales against the call record. The backend got schema audit fields, a filtered audit query with metadata, and package audit logging; the frontend got dialog-friendly QA forms, normalized sale details, and the GraphQL operations to drive them. Codegen kept the audit types in sync end to end.",
        "bullets": [
          "Sale-audit schema fields, filtered audit query, and package audit log",
          "Dialog-friendly QA forms with normalized sale details",
          "Sale-audit codegen keeping backend and frontend types aligned"
        ]
      },
      {
        "heading": "A penalty system with teeth",
        "icon": "shield",
        "body": "On top of audits I shipped a sale-penalty module covering non-upselling penalties and multiple penalty levels, with a processed-penalties overview and a pendingPenalty flag so nothing slips through. The UI lets reviewers pick a penalty level in-dialog and shows pending state, all behind QA access controls.",
        "bullets": [
          "Sale-penalty module with non-upselling penalties and penalty levels",
          "Processed-penalty overview and hasPendingPenalty flagging",
          "Penalty-level selection in the audit dialog with secured access"
        ]
      },
      {
        "heading": "Roles, route access, and DishTV",
        "icon": "lock",
        "body": "I added a VMA_MANAGER role and secured the task resolvers around it, then introduced route-based UI access and per-user table column config so people see only what their role allows. I also took DishTV from zero to a full provider — entity, module, GraphQL ops, and edit support — and added eager-loading of agent and fronter relations to speed up sale reads.",
        "bullets": [
          "VMA_MANAGER role with secured task resolvers and route-based UI access",
          "Per-user table column configuration",
          "DishTV shipped end to end with edit support",
          "Eager-loaded agent/fronter relations on sales for faster reads"
        ]
      }
    ]
  },
  {
    "slug": "2026-03",
    "period": "March 2026",
    "date": "2026-03-31",
    "title": "A file manager, provider portals, and the app goes dark",
    "summary": "The month I built a full file manager into the CRM, threaded a provider-portal identity through every sale entity, and rolled a real dark theme and Spanish localization across the whole frontend.",
    "tags": [
      "File Manager",
      "NestJS",
      "Angular",
      "Dark theme",
      "i18n"
    ],
    "stats": {
      "commits": 315,
      "backend": 76,
      "frontend": 239
    },
    "sections": [
      {
        "heading": "A file manager inside the CRM",
        "icon": "data",
        "body": "I built a document management system from the ground up so teams stop scattering files in email and chat. The backend handles folders, file descriptions, batch operations, and downloads; the frontend gives users breadcrumbs, sorting, a create-folder dialog, and paginated browsing. I also wired in a permissions and delete-rules layer so access is governed, not freeform.",
        "bullets": [
          "Folder hierarchy with breadcrumbs, batch ops, and folder/file downloads",
          "GraphQL pagination plus per-file descriptions and a create API",
          "File permissions, delete rules, and a performance guide for the subsystem"
        ]
      },
      {
        "heading": "Provider portals as first-class identity",
        "icon": "link",
        "body": "Carriers each have their own portal, and a sale needs to know which portal account and ID it belongs to. I introduced a ProviderPortal type and threaded a portal reference and portal ID through every provider's sales entity, replacing the older package/version scheme for tracking portal and user identity. Edit support followed across all 27 providers.",
        "bullets": [
          "ProviderPortal type with portal and sale-id references on every provider's sales entity",
          "Sale-edit flow extended to all 27 providers"
        ]
      },
      {
        "heading": "Dark theme, i18n, and a calmer UI",
        "icon": "spark",
        "body": "I moved the frontend onto themed CSS variables and shipped a genuine dark mode that reaches charts, the notepad, and the sale views, not just the chrome. Alongside it I revamped the Settings UI, added per-user notification preferences on the backend, and landed Spanish translations wired through the components so the app speaks to a bilingual sales floor.",
        "bullets": [
          "Themed CSS variables driving a real dark mode across charts, notepad, and sales",
          "Per-user notification preferences and a revamped Settings/i18n surface",
          "3D libraries lazy-loaded to keep the initial bundle light"
        ]
      },
      {
        "heading": "Sale stages and call flags",
        "icon": "bolt",
        "body": "I started formalizing the sale lifecycle with explicit stages and a callStageFlag, plus new flag conditions and a backfill of GENERIC status packages so historical sales line up with the new model. This is the groundwork the audit and penalty work would build on later.",
        "bullets": [
          "Explicit sale stages and a callStageFlag with new flag conditions",
          "Backfilled GENERIC sales-status packages for consistency"
        ]
      }
    ]
  },
  {
    "slug": "2026-02",
    "period": "February 2026",
    "date": "2026-02-28",
    "title": "A billing task system with workspaces, subtasks, and a messenger rebuild",
    "summary": "The month I built a task and billing workflow on top of workspaces, clients and task groups — with subtasks, drag-and-drop, and presigned uploads — and rebuilt the messenger.",
    "tags": [
      "Tasks",
      "Billing",
      "Workspaces",
      "Drag-and-drop",
      "Angular"
    ],
    "stats": {
      "commits": 273,
      "backend": 73,
      "frontend": 200
    },
    "sections": [
      {
        "heading": "A task system on workspaces and clients",
        "icon": "layers",
        "body": "The centerpiece was a task management system organized around workspaces, clients, and task groups. I added the entities and updates on the backend, a createTask mutation and resolver, bulk task creation, and task notes with dates. Along the way I untangled a long-standing confusion between chat groups and task groups so the two domains stop bleeding into each other.",
        "bullets": [
          "Workspaces, clients, and task groups with backing entities",
          "createTask mutation, bulk create, and task notes with dates",
          "Separated chat groups from task groups for good"
        ]
      },
      {
        "heading": "Billing tasks and the dashboard",
        "icon": "money",
        "body": "On top of the task core I built the billing workflow: a billing tasks dashboard, a V2 admin dashboard, and task lifecycle actions. Permissions came with it — Billing Manager and Marketing Manager roles, plus the ability for a billing manager to act on other people's tasks. I also added user-scoped filters and a myClients view so each person sees their own slice.",
        "bullets": [
          "Billing tasks dashboard and V2 admin dashboard",
          "BILLING_MANAGER and MARKETING_MANAGER roles and permissions",
          "myClients and user-scoped task filters"
        ]
      },
      {
        "heading": "Subtasks, drag-and-drop, and uploads",
        "icon": "check",
        "body": "I made the task board feel like a real tool. Subtasks and their dialog UI now render on one page regardless of pagination, drag-and-drop reorders tasks with the drag restricted to privileged users, and file uploads go through presigned URLs. Subtasks and the surrounding GraphQL got the updates to match.",
        "bullets": [
          "Subtasks rendered together, independent of the 10-item page limit",
          "Drag-and-drop reordering gated to privileged users",
          "Presigned-URL task uploads"
        ]
      },
      {
        "heading": "A messenger rebuild",
        "icon": "message",
        "body": "The chat experience got a substantial refresh: a chat info panel, an emoji picker, a revamped login UI, group-tab scrolling, and searchable groups that update on creation. It is the kind of polish that makes the rest of the app feel finished."
      }
    ]
  },
  {
    "slug": "2026-01",
    "period": "January 2026",
    "date": "2026-01-31",
    "title": "Standing up HR: recruitment pipelines, surveys, and inventory with images",
    "summary": "The month I built an HR recruitment pipeline with analytics, a full survey module, and richer inventory and chat-file handling backed by direct S3 uploads.",
    "tags": [
      "HR",
      "Surveys",
      "Inventory",
      "S3",
      "GraphQL"
    ],
    "stats": {
      "commits": 203,
      "backend": 50,
      "frontend": 153
    },
    "sections": [
      {
        "heading": "An HR recruitment pipeline",
        "icon": "user",
        "body": "I built out the HR side of the product: a recruitment tracking system with a pipeline view and analytics, a Designation entity wired into Candidate, and recruiter filters. The Designation table got a composite key so each designation pairing stays unique, and HR users picked up their own permissions for creating people. On the frontend it became a designation dropdown with create/edit and full recruitment analytics modules.",
        "bullets": [
          "Recruitment pipeline with HR analytics",
          "Designation entity with a unique composite key, wired to Candidate",
          "Recruiter filters and HR-scoped user-creation permissions"
        ]
      },
      {
        "heading": "A survey module",
        "icon": "message",
        "body": "I shipped a survey system from entities and DTOs to a GraphQL API, then built the admin and user experiences on top. Admins get response analysis with agent attribution, a pending-agents view, and a sidebar; the stats account for who actually responded so the numbers mean something.",
        "bullets": [
          "Survey entities, DTOs, and GraphQL API",
          "Standalone admin and user survey components",
          "Response analysis with agent attribution"
        ]
      },
      {
        "heading": "Files and inventory that handle real assets",
        "icon": "cloud",
        "body": "Chat and inventory both grew up around file handling. I added direct S3 upload for chat files, secure time-limited download URLs, and a recent-files browser, plus a latest-file-per-chat lookup. Inventory gained multi-image upload and bulk unit creation so stocking a batch of devices is one action instead of many.",
        "bullets": [
          "Direct-to-S3 chat uploads with secure download URLs",
          "Recent-files dialog and per-chat file browsing",
          "Multi-image inventory items and bulk unit creation"
        ]
      },
      {
        "heading": "Spiff, personas, and commission hygiene",
        "icon": "money",
        "body": "I added Spiff-week endpoints with a Spiff management module on the frontend, Optimum sales-ID support, and a user-persona module with an agent performance dialog. I also tightened commission integrity so a resync rechecks the whole search index even when commissions are already non-zero, catching drift instead of trusting stale values."
      }
    ]
  },
  {
    "slug": "2025-12",
    "period": "December 2025",
    "date": "2025-12-31",
    "title": "Agent time tracking from scratch: pauses, shifts, time-off, and QA",
    "summary": "The month I built the operational backbone for a sales floor — pause and break tracking, shift history, a dynamic time-off policy system, and the start of a QA module.",
    "tags": [
      "Time tracking",
      "NestJS",
      "Angular",
      "Sessions",
      "QA"
    ],
    "stats": {
      "commits": 201,
      "backend": 77,
      "frontend": 124
    },
    "sections": [
      {
        "heading": "Pause and break tracking",
        "icon": "clock",
        "body": "I built a pause/break tracking system for agents from the schema up. The backend got pause-tracking tables, enum-validated pause and shift-session entities, and reporting; the frontend got agent and manager views with break breakdowns and session history. I even added 'Different Station' tracking so a session that moves machines is still attributed correctly.",
        "bullets": [
          "Pause tracking with enum-validated entities and reporting",
          "Break breakdown and session history in the agent panel",
          "'Different Station' session tracking across machines"
        ]
      },
      {
        "heading": "Shifts and session integrity",
        "icon": "shield",
        "body": "Time tracking is only useful if sessions are honest, so I spent real effort on session integrity. I added a shift-history API with DTOs and indexes, stale-session cleanup, and shift-end on logout. Sessions now auto-log-out on inactivity, when a second login appears, or when the JWT expires — so the floor data reflects who is actually working.",
        "bullets": [
          "Shift-history API with DTOs and DB indexes",
          "Inactivity auto-logout and shift-end on logout",
          "Auto session end on duplicate login or JWT expiry"
        ]
      },
      {
        "heading": "A dynamic time-off system",
        "icon": "calendar",
        "body": "I scaffolded a time-off request system with a dynamic policy engine, company-holiday support, and a time-off history table. On the frontend that became a holiday manager with document upload, so HR can define policies as data and agents can request and track time off in one place."
      },
      {
        "heading": "Foundations: config, QA, and Angular 19",
        "icon": "layers",
        "body": "Alongside the big systems I laid groundwork. I added a table-column config feature with migrations and gave every entity index and constraint an explicit name so migrations stay deterministic. The QA module landed in basic form on both ends, and the frontend moved onto Angular Material 19 with strict type-checking enabled and prod console logs suppressed.",
        "bullets": [
          "Table-column config and column reorder on record tables",
          "Explicitly named indexes and constraints across entities",
          "Angular Material 19 upgrade with strict typing on"
        ]
      }
    ]
  },
  {
    "slug": "2025-11",
    "period": "November 2025",
    "date": "2025-11-30",
    "title": "Five new carriers, a real commission engine, and a chat redesign",
    "summary": "The month I onboarded Astound, Starlink, Cox and friends end to end, built modular commission calculation into the sales pipeline, and rebuilt the chat experience.",
    "tags": [
      "Sales",
      "Commissions",
      "Starlink",
      "Astound",
      "GraphQL"
    ],
    "stats": {
      "commits": 208,
      "backend": 39,
      "frontend": 169
    },
    "sections": [
      {
        "heading": "Onboarding carriers, top to bottom",
        "icon": "layers",
        "body": "A big chunk of November was adding new providers as first-class citizens of the sales system. Astound Broadband and Starlink both got full GraphQL CRUD, their own sale DTOs, migrations, and provider modules, and Cox picked up its own sale components and dialogs. Each carrier carries its own quirks, so I relaxed package validation where the data didn't fit a single rigid shape and threaded shipment fields through as optional where shipping is real.",
        "bullets": [
          "Astound and Starlink: full sale support, DTOs, and migrations",
          "Cox sale components, dialogs, and provider routing",
          "Shipping address and optional shipment fields on physical-good sales"
        ]
      },
      {
        "heading": "A commission engine that does the math",
        "icon": "money",
        "body": "I built modular commission calculation into the sales module so payouts are computed consistently instead of by hand. That meant adding a CommissionPaid field across every sale DTO and its GraphQL surface, plus selectors in the sales-journey dialogs so the state is visible and editable. I also enriched the sale records with LOB package fields and PSU counts so the aggregation actually has the inputs it needs.",
        "bullets": [
          "Modular commission calculation methods on the server",
          "CommissionPaid threaded through every sale DTO and query",
          "Commission-paid selectors in the sales-journey UI"
        ]
      },
      {
        "heading": "Sharper search and indexing",
        "icon": "search",
        "body": "Search got more precise this month. I added and backfilled a state column on the search index, improved provider mapping and the agent fields we index, and stopped pulling comments into the index so it stays lean and relevant.",
        "bullets": [
          "State column added and backfilled across the search index",
          "Better provider and agent fields in the index; comments excluded"
        ]
      },
      {
        "heading": "Chat, redesigned",
        "icon": "message",
        "body": "On the frontend I reworked the chat list and tightened up the dashboards, including a 'New Sale' card on each provider dashboard and a unified treatment for sale-status legends and colors so the same status always looks the same everywhere."
      }
    ]
  },
  {
    "slug": "2025-10",
    "period": "October 2025",
    "date": "2025-10-31",
    "title": "An interactive coverage map and a patch-notes system, plus a quiet performance pass",
    "summary": "The month I turned provider coverage into an interactive US map with per-state stats, shipped an in-app patch-notes system end to end, and quietly cut the cost of our heaviest customer queries.",
    "tags": [
      "Angular",
      "NestJS",
      "GraphQL",
      "Data viz",
      "Performance"
    ],
    "stats": {
      "commits": 140,
      "backend": 13,
      "frontend": 127
    },
    "sections": [
      {
        "heading": "A coverage map for every provider",
        "icon": "compass",
        "body": "Most of the month went into a new interactive map that visualizes where each carrier sells and how customers break down by provider. I built the base map, layered per-state stats and custom tooltips on top, and worked through provider after provider until the whole roster was covered. Each provider got its own content, branded imagery, and animated filtering so the team can actually explore the data instead of staring at a table.",
        "bullets": [
          "Per-state stats with custom tooltips driven by live data",
          "Provider distribution chart with logos sized by share",
          "Animated cross-provider filtering across the whole roster"
        ]
      },
      {
        "heading": "Patch notes, in the app",
        "icon": "message",
        "body": "I shipped a full patch-notes system so releases get communicated where people already work. On the backend that meant a new module with its own DTOs and migrations; on the frontend an editor with a table of contents, sectioning, video embeds, and a thumbnail system. It is a small product surface, but owning it from schema to editor UI made it feel polished.",
        "bullets": [
          "Patch-notes module with migrations and GraphQL integration",
          "Rich editor: table of contents, sections, video, thumbnails"
        ]
      },
      {
        "heading": "A quiet performance pass",
        "icon": "speed",
        "body": "Underneath the visible work I spent time making the heavy queries cheaper. I rewrote the customer query to batch-fetch instead of fanning out, moved sorting off the SQL side, simplified search, and added a call-log analytics DTO. The task-status counts also got a dedicated analytics path so dashboards stop paying for them on every load.",
        "bullets": [
          "Batch-fetching to cut customer-query cost",
          "Moved task-status counts to a dedicated analytics resolver"
        ]
      }
    ]
  },
  {
    "slug": "2025-09",
    "period": "September 2025",
    "date": "2025-09-30",
    "title": "Live analytics, self-healing stats, and a seeding system to prove it all",
    "summary": "The month I built a real-time analytics API with snapshot-backed stats that repair themselves, finished the chat experience with floating heads and @mentions, and wrote a full seeding system to load the whole thing with realistic data.",
    "tags": [
      "NestJS",
      "Angular",
      "GraphQL",
      "Analytics",
      "Seeding"
    ],
    "stats": {
      "commits": 264,
      "backend": 57,
      "frontend": 207
    },
    "sections": [
      {
        "heading": "Analytics that stream and self-correct",
        "icon": "chart",
        "body": "I built an analytics API delivering live dashboard data over GraphQL queries and subscriptions, backed by a stats_snapshot table and a revenue cursor so the numbers accumulate instead of being recomputed every time. To keep it trustworthy I added self-healing to the stats path plus debug and backfill scripts, and shipped homepage analytics with hourly and weekly breakdowns.",
        "bullets": [
          "GraphQL analytics queries + live subscriptions",
          "stats_snapshot table with revenue cursor tracking",
          "Self-healing stats with backfill and debug scripts",
          "Hourly and weekly event breakdowns"
        ]
      },
      {
        "heading": "Chat, finished",
        "icon": "message",
        "body": "I turned the messenger into something people actually live in: floating chat heads for incoming messages, per-user inbox subscriptions for real-time discovery, message pagination, and a proper new-chat dialog. I also added @mentions and threaded comments straight into lead details so a conversation could happen where the work was.",
        "bullets": [
          "Floating chat heads and per-user inbox subscriptions",
          "Message pagination and new-chat dialog",
          "@mentions support in comments",
          "Threaded comments on lead details"
        ]
      },
      {
        "heading": "Seeding the whole system",
        "icon": "beaker",
        "body": "Testing analytics and chat at scale needs real volume, so I wrote a comprehensive database seeding system with resume and date-window controls and performance toggles. It loads provider sales, call logs, interested customers, and the search index, which let me validate the live dashboards under realistic load.",
        "bullets": [
          "Configurable seeders with resume + date-window controls",
          "Provider sales, call logs, and search-index seeders",
          "Performance toggles for large interested-customer loads"
        ]
      },
      {
        "heading": "Polish on the frontend",
        "icon": "spark",
        "body": "With this much live data flowing, the UI had to feel solid. I added a Sales Insight page with live performance stats, skeleton loading to the sales report, and tightened memory hygiene with RxJS unsubscribe logic across the filter and search components.",
        "bullets": [
          "Sales Insight page with live performance stats",
          "Skeleton loading on sales reports",
          "RxJS unsubscribe cleanup in filter/search components"
        ]
      }
    ]
  },
  {
    "slug": "2025-08",
    "period": "August 2025",
    "date": "2025-08-31",
    "title": "A real-time chat system and inventory categories you can define yourself",
    "summary": "The month I built an in-app messenger with threads and infinite scroll, made inventory categories dynamic and data-driven, and onboarded AT&T Mobile and ForeverFreedom.",
    "tags": [
      "NestJS",
      "Angular",
      "GraphQL",
      "Chat",
      "Inventory"
    ],
    "stats": {
      "commits": 190,
      "backend": 61,
      "frontend": 129
    },
    "sections": [
      {
        "heading": "Chat, built in",
        "icon": "message",
        "body": "I stood up a messenger so the team could talk inside the CRM instead of leaving it. The backend got static auth for the chat subscriptions and a refactored schema, while the frontend grew a threads list with an accordion UI, infinite scroll for older messages, and the early framework for broadcasts and groups.",
        "bullets": [
          "GraphQL chat subscriptions with static auth",
          "Threaded conversation list with accordion UI",
          "Infinite scroll for message history",
          "Groundwork for broadcasts and groups"
        ]
      },
      {
        "heading": "Inventory categories without code",
        "icon": "layers",
        "body": "Hard-coded inventory categories couldn't keep up with how the team actually organized stock, so I built a dynamic category management system end to end. The inventory API gained stats, search, and unit management, and the frontend got a modern create-category dialog and reworked unit forms.",
        "bullets": [
          "Dynamic inventory category management (BE + FE)",
          "Inventory API with stats, search, and unit management",
          "Modern create-category dialog and refreshed unit forms"
        ]
      },
      {
        "heading": "New carriers and sharper stats",
        "icon": "api",
        "body": "I onboarded AT&T Mobile and ForeverFreedom, including making the closer email and closer assignment nullable to fit how those deals actually flow. On the analytics side I added date-range and quick filters to the call-stats breakdown so managers could slice activity by window without leaving the page.",
        "bullets": [
          "AT&T Mobile and ForeverFreedom providers added",
          "Nullable closer email / closer assignment",
          "Date-range and quick filters on call-stats breakdown"
        ]
      }
    ]
  },
  {
    "slug": "2025-07",
    "period": "July 2025",
    "date": "2025-07-31",
    "title": "An inventory system, live event streams, and commissions that respect delays",
    "summary": "The month I built device inventory from create to assignment, made the dashboards update live over websockets, and taught the commission engine about payment delays and a commissionPaid flag.",
    "tags": [
      "NestJS",
      "Angular",
      "Inventory",
      "WebSockets",
      "Commissions"
    ],
    "stats": {
      "commits": 125,
      "backend": 39,
      "frontend": 86
    },
    "sections": [
      {
        "heading": "Inventory from scratch",
        "icon": "data",
        "body": "I built the first version of the inventory subsystem so the team could track physical units instead of spreadsheets. That meant a create-inventory form, unit-list components, an assignment popup, available-stock counts, and filterable inventory requests.",
        "bullets": [
          "Create-inventory form and unit-list components",
          "Assign / available-stock tracking",
          "Filter input on inventory requests"
        ]
      },
      {
        "heading": "Dashboards that update themselves",
        "icon": "bolt",
        "body": "Polling for fresh numbers was wasteful, so I moved the live data onto an event emitter and websocket subscriptions to push table updates as they happen. I also added system-monitoring panels and event-trend charts so the live stream had somewhere meaningful to land.",
        "bullets": [
          "Event emitter + websocket subscriptions for live tables",
          "System monitoring panels",
          "Event-trend charts and summary statistics"
        ]
      },
      {
        "heading": "Commissions that handle the real world",
        "icon": "money",
        "body": "Payouts don't always fire immediately, so I added proper delay handling — including the edge cases where a zero-month delay should mean zero and a one-month delay was wrongly becoming two. I introduced a commissionPaid flag through the salary reports and detail views so paid commissions stop double-counting, and added a date-range filter to the dashboard summary.",
        "bullets": [
          "Fixed 0-month and off-by-one commission delays",
          "commissionPaid flag across salary reports and sale detail",
          "Active-agent filtering on salary processing",
          "Date-range support on the dashboard summary"
        ]
      }
    ]
  },
  {
    "slug": "2025-06",
    "period": "June 2025",
    "date": "2025-06-30",
    "title": "Twenty-four providers, versioned packages, and commission rules for all of them",
    "summary": "The month I migrated the whole catalog onto versioned packages, brought 24 providers into a unified commission engine, and cached the analytics so the dashboards stopped grinding.",
    "tags": [
      "NestJS",
      "Angular",
      "GraphQL",
      "Commissions",
      "Migrations"
    ],
    "stats": {
      "commits": 138,
      "backend": 65,
      "frontend": 73
    },
    "sections": [
      {
        "heading": "Package to PackageVersion",
        "icon": "layers",
        "body": "Provider catalogs change constantly, and a flat Package entity couldn't represent that history. I refactored the model to PackageVersion, wrote the full set of migration scripts, and fixed every sales DTO and input so the new foreign keys flowed cleanly through each provider's forms.",
        "bullets": [
          "Package → PackageVersion entity refactor with migrations",
          "Sales DTOs and inputs aligned to the new keys",
          "Foreign keys threaded through all provider forms"
        ]
      },
      {
        "heading": "One commission engine, 24 carriers",
        "icon": "money",
        "body": "I brought all 24 providers into commission rules and commission management so payout logic lived in one place instead of being special-cased per carrier. Each provider service also got its own Bull queue, and I handled the tricky data cases — null IDs across sale entities — until the stragglers like Buckeye and DTV were clean.",
        "bullets": [
          "24 providers under unified commission rules",
          "Bull queues applied across every provider service",
          "Null-ID cleanup on sale entities (Buckeye, DTV, more)"
        ]
      },
      {
        "heading": "Faster analytics, working search",
        "icon": "gauge",
        "body": "With more providers came more data, so I added caching to the analytics layer to keep the dashboards responsive. I also got the salary module into genuinely useful shape and shipped a fully working record search, plus a bulk-insert script that loads interested-customer and sales records together.",
        "bullets": [
          "Cached analytics queries",
          "Functional global record search",
          "Bulk-insert script for leads and sales",
          "Salary module made usable"
        ]
      }
    ]
  },
  {
    "slug": "2025-05",
    "period": "May 2025",
    "date": "2025-05-31",
    "title": "Call records, attendance tracking, and a queue-backed sales pipeline",
    "summary": "The month I stood up the call-logging and disposition layer, added agent attendance tracking, and moved heavy sales work onto background queues so the UI stayed fast.",
    "tags": [
      "NestJS",
      "Angular",
      "Bull",
      "Call logs",
      "Attendance"
    ],
    "stats": {
      "commits": 138,
      "backend": 42,
      "frontend": 96
    },
    "sections": [
      {
        "heading": "A real call-logging layer",
        "icon": "message",
        "body": "I built out the call-records and call-disposition system so agents could capture every conversation against a lead, with the form, component, and task-status wiring to back it. On top of the raw logs I shipped a Calls Stats Breakdown so managers could actually read the numbers instead of scrolling rows.",
        "bullets": [
          "Call Records form and component with disposition handling",
          "Call-log task status synced end to end",
          "Calls Stats Breakdown view for managers"
        ]
      },
      {
        "heading": "Queues for the heavy lifting",
        "icon": "speed",
        "body": "Sales processing was getting expensive to do inline, so I introduced Bull queues and a Bull dashboard to run and observe the background work. I also had to teach the file-path handling to ignore static assets so the dashboard served cleanly in production.",
        "bullets": [
          "Bull queues wired into the sales flow",
          "Bull dashboard for queue observability",
          "Static-asset path fix for the prod dashboard"
        ]
      },
      {
        "heading": "Attendance and task ownership",
        "icon": "user",
        "body": "I added Agent Attendance Tracking on the frontend and tightened task ownership so both assigned-by and assigned-to resolve correctly, including the reopen path where a task status needed to be saved after processing. Alongside it I laid down a new packages and generic-sale table structure and started building out customer demographics for interested leads.",
        "bullets": [
          "Agent attendance tracking UI",
          "Assigned-by / assigned-to ownership on tasks",
          "New packages + generic sale table migration",
          "Demographics for interested customers"
        ]
      }
    ]
  },
  {
    "slug": "2025-04",
    "period": "April 2025",
    "date": "2025-04-30",
    "title": "Inventory assignment, background jobs with BullMQ, and complex sale filters",
    "summary": "The month I gave Telelinkz an inventory system, moved heavy uploads onto BullMQ queues with a monitoring dashboard, and rebuilt sale filtering across every provider so the data is finally fast to slice.",
    "tags": [
      "Inventory",
      "BullMQ",
      "Queues",
      "Filters",
      "Employees"
    ],
    "stats": {
      "commits": 127,
      "backend": 37,
      "frontend": 90
    },
    "sections": [
      {
        "heading": "Assigning inventory to people",
        "icon": "data",
        "body": "I built the inventory assignment flow this month — an assign-inventory screen, an assigned-inventory tab in the table, and the validation checks to keep an assignment well-formed. It gives the team a real record of which units are in whose hands instead of tracking gear in someone's head.",
        "bullets": [
          "Assign-inventory screen and assigned-inventory tab",
          "Validation on inventory assignment"
        ]
      },
      {
        "heading": "Heavy uploads on a queue",
        "icon": "bolt",
        "body": "Bulk uploads were doing too much work inline, so I moved them onto BullMQ. The jobs now run on a queue and process reliably, and I stood up the Bull dashboard for visibility into what's running and what failed — which meant solving the dashboard's auth so it isn't wide open. Uploads work properly now, with the queue absorbing the load.",
        "bullets": [
          "Bulk uploads processed through BullMQ jobs",
          "Bull monitoring dashboard with its auth sorted out"
        ]
      },
      {
        "heading": "Complex filters across every provider",
        "icon": "search",
        "body": "I reworked sale filtering into a complex-filter system applied to all sale providers, including a sale-stage filter, and fixed the weekly logic to look back a true seven days from now. Along the way I made the default sale flag sold instead of unassigned, got number-of-lines calculating correctly, and converted loose option strings into enums so the filters are type-safe.",
        "bullets": [
          "Unified complex filters with a sale-stage filter for all providers",
          "Weekly window fixed to a real -7 days, default flag set to sold",
          "Number-of-lines logic and options migrated to enums"
        ]
      },
      {
        "heading": "Employee management and dashboard polish",
        "icon": "user",
        "body": "On the people side I built out Add Employee and employee details, with a CNIC input and a dynamic gender field in the user form. The dashboard got percentages and color legends on the sale-status views, plus a cleaned-up disposition-approval form and table.",
        "bullets": [
          "Add Employee and employee details with CNIC and dynamic gender",
          "Dashboard percentages and color legends",
          "Disposition-approval form and table refresh"
        ]
      }
    ]
  },
  {
    "slug": "2025-03",
    "period": "March 2025",
    "date": "2025-03-31",
    "title": "Restructuring dispositions, trusting the JWT for identity, and provider stats",
    "summary": "My busiest month yet: I re-rooted audits under dispositions so a lead can hold many of each, moved agent identity onto the JWT instead of trusting the frontend, and built per-provider statistics across the dashboard.",
    "tags": [
      "Dispositions",
      "JWT",
      "Audit",
      "Statistics",
      "Real-time"
    ],
    "stats": {
      "commits": 272,
      "backend": 57,
      "frontend": 215
    },
    "sections": [
      {
        "heading": "Dispositions become the spine",
        "icon": "layers",
        "body": "I made a structural change to how leads are modeled: audits now belong to dispositions instead of call logs, which lets an interested customer carry multiple dispositions and multiple audits over time. The disposition history returns the full detail the frontend needs, and I added the guardrail that you can't open an audit on a disposition change that's still pending approval.",
        "bullets": [
          "Audits re-parented from call logs onto dispositions",
          "Multiple dispositions and audits per interested customer",
          "No audits allowed on pending disposition approvals"
        ]
      },
      {
        "heading": "Identity comes from the token",
        "icon": "lock",
        "body": "Agent identity in sale search used to be sent up from the frontend, which is exactly the kind of thing you don't trust a client to assert. I moved it onto the backend, deriving the agent from the JWT, and added an agentId-assignment mutation so the agentId and sale flag are set at the moment a sale is created. The find-sales queries are now behind a GraphQL auth guard.",
        "bullets": [
          "Agent identity derived from the JWT, not the client",
          "agentId and sale flag assigned at sale creation",
          "GraphQL auth guard on the find-sales queries"
        ]
      },
      {
        "heading": "Stats and the disposition chain log",
        "icon": "chart",
        "body": "With the data model sorted, I built statistics components across providers — AT&T, ADT, Breezeline and more each got their own stats view — plus the disposition chain log and lead-details theming on the frontend. The approvals sidebar and assignment-history view rounded out the review surface, and I enriched notifications with the extra context reviewers were missing.",
        "bullets": [
          "Per-provider statistics components",
          "Disposition chain log and lead-details views",
          "Approvals sidebar, assignment history, and richer notifications"
        ]
      }
    ]
  },
  {
    "slug": "2025-02",
    "period": "February 2025",
    "date": "2025-02-28",
    "title": "A task system on top of sales and real-time notifications over WebSockets",
    "summary": "The month Telelinkz got proactive: I built task assignment and history on top of sales, then shipped live notifications backed by Redis pub/sub and GraphQL subscriptions so people hear about work the moment it lands.",
    "tags": [
      "Tasks",
      "Real-time",
      "Redis",
      "GraphQL subscriptions",
      "Approvals"
    ],
    "stats": {
      "commits": 132,
      "backend": 22,
      "frontend": 110
    },
    "sections": [
      {
        "heading": "Tasks attached to the work",
        "icon": "check",
        "body": "I built a task system that hangs directly off sales, so a deal can carry the follow-ups it needs. Each task records who assigned it and who it's assigned to, with a task-history trail behind it, and I added assigned-by and assigned-to fields to the task filters so a manager can slice the queue by either side. The task manager UI came together on the frontend with a call-log popup and pagination.",
        "bullets": [
          "Add-task-to-sale flow with full task history",
          "Assigned-by / assigned-to on the task and its filters",
          "Task manager UI with call-log popup and pagination"
        ]
      },
      {
        "heading": "Notifications, finally live",
        "icon": "bolt",
        "body": "The headline of the month was real-time. I wired Redis pub/sub to GraphQL WebSocket subscriptions so the server can push notifications the instant something happens instead of waiting for a refresh. Getting the WS handshake and payload delivery solid took some fighting, but notifications are now working end to end.",
        "bullets": [
          "Redis pub/sub feeding GraphQL WS subscriptions",
          "Server-pushed notifications with no polling"
        ]
      },
      {
        "heading": "Disposition approvals and a payload fix",
        "icon": "shield",
        "body": "I tightened the disposition-change flow so more than one pending change can't be pushed at once, which keeps the approval queue honest. I also chased down a payload bug where a field named name was actually carrying the user's email — renaming it and everything that touched it fixed a class of confusing user.name versus email mismatches, and the current user's info is now only sent in full to admins.",
        "bullets": [
          "Single pending disposition change enforced",
          "name-vs-email payload corrected throughout",
          "Full current-user details limited to admins"
        ]
      }
    ]
  },
  {
    "slug": "2025-01",
    "period": "January 2025",
    "date": "2025-01-31",
    "title": "Fronters and closers, business rules in the sale form, and four new carriers",
    "summary": "The month I modeled how deals actually get sold — fronter and closer roles with real constraints — wired order dates and product rules into every provider, and brought Brightspeed, ADT, Breezeline, and Buckeye online.",
    "tags": [
      "Sales model",
      "Business rules",
      "Filters",
      "Brightspeed",
      "Angular"
    ],
    "stats": {
      "commits": 194,
      "backend": 43,
      "frontend": 151
    },
    "sections": [
      {
        "heading": "Fronters and closers as first-class roles",
        "icon": "user",
        "body": "A sale isn't one person's work, so I modeled the fronter and closer explicitly. I added closers across the backend, handled the null-closer cases cleanly, and enforced the rule that the fronter and closer can't be the same person. A getAllEmployeesWithUserType query backs the agent and closer pickers on the frontend so the form only offers valid people.",
        "bullets": [
          "Closer added end to end with null-closer handling",
          "Fronter and closer constrained to different people",
          "Employee-by-user-type query feeding the closer/agent inputs"
        ]
      },
      {
        "heading": "Rules that live in the sale form",
        "icon": "check",
        "body": "I moved real selling constraints into the data model. Order dates became required on every provider — with support for multiple order dates — and I rewrote the Xfinity sale DTO wholly to fit. The product logic is enforced too: you can't sell a phone line unless internet or TV is on the order first, so the form can't capture an invalid bundle.",
        "bullets": [
          "Required, multi-value order dates across all providers",
          "Phone requires internet or TV on the order",
          "Xfinity sale DTO reworked end to end"
        ]
      },
      {
        "heading": "Four carriers and a filter overhaul",
        "icon": "api",
        "body": "Brightspeed, ADT, Breezeline, and Buckeye all came online this month, plus new Frontier speeds and a fresh disposition. Alongside them I started a proper per-provider filter system, getting the AT&T filters working as the template the others would follow so the sale lists are actually queryable.",
        "bullets": [
          "Brightspeed, ADT, Breezeline, and Buckeye onboarded",
          "New Frontier speed tiers and a new disposition",
          "AT&T filters working as the pattern for every provider"
        ]
      },
      {
        "heading": "Approvals and a typography reset",
        "icon": "spark",
        "body": "I built out the approvals area with its own tabs, page, and buttons so reviews have a home in the UI. I also did a typography reset — converting px to rem, unifying the font family, and normalizing sizes across the app — which paid off immediately in how consistent the dense sale screens read.",
        "bullets": [
          "Approvals tabs, page, and actions",
          "px-to-rem conversion with unified fonts and sizing"
        ]
      }
    ]
  },
  {
    "slug": "2024-12",
    "period": "December 2024",
    "date": "2024-12-31",
    "title": "Auditable sale stages, user-scoped permissions, and an Ohio clock",
    "summary": "The month I made every sale change accountable: a tracked stage history that only the right people can touch, a current-user security context behind it, and a multi-provider sale-entry flow driven by Angular signals.",
    "tags": [
      "RBAC",
      "Audit trail",
      "Signals",
      "HughesNet",
      "GraphQL"
    ],
    "stats": {
      "commits": 140,
      "backend": 34,
      "frontend": 106
    },
    "sections": [
      {
        "heading": "Who's allowed to change what",
        "icon": "shield",
        "body": "I stood up a real security context this month. A @CurrentUser decorator resolves the acting user from the request, backed by the module imports and roles it needs, so the server always knows who is making a change. With that in place I locked down sale-stage edits: only allowed users can move a sale forward, and the server now confirms the identity before accepting the mutation.",
        "bullets": [
          "@CurrentUser context resolving the acting user from the request",
          "Roles and a security layer behind UserContext",
          "Stage and history mutations gated to permitted users only"
        ]
      },
      {
        "heading": "A sale stage that remembers everything",
        "icon": "data",
        "body": "Sales now carry their full lifecycle. I store the latest stage on the sale itself and append every transition to a saleStageHistory, so there's an auditable record of every state a sale has ever been in. The QA sale-audit forms came together on top of this, and I reworked the audit DTOs and forms so the captured data lines up with how the team actually reviews sales.",
        "bullets": [
          "Latest stage on the sale plus a full saleStageHistory trail",
          "QA sale-audit forms and reworked audit DTOs",
          "A call-disposition change log"
        ]
      },
      {
        "heading": "Storing time in Ohio, not UTC",
        "icon": "clock",
        "body": "Timestamps were drifting because everything was stored at UTC while the team works on Ohio time. I moved persistence to UTC-5 so the dates a rep sees match the dates that land in the database, and cleaned up the date transformation handling across the sale flow."
      },
      {
        "heading": "Multi-provider entry, signal-driven",
        "icon": "spark",
        "body": "On the frontend I pushed the sale-entry experience across providers, getting the HughesNet entry and DTO conditions in place and propagating the Xfinity and Spectrum component patterns out to the rest. The dynamic updates lean on Angular signals, which made the conditional forms far cleaner, and I added a comment section plus a pass on colors, fonts, and success/error states.",
        "bullets": [
          "HughesNet sale entry with its own DTO conditions",
          "Provider components generalized from Xfinity and Spectrum",
          "Signals-driven dynamic forms and a comment section"
        ]
      }
    ]
  },
  {
    "slug": "2024-11",
    "period": "November 2024",
    "date": "2024-11-30",
    "title": "Filling out the carrier roster and standardizing dates across every provider",
    "summary": "The month I onboarded nearly every remaining carrier — Breezeline, Brightspeed, Earthlink, ADT, Cox, Buckeye and more — and standardized date handling and validation order so the whole sale pipeline behaved consistently.",
    "tags": [
      "Multi-provider",
      "ISO dates",
      "Validation",
      "Enums",
      "Angular"
    ],
    "stats": {
      "commits": 149,
      "backend": 52,
      "frontend": 97
    },
    "sections": [
      {
        "heading": "Onboarding the rest of the roster",
        "icon": "layers",
        "body": "This was the big push to get nearly every carrier into the system. I added and finished sale flows for Breezeline, Brightspeed, Earthlink, AT&T, ADT, Cox, Buckeye, and the consolidated view — each with its own filters, enums, and frontend forms — and finalized the enum layer that all of them depend on.",
        "bullets": [
          "Breezeline, Brightspeed, Earthlink, ADT, Cox, and Buckeye end to end",
          "Per-provider sale filters",
          "Finalized, finalized-once enum layer across providers"
        ]
      },
      {
        "heading": "Dates that mean the same thing everywhere",
        "icon": "calendar",
        "body": "With a dozen providers in play, inconsistent dates would have been a slow-motion disaster. I converted every GraphQL date to a string via ISOString, applied format restrictions on order and installation dates, and fixed the order of field validation so the checks fire before the value is used — consistently, across every provider's filter inputs.",
        "bullets": [
          "All GraphQL dates normalized to ISO strings",
          "Format restrictions on order and installation dates",
          "Validation ordering fixed uniformly across providers"
        ]
      },
      {
        "heading": "Resilience on the frontend",
        "icon": "refresh",
        "body": "On the Angular side I chased down a class of nasty UX bugs around component lifecycle — text not reloading on revisit, the last active tab not being remembered, and data failing to persist to local IndexedDB when a route was deactivated. I also tidied a genuinely dangerous column-drop query on the backend so the schema couldn't be wrecked by accident.",
        "bullets": [
          "IndexedDB persistence on route deactivation",
          "Remembered active tab and reliable text reload",
          "Defused a dangerous column-drop query"
        ]
      }
    ]
  },
  {
    "slug": "2024-10",
    "period": "October 2024",
    "date": "2024-10-31",
    "title": "An audit module, DirecTV, and pitch cards reps can actually sell from",
    "summary": "The month I built the audit subsystem that lets QA review and flag sale fields, brought DirecTV online, and gave agents package-pitch cards for every provider.",
    "tags": [
      "Audit",
      "DirecTV",
      "Pitch cards",
      "Timezones",
      "Angular"
    ],
    "stats": {
      "commits": 101,
      "backend": 20,
      "frontend": 81
    },
    "sections": [
      {
        "heading": "The audit subsystem",
        "icon": "check",
        "body": "The headline this month was audit. I built the module end to end — a fully working audit that captures every field, a search component to find what needs review, and field-level coloring on the frontend so a reviewer can see at a glance which values were touched. It turned QA from a spreadsheet exercise into something native to the app.",
        "bullets": [
          "Audit capture across all sale fields",
          "Audit search component",
          "Color-coded audited fields with a loading spinner on the detail view"
        ]
      },
      {
        "heading": "DirecTV and the DTV entities",
        "icon": "api",
        "body": "I brought DirecTV online, modeling its entities before the first table-creation migration and ironing out the custom DTOs. The frontend got most of the way there — wiring the remaining fields into the HTML segment — to round out another provider vertical.",
        "bullets": [
          "DTV entities modeled ahead of the first migration",
          "Custom DTO fixes",
          "DirecTV frontend wired up"
        ]
      },
      {
        "heading": "Pitch cards and a timezone fix",
        "icon": "money",
        "body": "Agents needed something to sell from, so I built package-pitch plan cards across providers — AT&T, Brightspeed, Earthlink, Frontier, and consolidated views — laying out plans clearly on the screen. On the backend I fixed a subtle one: search was off because stored datetimes follow Ohio time (EDT), so I added a UTC adjustment so date queries line up.",
        "bullets": [
          "Pitch cards for AT&T, Brightspeed, Earthlink, Frontier, and consolidated",
          "UTC adjustment for EDT-stored datetimes in search"
        ]
      }
    ]
  },
  {
    "slug": "2024-09",
    "period": "September 2024",
    "date": "2024-09-30",
    "title": "Eight provider dashboards, a unified sale form, and search that survives messy data",
    "summary": "The month I scaled from a couple of providers to a full residential-internet lineup — eight dashboards and forms — while hardening date filters and search against the real, messy data underneath.",
    "tags": [
      "Multi-provider",
      "Search",
      "Forms",
      "Angular",
      "Date filtering"
    ],
    "stats": {
      "commits": 134,
      "backend": 25,
      "frontend": 109
    },
    "sections": [
      {
        "heading": "The provider lineup expands",
        "icon": "layers",
        "body": "This was the month Telelinkz went from a handful of providers to a real lineup. I built out the residential-internet providers dashboard and shipped eight forms and dashboards in one push, plus a brand-new unified sale form so every provider's intake followed a consistent shape instead of drifting apart.",
        "bullets": [
          "Residential-internet providers dashboard",
          "Eight provider forms and dashboards",
          "A single redesigned sale form"
        ]
      },
      {
        "heading": "Search and filtering that hold up",
        "icon": "search",
        "body": "Real data is filthy, and the backend had to cope. I fixed search against polluted entries — stray casing and whitespace were quietly breaking name matches — and got the disposition-date filter working correctly so dates actually flow through the query. I also tuned findByUser and lifted a user limit on QA accounts.",
        "bullets": [
          "Case- and whitespace-tolerant search",
          "Working disposition-date filter",
          "findByUser fixes and a QA user-limit removal"
        ]
      },
      {
        "heading": "Polish on the floor",
        "icon": "spark",
        "body": "A lot of the month was the small stuff that makes a tool usable on a call. I added sale support numbers, a Google Map view, a sidebar icon set, and finished the side notepad. Audit-form dropdowns got styled, font and number formatting got consistent, and I dropped the agent-name field from the form where it didn't belong.",
        "bullets": [
          "Embedded Google Map",
          "Side notepad and sidebar icons",
          "Consistent number and font formatting"
        ]
      }
    ]
  },
  {
    "slug": "2024-08",
    "period": "August 2024",
    "date": "2024-08-31",
    "title": "Auth, role-based access, and onboarding AT&T as the second provider",
    "summary": "The month Telelinkz grew teeth: I built encrypted auth with role-restricted mutations, brought AT&T online with bulk import, and started taking the dashboard's design seriously.",
    "tags": [
      "Auth",
      "RBAC",
      "AT&T",
      "Leads",
      "Angular"
    ],
    "stats": {
      "commits": 150,
      "backend": 40,
      "frontend": 110
    },
    "sections": [
      {
        "heading": "Security: auth and roles",
        "icon": "shield",
        "body": "I stood up the auth layer end to end. The Angular interceptor sends a bearer access token to the backend, and I encrypt the token at rest in localStorage while sending it decrypted on the wire, with token-expiry checks on both sides. On top of that I added role-based restrictions on mutations, so what you can change now depends on who you are, backed by an auth guard on the routes.",
        "bullets": [
          "HTTP interceptor with bearer auth and token-expiry checks",
          "Encrypted token storage, decrypted in transit",
          "Role-based restrictions on GraphQL mutations behind an auth guard"
        ]
      },
      {
        "heading": "AT&T comes online",
        "icon": "api",
        "body": "AT&T became the second provider, and this time I leaned into bulk input — the importer ingests per-agent sale rows straight into the database, with a new enum set and entity changes to fit AT&T's shape. I built the resolver and per-agent import logic on both ends so the data lands clean.",
        "bullets": [
          "Bulk AT&T import with per-agent ingestion",
          "Provider-specific enums and entity changes",
          "Matching resolver and frontend import logic"
        ]
      },
      {
        "heading": "Interested-customer leads",
        "icon": "user",
        "body": "I built out the interested-customer lead flow — new inputs and columns in the database, fresh DTOs and create methods that return proper promises, and a one-to-one relation tying a lead to its owner. The create-lead page and form came together on the frontend so reps could actually capture leads.",
        "bullets": [
          "Lead entity with new fields and a one-to-one owner relation",
          "Create-lead page and styled form"
        ]
      },
      {
        "heading": "Taking the design seriously",
        "icon": "spark",
        "body": "With the plumbing working, I did a full dashboard redesign pass — shared CSS files for consistency, restyled forms and tables, a customer-lead page that finally looked intentional, and quality-of-life touches like a copy button for CS numbers. Export logs and an audit-friendly view rounded it out.",
        "bullets": [
          "Common CSS foundation and a full dashboard restyle",
          "Copy-to-clipboard for support numbers",
          "Export logs"
        ]
      }
    ]
  },
  {
    "slug": "2024-origin",
    "period": "Early 2024",
    "date": "2024-07-31",
    "title": "Standing up Telelinkz: the first entities, the first filter, and a Xfinity pipeline",
    "summary": "The origin story. I bootstrapped the NestJS/GraphQL backend and an Angular dashboard from nothing, modeled the core sales domain, and got the first real provider — Xfinity — flowing end to end.",
    "tags": [
      "NestJS",
      "GraphQL",
      "Angular",
      "Xfinity",
      "Foundations"
    ],
    "stats": {
      "commits": 122,
      "backend": 45,
      "frontend": 77
    },
    "sections": [
      {
        "heading": "From empty repo to a working API",
        "icon": "rocket",
        "body": "This was the ground floor. I got a NestJS/GraphQL backend up and running, then spent the first stretch modeling the sales domain — entities for every actor and artifact, resolver methods across the board, and the relations that tie them together. The trickiest call early on was making sale stages and comments polymorphic instead of leaning on hard foreign keys, so a comment could attach to anything.",
        "bullets": [
          "Core entities plus resolvers for the whole sales domain",
          "Polymorphic relation for sale stages and comments",
          "An evolving enum layer to encode real-world sale shapes"
        ]
      },
      {
        "heading": "The Xfinity vertical, end to end",
        "icon": "search",
        "body": "Xfinity was the proving ground for the whole pattern. I built a dedicated DTO with properly formatted dates and a fully functional filter and search on the backend, then wired an Angular screen with a router outlet so managers could filter the data — including name search by agent — and actually see results.",
        "bullets": [
          "XfinityDTO with formatted dates",
          "Working filter + agent name search",
          "Angular import flow that renders the data as a live table"
        ]
      },
      {
        "heading": "The first dashboard",
        "icon": "chart",
        "body": "On the frontend I scaffolded the Angular app and the first version of the Telelinkz dashboard — graphs that only appear once data is imported, a homepage with the primary navigation, and the Excel-style data view cleaned up for readability. Rough around the edges, but it was the skeleton everything else grew on.",
        "bullets": [
          "First dashboard with data-driven graphs",
          "Excel-style data view"
        ]
      }
    ]
  }
];

export const getPost = (slug: string): DevlogPost | undefined =>
  POSTS.find((p) => p.slug === slug);

export const TOTAL_COMMITS = POSTS.reduce((n, p) => n + p.stats.commits, 0);
