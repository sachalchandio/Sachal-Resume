"""
Content — the single source of truth for the portfolio.

Pure data, no framework imports. The Flask API in app.py serves these structures
as JSON; the React frontend renders them. Edit the data here, not the markup.
"""
from __future__ import annotations

PROFILE = {
    "name": "Sachal Chandio",
    "role": "Senior Software Engineer",
    "focus": "Backend · Distributed Data · DevOps",
    "headline_lead": "I architect backends that stay",
    "headline_rotate": ["fast", "consistent", "observable", "hard to break"],
    "summary": (
        "Senior engineer with 6+ years building and scaling backend systems and "
        "leading teams. I design multi-tenant data architectures, cut tail latency, "
        "and own delivery end to end — from the API down to the Kubernetes manifest."
    ),
    "location": "Lahore, Pakistan",
    "availability": "Open to senior backend / platform roles — remote or relocation",
    "email": "sachalchandio@gmail.com",
    "phone": "+92 311 6777138",
    "links": {
        "github": "https://github.com/sachalchandio",
        "linkedin": "https://www.linkedin.com/in/sachal-chandio-749b7528/",
    },
}

METRICS = [
    {"value": 60, "prefix": "−", "suffix": "%", "label": "API p95 latency", "note": "Redis-backed I/O offload"},
    {"value": 100, "prefix": "", "suffix": "M", "label": "rows sanitized", "note": "US census → zip lookups"},
    {"value": 20, "prefix": "", "suffix": "+", "label": "projects in production", "note": "owned CI/CD on AWS"},
    {"value": 6, "prefix": "", "suffix": "+", "label": "years shipping", "note": "5 engineers led"},
]

CAPABILITIES = [
    {
        "icon": "api",
        "title": "API & Service Design",
        "body": "GraphQL and REST services in NestJS and FastAPI — typed schemas, "
                "subscriptions, and queues that hold up under real traffic.",
        "proof": "Real-time GraphQL Subscriptions in production",
        "tags": ["NestJS", "FastAPI", "GraphQL", "REST"],
    },
    {
        "icon": "data",
        "title": "Distributed Data",
        "body": "Multi-tenant, table-per-provider isolation reconciled into a "
                "denormalized search index for sub-second queries across silos.",
        "proof": "100M-row lookups, sub-second search",
        "tags": ["PostgreSQL", "Redis", "Indexing", "Sync pipelines"],
    },
    {
        "icon": "cloud",
        "title": "Cloud & DevOps",
        "body": "Containers, orchestration, and CI/CD I actually run — Docker images, "
                "Kubernetes manifests with health probes, AWS edge and DNS.",
        "proof": "Non-root images, liveness & readiness probes",
        "tags": ["Docker", "Kubernetes", "AWS", "CI/CD"],
    },
    {
        "icon": "speed",
        "title": "Performance & Security",
        "body": "Tuned delivery and hardened headers across 20+ sites, plus "
                "HIPAA-compliant healthcare APIs end to end.",
        "proof": "90+ Lighthouse · Mozilla Observatory A grade",
        "tags": ["HTTP/2", "CDN", "Lighthouse", "HIPAA"],
    },
]

ABOUT = {
    "paragraphs": [
        "I started in QA writing Selenium suites, moved through Laravel and Rails "
        "product work, and spent the last few years leading backend architecture for "
        "a US B2B billing platform. The throughline: I like systems that are easy to "
        "reason about and hard to break.",
        "These days I own the path from API design to the Kubernetes manifest — typed "
        "GraphQL and FastAPI services, multi-tenant Postgres, Redis-backed queues, and "
        "the CI/CD that ships them. I care about tail latency, data consistency, and "
        "leaving a codebase clearer than I found it.",
    ],
    "facts": [
        {"k": "Based in", "v": "Lahore, PK (UTC+5) · remote-friendly"},
        {"k": "Experience", "v": "6+ years · led a team of 5"},
        {"k": "Focus", "v": "Backend · Distributed data · DevOps"},
        {"k": "Working in", "v": "NestJS · FastAPI · Postgres · K8s"},
    ],
}

