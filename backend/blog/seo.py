"""SEO surface for the blog — server-rendered HTML, JSON-LD, sitemap, RSS.

The portfolio ships as a React SPA, but crawlers and social scrapers shouldn't have
to run JavaScript to read a post. For ``/log`` routes Flask renders a complete HTML
document: the article text baked into ``#root``, plus per-post ``<title>``, meta
description, OpenGraph/Twitter tags, canonical, and JSON-LD injected into ``<head>``.
React then hydrates ``#root`` and takes over for real users.
"""
from __future__ import annotations

import html
import json
import os
import re
from datetime import datetime, timezone

WEBROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "webroot")

SITE_NAME = "Sachal Chandio"
AUTHOR = "Sachal Chandio"
AUTHOR_URL = "/"
TWITTER = "@sachalchandio"
OG_IMAGE = "/og-cover.png"
BLOG_TITLE = "Field Notes — Sachal Chandio"
BLOG_TAGLINE = (
    "Technical field notes from building Telelinkz, a production telecom-sales CRM: "
    "NestJS, TypeORM, MySQL, GraphQL, Redis, Bull, and Angular — the real problems and fixes."
)

_E = html.escape


def abs_url(base: str, path: str) -> str:
    base = (base or "").rstrip("/")
    if path.startswith("http"):
        return path
    return base + "/" + path.lstrip("/")


def _meta(name: str, content: str, prop: bool = False) -> str:
    attr = "property" if prop else "name"
    return f'<meta {attr}="{_E(name)}" content="{_E(content)}" />'


# ---------------------------------------------------------------------------
# <head> blocks
# ---------------------------------------------------------------------------

def head_for_post(post: dict, base: str) -> tuple[str, str]:
    """Return (title, head_html) for a single post."""
    url = abs_url(base, f"/log/{post['slug']}")
    title = f"{post['title']} — {SITE_NAME}"
    desc = post["description"]
    img = abs_url(base, OG_IMAGE)
    tags = post.get("tags") or []

    parts = [
        _meta("description", desc),
        f'<link rel="canonical" href="{_E(url)}" />',
        _meta("author", post.get("author") or AUTHOR),
        _meta("keywords", ", ".join(tags)) if tags else "",
        _meta("og:type", "article", prop=True),
        _meta("og:site_name", SITE_NAME, prop=True),
        _meta("og:title", post["title"], prop=True),
        _meta("og:description", desc, prop=True),
        _meta("og:url", url, prop=True),
        _meta("og:image", img, prop=True),
        _meta("article:published_time", post.get("date") or "", prop=True),
        _meta("article:modified_time", post.get("updated") or post.get("date") or "", prop=True),
        _meta("article:author", post.get("author") or AUTHOR, prop=True),
        _meta("twitter:card", "summary_large_image"),
        _meta("twitter:title", post["title"]),
        _meta("twitter:description", desc),
        _meta("twitter:image", img),
    ]
    parts += [_meta("article:tag", t, prop=True) for t in tags]
    parts.append(_jsonld_post(post, base))
    parts.append(_jsonld_breadcrumb(
        [("Home", abs_url(base, "/")), ("Field Notes", abs_url(base, "/log")), (post["title"], url)]
    ))
    return title, "\n".join(p for p in parts if p)


def head_for_index(base: str, *, heading: str, desc: str, path: str, posts: list) -> tuple[str, str]:
    url = abs_url(base, path)
    title = f"{heading} — {SITE_NAME}"
    img = abs_url(base, OG_IMAGE)
    parts = [
        _meta("description", desc),
        f'<link rel="canonical" href="{_E(url)}" />',
        _meta("author", AUTHOR),
        _meta("og:type", "website", prop=True),
        _meta("og:site_name", SITE_NAME, prop=True),
        _meta("og:title", heading, prop=True),
        _meta("og:description", desc, prop=True),
        _meta("og:url", url, prop=True),
        _meta("og:image", img, prop=True),
        _meta("twitter:card", "summary_large_image"),
        _meta("twitter:title", heading),
        _meta("twitter:description", desc),
        _meta("twitter:image", img),
        f'<link rel="alternate" type="application/rss+xml" title="{_E(BLOG_TITLE)}" href="{_E(abs_url(base, "/rss.xml"))}" />',
        _jsonld_blog(base, heading, desc, url, posts),
    ]
    return title, "\n".join(p for p in parts if p)


