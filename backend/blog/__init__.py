"""Blog engine — load Markdown posts, render to HTML, build the index.

Posts live in ``backend/blog/posts/*.md`` with YAML frontmatter. At import time we
parse the frontmatter, render the body (Markdown + server-side Pygments
highlighting), compute a reading time, extract a table of contents, and wire up
prev/next plus related posts. Everything is cached in memory so request handlers
are cheap.

Design goals:
- One bad file never takes down the blog (load errors are logged and skipped).
- Missing frontmatter fields degrade gracefully to sensible defaults.
- Two tracks share one model: ``kind: deepdive`` and ``kind: monthly``, joined by
  the ``month`` field so a monthly digest links to its per-problem deep dives.
"""
from __future__ import annotations

import html as _html
import logging
import os
import re

import markdown
import yaml
from markdown.extensions.codehilite import CodeHiliteExtension
from markdown.extensions.toc import TocExtension

log = logging.getLogger("portfolio")

POSTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "posts")
WORDS_PER_MINUTE = 220

_FRONTMATTER_RE = re.compile(r"^﻿?---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)
_MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


# ---------------------------------------------------------------------------
# Parsing / rendering helpers
# ---------------------------------------------------------------------------

def _split_frontmatter(text: str):
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    raw, body = m.group(1), m.group(2)
    try:
        meta = yaml.safe_load(raw) or {}
    except yaml.YAMLError as e:
        log.warning("blog: bad frontmatter YAML: %s", e)
        meta = {}
    return (meta if isinstance(meta, dict) else {}), body


def _make_md() -> markdown.Markdown:
    return markdown.Markdown(
        extensions=[
            "fenced_code",
            "tables",
            "sane_lists",
            "attr_list",
            "smarty",
            CodeHiliteExtension(guess_lang=False, css_class="codehilite", linenums=False),
            TocExtension(anchorlink=False, permalink=False, toc_depth="2-3"),
        ]
    )


def _strip_html(s: str) -> str:
    return _html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))).strip()


def _excerpt(body_html: str, limit: int = 200) -> str:
    # First real paragraph, trimmed to a word boundary.
    para = re.search(r"<p>(.*?)</p>", body_html, re.DOTALL)
    text = _strip_html(para.group(1)) if para else _strip_html(body_html)
    if len(text) <= limit:
        return text
    cut = text[:limit]
    return (cut[: cut.rfind(" ")] if " " in cut else cut).rstrip() + "…"


def _word_count(body_md: str) -> int:
    no_code = re.sub(r"```.*?```", " ", body_md, flags=re.DOTALL)
    no_code = re.sub(r"`[^`]*`", " ", no_code)
    return len(re.findall(r"\b[\w']+\b", no_code))


def _toc_list(md: markdown.Markdown):
    out = []

    def walk(tokens, depth=0):
        for tok in tokens or []:
            if depth <= 1:  # h2/h3 only
                out.append({
                    "id": tok.get("id"),
                    "text": _html.unescape(tok.get("name") or ""),  # smarty entity-encodes quotes
                    "level": tok.get("level"),
                })
            walk(tok.get("children"), depth + 1)

    walk(getattr(md, "toc_tokens", []))
    return out


def _coerce_tags(v):
    if isinstance(v, list):
        return [str(t).strip() for t in v if str(t).strip()]
    if isinstance(v, str):
        return [t.strip() for t in v.split(",") if t.strip()]
    return []


def _period_label(month: str) -> str:
    m = re.match(r"^(\d{4})-(\d{2})$", month or "")
    if not m:
        return month or ""
    yr, mo = int(m.group(1)), int(m.group(2))
    return f"{_MONTHS[mo - 1]} {yr}" if 1 <= mo <= 12 else month