PROJECTS = [
    {
        "id": "b2b-platform",
        "name": "Multi-Provider B2B Platform",
        "org": "Midwest Global Marketing & Billing — Engineering Lead",
        "tagline": "Strict data isolation, unified sub-second search.",
        "problem": "Each provider needed hard data isolation, yet the business needed "
                   "one fast search, analytics, and commission view across all of them.",
        "approach": "Designed a siloed table-per-provider database, then a unified search "
                    "service over a denormalized index. Built zero-downtime sync and "
                    "backfill pipelines, and moved blocking I/O to a Redis-backed queue.",
        "impact": [
            "API p95 latency down 60%+",
            "Sub-second search across all provider silos",
            "Real-time updates via GraphQL Subscriptions",
        ],
        "stack": ["NestJS", "GraphQL", "PostgreSQL", "Redis", "AWS"],
        "accent": "cyan",
    },
    {
        "id": "internetoffersnow",
        "name": "internetoffersnow.com",
        "org": "Midwest Global Marketing & Billing",
        "tagline": "100M-row lookups, 90+ Lighthouse.",
        "problem": "A high-traffic offers site needed fast provider lookups over a "
                   "100M-row census dataset without sacrificing Core Web Vitals.",
        "approach": "Sanitized and indexed the census data for efficient zip-to-provider "
                    "lookups, and tuned delivery with HTTP/2, CloudFront, and Cloudflare "
                    "plus an automated asset pipeline straight to the CDN.",
        "impact": [
            "100M rows sanitized and indexed",
            "90+ Lighthouse performance",
            "Automated CDN asset deploys",
        ],
        "stack": ["Flask", "CloudFront", "Cloudflare", "PostgreSQL"],
        "accent": "amber",
    },
    {
        "id": "healthtigo",
        "name": "healthtigo.com",
        "org": "Midwest × BillingFreedom",
        "tagline": "HIPAA-compliant healthcare APIs.",
        "problem": "Healthcare data integration demanded secure APIs and strict "
                   "compliance with no room for leakage.",
        "approach": "Built secure FastAPI services with HIPAA-compliant handling and "
                    "clean integration into the HealthTigo platform.",
        "impact": [
            "HIPAA-compliant data flows",
            "Secure third-party integration",
            "Typed, documented API surface",
        ],
        "stack": ["FastAPI", "PostgreSQL", "HIPAA"],
        "accent": "violet",
    },
    {
        "id": "wow-portals",
        "name": "Authorized Retailer Portals",
        "org": "NMDigital — for WOW (Wide Open West)",
        "tagline": "Telecom sales, credit & install automation.",
        "problem": "US telecom retailers needed portals that could check credit, take "
                   "payments, and verify installation availability at scale.",
        "approach": "Built the portals with credit-check and payment APIs, and queued "
                    "bulk installation-availability and address checks. Shipped the "
                    "companion mobile app in React Native.",
        "impact": [
            "Queued bulk availability checks",
            "Integrated credit & payment APIs",
            "Cross-platform mobile in TypeScript",
        ],
        "stack": ["Laravel", "React Native", "TypeScript", "Redux"],
        "accent": "cyan",
    },
]

