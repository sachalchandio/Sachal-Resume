# Portfolio Blog — "Field Notes" — Design Spec

Date: 2026-06-26
Author: Sachal Chandio (with Claude)
Status: Approved — building

## Goal

Add a technical blog to the Sachal-Resume portfolio with 100+ posts, maximally
SEO-friendly, technically deep, authentic in voice, and interactive. Content is
mined from the real commit history of the **Telelinkz** backend (NestJS / TypeORM /
MySQL / GraphQL / Redis / Bull / AWS S3) and Angular frontend repositories.

## Key decisions

- **SEO: server-render hybrid.** Flask pre-renders `/log` and `/log/<slug>` as
  complete HTML (full article text + meta + OpenGraph/Twitter + JSON-LD
  `BlogPosting`/`BreadcrumbList` + canonical) so crawlers and social scrapers see
  everything without running JS. React still hydrates `#root` for interactivity.
  Plus `sitemap.xml`, `robots.txt`, `rss.xml`.
- **Identity:** posted under Sachal Chandio's real name; "Telelinkz" is named.
- **Scope:** ~110 per-problem deep-dive posts (with real code) + the 24 existing
  monthly digests migrated into the same system. ~134 total entries.
- **Two tracks, unified:** `kind: deepdive` and `kind: monthly`, cross-linked by
  `month`. The monthly digest for a period links to its problem deep-dives.

## Architecture

### Backend (`backend/blog/` Python package)
- `__init__.py` — loads `posts/*.md`, parses YAML frontmatter (PyYAML), renders
  Markdown→HTML with Pygments server-side highlighting (`markdown` + `codehilite`),
  extracts a TOC, computes reading time, builds prev/next + related, caches in
  memory at import. Tolerant of missing fields.
- New deps (pure-Python, HF-safe): `Markdown`, `Pygments`, `PyYAML`.
- Flask routes (explicit, beat the SPA catch-all):
  - `GET /api/blog`, `GET /api/blog/<slug>` — JSON for client-side nav.
  - `GET /log`, `GET /log/<slug>`, `GET /log/tag/<tag>` — server-rendered HTML.
  - `GET /sitemap.xml`, `GET /robots.txt`, `GET /rss.xml`.
- Server render = read built `webroot/index.html`, swap `<title>`, inject
  meta/OG/Twitter/canonical/JSON-LD into `<head>`, inject the rendered `<article>`
  into `#root`. Degrades to a standalone content page if `webroot` is absent.

### Content (`backend/blog/posts/*.md`)
Frontmatter: `title, description, date, updated, kind, category, tags, month,
repo, author`. Body is Markdown, no H1 (title comes from frontmatter), fenced code
with language tags. Source of truth, version-controlled, editable.

### Frontend (`frontend/src/`)
- `pages/BlogList.tsx` — fetch `/api/blog`; hero, track/category/tag filters,
  client search, post cards (reuse `Reveal` + existing `.bl-*` design).
- `pages/BlogPost.tsx` — fetch `/api/blog/<slug>`; inject server HTML, then enhance:
  sticky TOC with scroll-spy, reading-progress bar, copy-code buttons, prev/next,
  related. `react-helmet-async` for head on client nav.
- Routes already exist (`/log`, `/log/:slug`); add `/log/tag/:tag`.
- Reuse existing `.bl-*` / `.plog-*` CSS; add article typography + a Pygments dark
  theme to `index.css`.

## Content generation
Built with the Workflow tool: ~110 author agents fan out, each writing one post
file from a specific commit-grounded brief + a shared authentic-voice style guide;
a few agents migrate the 24 monthly digests from `data/devlog.ts` into Markdown.
Verification pass checks slugs, frontmatter, and quality.

## Voice (authenticity, not obfuscation)
A strict style guide enforces: first person, cold opens, varied rhythm, concrete
numbers and real identifiers, admitted dead-ends, real idiomatic code, no AI filler
("in conclusion", symmetrical listicles, marketing adjectives). Authenticity comes
from genuine specificity and craft, not detector-evasion tricks.

## Out of scope / guardrails
No database. No changes to existing pages beyond a nav link + routes. Deploy stays
`scripts/deploy_hf.py`. Images stay light (CSS/SVG hero; one shared og:image).