def _jsonld_post(post: dict, base: str) -> str:
    url = abs_url(base, f"/log/{post['slug']}")
    data = {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": post["title"],
        "description": post["description"],
        "datePublished": post.get("date") or "",
        "dateModified": post.get("updated") or post.get("date") or "",
        "author": {"@type": "Person", "name": post.get("author") or AUTHOR, "url": abs_url(base, AUTHOR_URL)},
        "publisher": {"@type": "Person", "name": AUTHOR, "url": abs_url(base, "/")},
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
        "url": url,
        "image": abs_url(base, OG_IMAGE),
        "keywords": ", ".join(post.get("tags") or []),
        "articleSection": post.get("category") or "Engineering",
        "wordCount": post.get("word_count") or 0,
        "inLanguage": "en",
    }
    return _jsonld(data)


def _jsonld_blog(base: str, heading: str, desc: str, url: str, posts: list) -> str:
    items = [
        {
            "@type": "ListItem",
            "position": i + 1,
            "url": abs_url(base, f"/log/{p['slug']}"),
            "name": p["title"],
        }
        for i, p in enumerate(posts[:50])
    ]
    data = {
        "@context": "https://schema.org",
        "@type": "Blog",
        "name": heading,
        "description": desc,
        "url": url,
        "author": {"@type": "Person", "name": AUTHOR, "url": abs_url(base, "/")},
        "blogPost": items,
    }
    return _jsonld(data)


def _jsonld_breadcrumb(items: list) -> str:
    data = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": name, "item": url}
            for i, (name, url) in enumerate(items)
        ],
    }
    return _jsonld(data)


def _jsonld(data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    return f'<script type="application/ld+json">{payload}</script>'


# ---------------------------------------------------------------------------
# Server-rendered body (injected into #root; React replaces it on hydration)
# ---------------------------------------------------------------------------

def article_html(post: dict, base: str) -> str:
    crumbs = (
        f'<nav class="ssr-crumbs"><a href="/">Home</a> / <a href="/log">Field Notes</a> / '
        f'<span>{_E(post["title"])}</span></nav>'
    )
    tags = "".join(
        f'<a class="ssr-tag" href="/log/tag/{_E(t)}">{_E(t)}</a>' for t in (post.get("tags") or [])
    )
    meta_line = " · ".join(
        x for x in [
            _E(post.get("category") or ""),
            _E(post.get("period_label") or ""),
            f'{post.get("reading_time", 1)} min read',
        ] if x
    )
    toc = ""
    if post.get("toc"):
        lis = "".join(
            f'<li class="lvl{t.get("level", 2)}"><a href="#{_E(t.get("id") or "")}">{_E(t.get("text") or "")}</a></li>'
            for t in post["toc"] if t.get("id")
        )
        if lis:
            toc = f'<nav class="ssr-toc" aria-label="Contents"><h2>On this page</h2><ul>{lis}</ul></nav>'

    month_link = ""
    mm = post.get("month_monthly")
    if mm:
        month_link = (
            f'<p class="ssr-monthlink">Part of the <a href="/log/{_E(mm["slug"])}">'
            f'{_E(mm["period_label"])} build log</a>.</p>'
        )

    related = ""
    if post.get("related"):
        rl = "".join(
            f'<li><a href="/log/{_E(r["slug"])}">{_E(r["title"])}</a></li>' for r in post["related"]
        )
        related = f'<section class="ssr-related"><h2>Related</h2><ul>{rl}</ul></section>'

    return (
        f'<main class="ssr"><article class="ssr-article">{crumbs}'
        f'<header><p class="ssr-eyebrow">{meta_line}</p>'
        f'<h1>{_E(post["title"])}</h1>'
        f'<p class="ssr-lead">{_E(post["description"])}</p>'
        f'<p class="ssr-byline">By {_E(post.get("author") or AUTHOR)} · '
        f'<time datetime="{_E(post.get("date") or "")}">{_E(post.get("period_label") or post.get("date") or "")}</time></p>'
        f'<div class="ssr-tags">{tags}</div></header>'
        f'{month_link}{toc}'
        f'<div class="ssr-body">{post["html"]}</div>'
        f'{related}'
        f'<footer class="ssr-foot"><a href="/log">← All field notes</a></footer>'
        f'</article></main>'
    )


def index_html(posts: list, *, heading: str, subtitle: str) -> str:
    cards = []
    for p in posts:
        tags = "".join(f'<a class="ssr-tag" href="/log/tag/{_E(t)}">{_E(t)}</a>' for t in (p.get("tags") or [])[:4])
        cards.append(
            f'<li class="ssr-card"><a href="/log/{_E(p["slug"])}"><h2>{_E(p["title"])}</h2></a>'
            f'<p class="ssr-eyebrow">{_E(p.get("category") or "")} · {_E(p.get("period_label") or "")} · '
            f'{p.get("reading_time", 1)} min</p>'
            f'<p>{_E(p.get("description") or p.get("excerpt") or "")}</p>'
            f'<div class="ssr-tags">{tags}</div></li>'
        )
    return (
        f'<main class="ssr"><header class="ssr-indexhead"><h1>{_E(heading)}</h1>'
        f'<p class="ssr-lead">{_E(subtitle)}</p></header>'
        f'<ul class="ssr-list">{"".join(cards)}</ul></main>'
    )


# ---------------------------------------------------------------------------
# Shell injection
# ---------------------------------------------------------------------------

def read_shell() -> str | None:
    path = os.path.join(WEBROOT, "index.html")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    return None


def inject(shell: str, *, title: str, head_html: str, body_html: str) -> str:
    if not shell:
        return _standalone(title, head_html, body_html)
    out = shell
    # Replace the title.
    out = re.sub(r"<title>.*?</title>", f"<title>{_E(title)}</title>", out, count=1, flags=re.DOTALL)
    # Drop the shell's static description / OG tags so we don't emit duplicates.
    out = re.sub(r'\s*<meta\s+name="description"[^>]*>', "", out, flags=re.IGNORECASE)
    out = re.sub(r'\s*<meta\s+property="og:[^"]*"[^>]*>', "", out, flags=re.IGNORECASE)
    # Inject our head block.
    if "</head>" in out:
        out = out.replace("</head>", head_html + "\n</head>", 1)
    # Inject the server-rendered body into #root.
    new_root = f'<div id="root">{body_html}</div>'
    if re.search(r'<div id="root"[^>]*>\s*</div>', out):
        out = re.sub(r'<div id="root"[^>]*>\s*</div>', new_root, out, count=1)
    elif '<div id="root"></div>' in out:
        out = out.replace('<div id="root"></div>', new_root, 1)
    return out


def _standalone(title: str, head_html: str, body_html: str) -> str:
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\" />"
        '<meta name="viewport" content="width=device-width, initial-scale=1" />'
        f"<title>{_E(title)}</title>\n{head_html}\n</head><body>{body_html}</body></html>"
    )