EXPERIENCE = [
    {
        "role": "Engineering Lead",
        "company": "Midwest Global Marketing & Billing LLC",
        "location": "USA · Remote",
        "period": "Jan 2024 — Present",
        "current": True,
        "summary": "Lead 5 engineers on the core B2B platform; own architecture and DevOps.",
        "stack": ["NestJS", "GraphQL", "PostgreSQL", "Redis", "AWS", "Docker"],
    },
    {
        "role": "Software Developer",
        "company": "Midwest Global Marketing & Billing LLC",
        "location": "USA · Remote",
        "period": "Sep 2021 — Dec 2023",
        "current": False,
        "summary": "Flask & FastAPI services, 100M-row data work, HIPAA healthcare APIs.",
        "stack": ["Flask", "FastAPI", "CloudFront", "Cloudflare"],
    },
    {
        "role": "Software Developer",
        "company": "NMDigital",
        "location": "Lahore, Pakistan",
        "period": "Jan 2019 — Jul 2021",
        "current": False,
        "summary": "Telecom retailer portals, payment & credit APIs, React Native mobile.",
        "stack": ["Laravel", "React Native", "TypeScript"],
    },
    {
        "role": "Software Developer (Remote)",
        "company": "Stalwart Integrals",
        "location": "Chandigarh, India",
        "period": "Oct 2019 — Mar 2021",
        "current": False,
        "summary": "Backend backbone for artbuy.com — auth, comments, admin tooling.",
        "stack": ["Ruby on Rails", "Sharetribe"],
    },
    {
        "role": "QA Intern",
        "company": "Softronix",
        "location": "Lahore, Pakistan",
        "period": "May 2017 — Dec 2017",
        "current": False,
        "summary": "Automated UI test suites for FirstShipping and Archivist.",
        "stack": ["Selenium", "Java"],
    },
]

STACK = {
    "Languages": ["Python", "TypeScript", "JavaScript", "PHP", "Java", "SQL"],
    "Backend & APIs": ["NestJS", "Node.js", "FastAPI", "Flask", "Laravel",
                       "Ruby on Rails", "GraphQL", "REST", "Microservices"],
    "Data & Caching": ["PostgreSQL", "MySQL", "Redis", "Indexing", "Denormalization"],
    "Cloud & DevOps": ["Docker", "Kubernetes", "AWS", "CI/CD", "Nginx",
                       "CloudFront", "Cloudflare", "Route 53"],
    "Frontend": ["React", "Angular", "React Native", "Redux", "Vite"],
    "Practices": ["HIPAA", "Web security", "Lighthouse", "Agile", "Team leadership"],
}

EDUCATION = [
    {"degree": "BS (Hons.) Computer Science",
     "school": "Forman Christian College (FCCU), Lahore"},
    {"degree": "O Levels & A Levels",
     "school": "Sadiq Public School, Bahawalpur — 6 A’s (O), 2 A’s (A)"},
]

YOUTUBE_URL = "https://www.youtube.com/c/sachalchandio"

GAMING = [
    {
        "title": "Red Dead Redemption 2",
        "kind": "Open-world western",
        "note": "The best story games have ever told. I’ll ignore the main quest for "
                "hours just to fish, pet my horse, and watch the sun come up over the "
                "plains. Arthur Morgan lives rent-free in my head.",
        "accent": "#C75B39",
    },
    {
        "title": "Counter-Strike 2",
        "kind": "Tactical FPS",
        "note": "My competitive itch. Still chasing the perfect spray and the 1v3 "
                "clutch — and still loudly blaming the eco round when it goes sideways.",
        "accent": "#FF9F1C",
    },
    {
        "title": "Ghost of Tsushima",
        "kind": "Samurai open-world",
        "note": "The most beautiful game I’ve played. Following the wind instead of a "
                "minimap, standing in a field of red leaves before a duel — it’s a "
                "moving painting you happen to play.",
        "accent": "#D14B3D",
    },
    {
        "title": "Crimson Desert",
        "kind": "Open-world action · most-hyped",
        "note": "Top of my wishlist. A brutal, gorgeous world I’ve been watching since "
                "the first trailer — quietly counting down to losing weekends in it.",
        "accent": "#B23A48",
    },
    {
        "title": "Dota 2",
        "kind": "MOBA",
        "note": "The deepest, most punishing game I know. A decade in and I’m still "
                "learning — and still queuing ‘one more game’ at 2am against my better judgment.",
        "accent": "#9B2D3A",
    },
    {
        "title": "Path of Exile 2",
        "kind": "Action RPG",
        "note": "Build-crafting heaven. I’ll spend longer in the passive tree and at the "
                "crafting bench than actually mapping — and somehow that’s the best part.",
        "accent": "#B5894E",
    },
    {
        "title": "The Witcher 3",
        "kind": "Open-world RPG",
        "note": "Comfort food. Geralt, Gwent, and side quests written better than most "
                "films. I’ve finished it more times than I’ll admit and still find new lines.",
        "accent": "#9B6FB0",
    },
    {
        "title": "Risk of Rain 2",
        "kind": "Roguelike",
        "note": "My go-to for ‘just one run.’ The snowball from helpless to godlike never "
                "gets old — right up until the difficulty hits HAHAHA and it all falls apart.",
        "accent": "#3AC0B0",
    },
]