def _load_one(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    meta, body = _split_frontmatter(raw)
    slug = str(meta.get("slug") or os.path.splitext(os.path.basename(path))[0]).strip()

    md = _make_md()
    body_html = md.convert(body)
    words = _word_count(body)
    date = str(meta.get("date") or "")
    month = str(meta.get("month") or (date[:7] if len(date) >= 7 else ""))

    stats = None
    if meta.get("stats_commits") is not None:
        stats = {
            "commits": meta.get("stats_commits"),
            "backend": meta.get("stats_backend"),
            "frontend": meta.get("stats_frontend"),
        }

    return {
        "slug": slug,
        "title": str(meta.get("title") or slug.replace("-", " ").title()),
        "description": str(meta.get("description") or _excerpt(body_html)),
        "excerpt": _excerpt(body_html),
        "date": date,
        "updated": str(meta.get("updated") or date),
        "kind": str(meta.get("kind") or "deepdive"),
        "category": str(meta.get("category") or "Engineering"),
        "tags": _coerce_tags(meta.get("tags")),
        "month": month,
        "period_label": _period_label(month),
        "repo": str(meta.get("repo") or ""),
        "author": str(meta.get("author") or "Sachal Chandio"),
        "reading_time": max(1, round(words / WORDS_PER_MINUTE)),
        "word_count": words,
        "html": body_html,
        "toc": _toc_list(md),
        "stats": stats,
    }


def _ref(p: dict) -> dict:
    return {
        "slug": p["slug"],
        "title": p["title"],
        "kind": p["kind"],
        "date": p["date"],
        "category": p["category"],
        "period_label": p["period_label"],
        "reading_time": p["reading_time"],
    }


def _related(post: dict, posts: list, limit: int = 4):
    tags = set(post["tags"])
    scored = []
    for other in posts:
        if other["slug"] == post["slug"]:
            continue
        overlap = len(tags & set(other["tags"]))
        if overlap:
            # small boost for same category, prefer the opposite track for variety
            score = overlap * 10 + (2 if other["category"] == post["category"] else 0)
            scored.append((score, other["date"], other))
    scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
    return [_ref(o) for _, _, o in scored[:limit]]


# ---------------------------------------------------------------------------
# Index build (cached at import)
# ---------------------------------------------------------------------------

def _build():
    posts = []
    if os.path.isdir(POSTS_DIR):
        for name in sorted(os.listdir(POSTS_DIR)):
            if not name.endswith(".md"):
                continue
            try:
                posts.append(_load_one(os.path.join(POSTS_DIR, name)))
            except Exception as e:  # noqa: BLE001 - never let one file break the blog
                log.warning("blog: failed to load %s: %s", name, e)

    posts.sort(key=lambda p: (p["date"], p["slug"]), reverse=True)

    # month grouping: each month maps to its monthly digest + its deep dives
    month_map: dict[str, dict] = {}
    for p in posts:
        bucket = month_map.setdefault(p["month"], {"monthly": None, "deepdives": []})
        if p["kind"] == "monthly":
            bucket["monthly"] = p
        else:
            bucket["deepdives"].append(p)

    for i, p in enumerate(posts):
        p["newer"] = _ref(posts[i - 1]) if i > 0 else None
        p["older"] = _ref(posts[i + 1]) if i < len(posts) - 1 else None
        p["related"] = _related(p, posts)
        bucket = month_map.get(p["month"], {})
        if p["kind"] == "monthly":
            p["month_deepdives"] = [_ref(d) for d in bucket.get("deepdives", [])]
            p["month_monthly"] = None
        else:
            monthly = bucket.get("monthly")
            p["month_monthly"] = _ref(monthly) if monthly else None
            p["month_deepdives"] = []

    by_slug = {p["slug"]: p for p in posts}
    return posts, by_slug


_POSTS, _BY_SLUG = _build()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

_LIGHT_KEYS = (
    "slug title description excerpt date updated kind category tags month "
    "period_label repo author reading_time word_count stats"
).split()


def _light(p: dict) -> dict:
    return {k: p[k] for k in _LIGHT_KEYS if k in p}


def all_posts() -> list:
    """Full post dicts, newest first (includes rendered html)."""
    return _POSTS


def list_posts(kind: str | None = None, tag: str | None = None, category: str | None = None) -> list:
    """Lightweight list (no html/toc) for index pages and the JSON API."""
    out = []
    for p in _POSTS:
        if kind and p["kind"] != kind:
            continue
        if tag and tag not in p["tags"]:
            continue
        if category and p["category"] != category:
            continue
        out.append(_light(p))
    return out


def get_post(slug: str) -> dict | None:
    return _BY_SLUG.get(slug)


def all_tags() -> list:
    counts: dict[str, int] = {}
    for p in _POSTS:
        for t in p["tags"]:
            counts[t] = counts.get(t, 0) + 1
    return [{"tag": t, "count": c} for t, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def all_categories() -> list:
    counts: dict[str, int] = {}
    for p in _POSTS:
        counts[p["category"]] = counts.get(p["category"], 0) + 1
    return [{"category": c, "count": n} for c, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def stats() -> dict:
    deep = sum(1 for p in _POSTS if p["kind"] == "deepdive")
    monthly = sum(1 for p in _POSTS if p["kind"] == "monthly")
    commits = sum((p["stats"] or {}).get("commits") or 0 for p in _POSTS if p["stats"])
    return {
        "total": len(_POSTS),
        "deepdives": deep,
        "monthly": monthly,
        "tags": len(all_tags()),
        "commits": commits,
    }


def reload():
    """Re-read posts from disk (handy in dev)."""
    global _POSTS, _BY_SLUG
    _POSTS, _BY_SLUG = _build()
    return len(_POSTS)
