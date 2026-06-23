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