BERSERK = [
    "I am a struggler. I have never been anything else.",
    "A human can be stronger than any god — if only he refuses to give up his soul.",
    "Struggle, endure, contend. For that alone is the sword of one who defies death.",
    "A true friend finds his own dream, and follows it with all the strength he has.",
    "I’m human — the real deal, right down to the bone. Don’t lump me in with monsters.",
]

ANIME = [
    {
        "title": "Lord of Mysteries",
        "kicker": "Mystery · cosmic horror · the Fool above the gray fog",
        "accent": "#D9B44A",
        "quotes": [
            "The Fool who doesn’t belong to this era; the mysterious ruler above the gray fog; the King of Yellow and Black who wields good luck.",
            "The oldest and strongest emotion of mankind is fear — and the oldest and strongest fear is the fear of the unknown.",
            "I’m just a clown trying to perform his best, even if the only audience is myself.",
            "Free things are often the most expensive.",
            "Even the powerful are afraid. Courage is acting anyway.",
        ],
    },
    {
        "title": "Fullmetal Alchemist: Brotherhood",
        "kicker": "Alchemy · equivalent exchange · two brothers",
        "accent": "#C0392B",
        "quotes": [
            "Humankind cannot gain anything without first giving something in return. To obtain, something of equal value must be lost.",
            "A lesson without pain is meaningless. You cannot gain something without sacrificing something else of equal value.",
            "Stand up and walk. Keep moving forward. You’ve got two good legs — so get up and use them.",
            "The world isn’t perfect. But it’s there for us, doing the best it can. That’s what makes it so damn beautiful.",
            "There’s a whole world out there that lives outside ourselves and our dreams.",
        ],
    },
    {
        "title": "Vinland Saga",
        "kicker": "Vikings · vengeance · “I have no enemies.”",
        "accent": "#5E8CA8",
        "quotes": [
            "You have no enemies. Nobody has any enemies. There is no one whom it’s okay to hurt.",
            "A true warrior needs no sword.",
            "To carry a sword doesn’t make you strong. A real warrior never needs to draw one.",
            "I have a lot of atoning to do — so I’ll build a land where no one has to fight again.",
            "Death isn’t something you make others suffer. It’s something you face yourself.",
        ],
    },
    {
        "title": "Solo Leveling",
        "kicker": "Hunters · shadows · “Arise.”",
        "accent": "#8B5CF6",
        "quotes": [
            "Arise.",
            "Because I was at rock bottom, I longed for the highest place. I know the sorrow of being weak more than anyone.",
            "I’ll become strong enough to protect everyone I care about.",
            "I will protect my family — even if it means turning every hunter in the world against me.",
            "I’d rather be the one who hunts than the one who runs.",
        ],
    },
    {
        "title": "Attack on Titan",
        "kicker": "Walls · freedom · the cruelty of a beautiful world",
        "accent": "#7D8B4F",
        "quotes": [
            "If you win, you live. If you lose, you die. If you don’t fight, you can’t win.",
            "This world is cruel… and yet so beautiful.",
            "The only thing we’re allowed to do is believe that we won’t regret the choice we made.",
            "A person who can’t sacrifice anything can never change anything.",
            "Fight. Keep fighting until the very end.",
        ],
    },
    {
        "title": "Naruto",
        "kicker": "Ninja · never go back on your word",
        "accent": "#E67E22",
        "quotes": [
            "Hard work is worthless for those that don’t believe in themselves.",
            "I never go back on my word — that’s my ninja way.",
            "When a person has something important they want to protect, that’s when they become truly strong.",
            "Those who break the rules are scum. But those who abandon their friends are worse than scum.",
            "People live their lives bound by what they accept as correct and true. That’s how they define reality.",
        ],
    },
    {
        "title": "Demon Slayer",
        "kicker": "Breathing · grief · set your heart ablaze",
        "accent": "#3AA0C9",
        "quotes": [
            "No matter how many people you may lose, you have no choice but to keep on living.",
            "Set your heart ablaze.",
            "Those who are born strong have a duty to protect the weak.",
            "Feel the rage — the powerful, pure rage of not being able to forgive.",
            "No matter how devastating the blow, keep moving forward.",
        ],
    },
    {
        "title": "Sakamoto Days",
        "kicker": "Retired hitman · grocery store · family man",
        "accent": "#94A3B8",
        "quotes": [
            "I’m just a retired old man who runs a neighborhood store.",
            "Being a father is harder than being an assassin — you can’t eliminate the problems, you have to raise them.",
            "I learned the art of killing. Now I’m learning the art of living — and it’s far harder.",
            "Those who leave their fate to luck always die first.",
            "A man with something to protect is the strongest man alive.",
        ],
    },
]


