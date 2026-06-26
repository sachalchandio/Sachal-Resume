"""
Sachal Chandio — Portfolio API (Flask)

A JSON API consumed by the React frontend. Content lives in content.py; this
module serves it over HTTP and exposes real operational endpoints (/healthz,
/readyz) for the Docker HEALTHCHECK and Kubernetes probes.
"""
from __future__ import annotations

import logging
import os
import platform
import threading
import time
from collections import deque
from datetime import datetime, timezone

from flask import Flask, g, jsonify, request, send_from_directory
from flask_cors import CORS

import content
import blog
from blog import seo as blog_seo

app = Flask(__name__, static_folder="static")
# Allow the React dev server / deployed frontend to call the API.
CORS(app, resources={r"/api/*": {"origins": "*"}, r"/resume": {"origins": "*"}})

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-7s  %(message)s")
log = logging.getLogger("portfolio")

STARTED_AT = datetime.now(timezone.utc)

APP_VERSION = os.environ.get("APP_VERSION", "1.0.0")
GIT_SHA = os.environ.get("GIT_SHA") or os.environ.get("SOURCE_COMMIT") or ""
REGION = os.environ.get("HF_SPACE_REGION") or os.environ.get("REGION") or "auto"

# Live, in-process operational metrics — make the "this site is a running
# service" claim literally true. Per-worker counters; a small rolling window
# of real handler latencies feeds the status sparkline.
_metrics_lock = threading.Lock()
_request_count = 0
_latencies_ms: "deque[float]" = deque(maxlen=120)


@app.before_request
def _start_timer() -> None:
    g._t0 = time.perf_counter()


@app.after_request
def _record_metrics(resp):
    global _request_count
    t0 = getattr(g, "_t0", None)
    if t0 is not None:
        with _metrics_lock:
            _request_count += 1
            _latencies_ms.append((time.perf_counter() - t0) * 1000.0)
    return resp


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Content API — consumed by the React frontend.
# ---------------------------------------------------------------------------

@app.get("/api/portfolio")
def api_portfolio():
    """Everything the main portfolio page renders."""
    return jsonify({
        "profile": content.PROFILE,
        "metrics": content.METRICS,
        "capabilities": content.CAPABILITIES,
        "about": content.ABOUT,
        "projects": content.PROJECTS,
        "experience": content.EXPERIENCE,
        "stack": content.STACK,
        "education": content.EDUCATION,
        "youtube": content.YOUTUBE_URL,
    })


@app.get("/api/off-duty")
def api_off_duty():
    """The human side — games, anime, the lines I keep around."""
    return jsonify({
        "gaming": content.GAMING,
        "anime": content.ANIME,
        "berserk": content.BERSERK,
        "youtube": content.YOUTUBE_URL,
        "profile": {"name": content.PROFILE["name"]},
    })


@app.get("/api/projects")
def api_projects():
    """Work-in-progress projects for the /projects page."""
    return jsonify({"building": content.BUILDING})


@app.get("/api/metrics")
def api_metrics():
    return jsonify({"metrics": content.METRICS, "generated_at": _now_iso()})


@app.post("/api/contact")
def api_contact():
    """Validate a contact message and log it (visible in container logs)."""
    data = request.get_json(silent=True) or request.form
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip()
    message = (data.get("message") or "").strip()

    errors = {}
    if len(name) < 2:
        errors["name"] = "Tell me who you are."
    if "@" not in email or "." not in email:
        errors["email"] = "A reachable email helps me reply."
    if len(message) < 10:
        errors["message"] = "A little more detail, please."
    if errors:
        return jsonify({"ok": False, "errors": errors}), 400

    log.info("Contact message from %s <%s>: %s", name, email, message[:280])
    return jsonify({"ok": True, "message": "Thanks — I’ll get back to you soon."})


@app.get("/resume")
def resume():
    """Serve the PDF résumé for the download button."""
    return send_from_directory(
        app.static_folder,
        "Sachal_Chandio_Resume.pdf",
        as_attachment=True,
        download_name="Sachal_Chandio_Resume.pdf",
    )


# --- Operational endpoints (Docker HEALTHCHECK + k8s probes call these) ---

@app.get("/healthz")
def healthz():
    uptime = (datetime.now(timezone.utc) - STARTED_AT).total_seconds()
    return jsonify({"status": "ok", "uptime_seconds": round(uptime, 1)})


@app.get("/readyz")
def readyz():
    return jsonify({"status": "ready", "checked_at": _now_iso()})


@app.get("/api/status")
def api_status():
    """Live operational snapshot — powers the system-status hero.

    Real values: uptime since process start, a per-process request counter, and
    measured handler latencies (p50/p95/last) from a rolling window.
    """
    now = datetime.now(timezone.utc)
    with _metrics_lock:
        count = _request_count
        raw = list(_latencies_ms)
    samples = sorted(raw)

    def pct(p: float):
        if not samples:
            return None
        idx = min(len(samples) - 1, int(round((p / 100.0) * (len(samples) - 1))))
        return round(samples[idx], 2)

    return jsonify({
        "status": "operational",
        "service": "portfolio-api",
        "version": APP_VERSION,
        "commit": GIT_SHA[:7] if GIT_SHA else None,
        "region": REGION,
        "runtime": f"Python {platform.python_version()} · Flask · gunicorn",
        "started_at": STARTED_AT.isoformat(),
        "uptime_seconds": round((now - STARTED_AT).total_seconds(), 1),
        "requests_served": count,
        "latency_ms": {
            "last": round(raw[-1], 2) if raw else None,
            "p50": pct(50),
            "p95": pct(95),
        },
        "samples": [round(x, 2) for x in raw[-40:]],
        "now": now.isoformat(),
    })