# ---------------------------------------------------------------------------
# sitemap.xml / rss.xml / robots.txt
# ---------------------------------------------------------------------------

def sitemap_xml(posts: list, base: str, static_routes: list, tags: list) -> str:
    rows = []

    def url(loc, lastmod=None, priority="0.6"):
        parts = [f"<loc>{_E(loc)}</loc>"]
        if lastmod:
            parts.append(f"<lastmod>{_E(lastmod)}</lastmod>")
        parts.append(f"<priority>{priority}</priority>")
        return "<url>" + "".join(parts) + "</url>"

    for r in static_routes:
        rows.append(url(abs_url(base, r), priority="0.8" if r in ("/", "/log") else "0.5"))
    for p in posts:
        rows.append(url(abs_url(base, f"/log/{p['slug']}"), lastmod=(p.get("updated") or p.get("date") or None), priority="0.7"))
    for t in tags:
        rows.append(url(abs_url(base, f"/log/tag/{t['tag']}"), priority="0.4"))

    body = "".join(rows)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        f"{body}</urlset>"
    )


def rss_xml(posts: list, base: str, limit: int = 40) -> str:
    items = []
    for p in posts[:limit]:
        link = abs_url(base, f"/log/{p['slug']}")
        pub = _rfc822(p.get("date"))
        cats = "".join(f"<category>{_E(t)}</category>" for t in (p.get("tags") or []))
        items.append(
            "<item>"
            f"<title>{_E(p['title'])}</title>"
            f"<link>{_E(link)}</link>"
            f'<guid isPermaLink="true">{_E(link)}</guid>'
            f"<pubDate>{_E(pub)}</pubDate>"
            f"<description>{_E(p.get('description') or p.get('excerpt') or '')}</description>"
            f"{cats}</item>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<rss version="2.0"><channel>'
        f"<title>{_E(BLOG_TITLE)}</title>"
        f"<link>{_E(abs_url(base, '/log'))}</link>"
        f"<description>{_E(BLOG_TAGLINE)}</description>"
        "<language>en</language>"
        f"{''.join(items)}</channel></rss>"
    )


def _rfc822(date_str: str | None) -> str:
    try:
        dt = datetime.strptime(date_str or "", "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        dt = datetime.now(timezone.utc)
    return dt.strftime("%a, %d %b %Y %H:%M:%S +0000")


def robots_txt(base: str) -> str:
    return "User-agent: *\nAllow: /\n\nSitemap: " + abs_url(base, "/sitemap.xml") + "\n"