# ---------------------------------------------------------------------------
# Currently building — work-in-progress projects (the /projects page).
# ---------------------------------------------------------------------------

BUILDING = [
    {
        "id": "poe2-upgrade-advisor",
        "name": "PoE2 Upgrade Advisor",
        "status": "In active development",
        "world": "poe2",
        "tagline": "The single most cost-effective upgrade you can buy right now — "
                   "backed by the exact damage math the theorycrafting community uses.",
        "pitch": "A companion web app for Path of Exile 2 that answers the one question "
                 "every player actually has but no tool answers well: what is the single "
                 "most cost-effective upgrade I can buy right now? You sign in with your "
                 "Path of Exile account, the app imports your live character, and it tells "
                 "you precisely which item on the trade market gives you the biggest "
                 "improvement for the least currency.",
        "problem": "Path of Exile 2 has one of the deepest itemization and character "
                   "systems in gaming, and a player-driven trade economy with millions of "
                   "listings. The result is a brutal optimization problem: experienced "
                   "players know their gear is holding them back but have no efficient way "
                   "to find which upgrade matters most. Existing tooling either shows raw "
                   "stats with no sense of impact, or requires manually rebuilding your "
                   "character in a separate desktop calculator. I wanted to collapse that "
                   "entire workflow — import → simulate → search the market → rank by value "
                   "→ buy — into a single, fast, intuitive screen.",
        "does": [
            {"k": "Imports your real character", "v": "gear, passive tree, and skills, through Path of Exile's official OAuth API. The login is the data source; nothing is typed in by hand."},
            {"k": "Computes exact stats", "v": "by running your build through the real Path of Building engine, so DPS, effective HP, and resistances are accurate to the game, not approximated."},
            {"k": "Searches the trade market", "v": "for affordable candidate items per slot, filtered to what's actually relevant to the passives you've chosen."},
            {"k": "Ranks upgrades by value", "v": "improvement-per-currency, re-simulating each candidate to measure the true gain, weighing survivability alongside raw damage rather than blindly chasing DPS."},
            {"k": "Hands you a trade link", "v": "It never transacts on your behalf — you stay in full control. It shows the item, its stats, the measured improvement, and the price."},
        ],
        "technical": {
            "title": "I don't reimplement the game's damage math — I reuse the real thing.",
            "body": "Path of Exile 2's damage and defense calculations are staggeringly "
                    "complex; any hand-rolled formula drifts from reality and erodes trust. "
                    "Instead, I vendor the open-source Path of Building engine (a large Lua "
                    "codebase), run it headless under LuaJIT inside a Docker container, and "
                    "drive it from my Node backend over a small line-delimited JSON-RPC "
                    "protocol I built on top of its headless entry point. Character data "
                    "goes in; exact stats come out. That makes this a genuinely polyglot, "
                    "multi-process system — a TypeScript application orchestrating a "
                    "containerized Lua calculation engine as a long-lived subprocess, with a "
                    "process pool and caching to keep per-candidate simulation fast enough "
                    "for an interactive experience.",
        },
        "features": [
            {"icon": "🔐", "text": "Official OAuth 2.1 + PKCE authentication against the Path of Exile API (login doubles as the data import)."},
            {"icon": "🧮", "text": "Exact, engine-accurate stat computation via a headless Path of Building integration."},
            {"icon": "💸", "text": "Value-based upgrade ranking — an optimization layer scoring improvement per unit of currency."},
            {"icon": "⚡", "text": "Real-time progress streaming over WebSockets, since evaluating many candidates is a long-running job that should feel alive."},
            {"icon": "🛒", "text": "Trade-link generation with full item context — actionable, but never auto-purchasing."},
            {"icon": "🎨", "text": "A responsive, accessible 3D interface designed to work beautifully on desktop and mobile."},
            {"icon": "🔒", "text": "Encrypted-at-rest token storage (AES-256-GCM) and strict, migration-only database discipline."},
        ],
        "stack": {
            "Frontend": ["React", "Vite", "Tailwind CSS", "react-three-fiber / three.js", "TanStack Query"],
            "Backend": ["NestJS (TypeScript)", "REST", "WebSockets"],
            "Calc engine": ["Path of Building (PoE2)", "LuaJIT", "Headless", "Containerized", "JSON-RPC"],
            "Data": ["MySQL", "TypeORM"],
            "Infrastructure": ["Docker", "pnpm monorepo", "Shared TS types"],
            "Integrations": ["PoE OAuth 2.1 API", "PoE Trade API"],
        },
        "methodology": [
            {"k": "Monorepo, strict separation", "v": "Each unit — shared domain types, the calculation service, the API, the web client — has one responsibility and a well-defined interface, testable in isolation."},
            {"k": "Risk-first, vertical slices", "v": "Sequenced to retire the riskiest unknowns first. The very first deliverable proved the hardest assumption — can a server produce exact Path of Building numbers? — before a line of UI."},
            {"k": "Test-driven, golden tests", "v": "TDD throughout, including golden tests that pin the engine's output and fail loudly on regression, with integration tests gated behind the container."},
            {"k": "Isolated volatile deps", "v": "All coupling to the game engine's internals lives behind a single adapter, so upstream changes can't ripple through the codebase."},
            {"k": "Security by default", "v": "Encrypted credentials, no auto-syncing schemas, and reviewed, CLI-generated database migrations only."},
            {"k": "Readable code as a deliverable", "v": "Sensibly sized functions, intention-revealing names, comments that explain why, not what — a codebase another engineer can pick up cold."},
        ],
        "ambition": "The long-term goal is to become the default first-stop optimization "
                    "layer for Path of Exile 2: open it, see exactly how to make your "
                    "character stronger this session, and act in a couple of clicks. The "
                    "same exact-simulation foundation opens the door to build comparison, "
                    "what-if gear planning, and goal-driven progression paths — all powered "
                    "by real game math rather than guesswork.",
        "accent": "#C0392B",
        "accentGold": "#D9A441",
    },
]