# ---------------------------------------------------------------------------
# Blog ("Field Notes") — JSON API + server-rendered HTML for SEO.
# Server-rendered routes bake the full article + meta + JSON-LD into the page so
# crawlers and social scrapers never need to run JavaScript; React hydrates #root
# for real visitors. These explicit rules beat the SPA catch-all by specificity.
# ---------------------------------------------------------------------------

_BLOG_STATIC_ROUTES = ["/", "/projects", "/off-duty", "/log"]


def _base_url() -> str:
    override = os.environ.get("SITE_URL")
    if override:
        return override.rstrip("/")
    proto = (request.headers.get("X-Forwarded-Proto", "").split(",")[0].strip()
             or request.scheme)
    host = (request.headers.get("X-Forwarded-Host", "").split(",")[0].strip()
            or request.host)
    return f"{proto}://{host}"


@app.get("/api/blog")
def api_blog():
    return jsonify({
        "posts": blog.list_posts(),
        "tags": blog.all_tags(),
        "categories": blog.all_categories(),
        "stats": blog.stats(),
    })


@app.get("/api/blog/<slug>")
def api_blog_post(slug: str):
    post = blog.get_post(slug)
    if not post:
        return jsonify({"error": "not_found", "message": "No such post."}), 404
    return jsonify(post)


def _render_blog(title: str, head_html: str, body_html: str, status: int = 200):
    html = blog_seo.inject(blog_seo.read_shell(), title=title, head_html=head_html, body_html=body_html)
    return app.response_class(html, status=status, mimetype="text/html")


@app.get("/log")
def log_index():
    base = _base_url()
    posts = blog.list_posts()
    title, head = blog_seo.head_for_index(
        base, heading="Field Notes", desc=blog_seo.BLOG_TAGLINE, path="/log", posts=posts
    )
    body = blog_seo.index_html(posts, heading="Field Notes", subtitle=blog_seo.BLOG_TAGLINE)
    return _render_blog(title, head, body)


@app.get("/log/tag/<tag>")
def log_tag(tag: str):
    base = _base_url()
    posts = blog.list_posts(tag=tag)
    desc = f"Posts tagged “{tag}” — technical field notes from building Telelinkz."
    title, head = blog_seo.head_for_index(
        base, heading=f"#{tag}", desc=desc, path=f"/log/tag/{tag}", posts=posts
    )
    body = blog_seo.index_html(posts, heading=f"Tagged: {tag}", subtitle=desc)
    return _render_blog(title, head, body)


@app.get("/log/<slug>")
def log_post(slug: str):
    post = blog.get_post(slug)
    if not post:
        body = ('<main class="ssr"><h1>Post not found</h1>'
                '<p><a href="/log">All field notes</a></p></main>')
        return _render_blog("Not found — Sachal Chandio", "", body, status=404)
    base = _base_url()
    title, head = blog_seo.head_for_post(post, base)
    body = blog_seo.article_html(post, base)
    return _render_blog(title, head, body)


@app.get("/sitemap.xml")
def sitemap_xml():
    xml = blog_seo.sitemap_xml(blog.list_posts(), _base_url(), _BLOG_STATIC_ROUTES, blog.all_tags())
    return app.response_class(xml, mimetype="application/xml")


@app.get("/rss.xml")
def rss_xml():
    xml = blog_seo.rss_xml(blog.list_posts(), _base_url())
    return app.response_class(xml, mimetype="application/rss+xml")


@app.get("/robots.txt")
def robots_txt():
    return app.response_class(blog_seo.robots_txt(_base_url()), mimetype="text/plain")


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"error": "not_found", "message": "No such endpoint."}), 404


# --- Single-image production: serve the built React app from ./webroot ---
# In the combined Docker image, the Vite build is copied here and Flask serves
# both the API (above) and the SPA (below) on one origin. Absent in local
# API-only dev, where the React dev server handles the frontend instead.
WEBROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "webroot")


@app.get("/")
@app.get("/<path:path>")
def spa(path: str = ""):
    # The API namespace never falls through to the SPA.
    if path.startswith("api/"):
        return jsonify({"error": "not_found", "message": "No such endpoint."}), 404
    if os.path.isdir(WEBROOT):
        target = os.path.join(WEBROOT, path)
        if path and os.path.isfile(target):
            return send_from_directory(WEBROOT, path)
        return send_from_directory(WEBROOT, "index.html")  # SPA deep-link fallback
    return jsonify({"service": "portfolio-api", "try": "/api/portfolio"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=bool(os.environ.get("FLASK_DEBUG")))
