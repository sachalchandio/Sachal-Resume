# api/index.py
# Vercel's Python runtime loads the top-level `app` (a WSGI/Flask instance)
# from this entrypoint and serves it as one Vercel Function. We reuse the
# existing Flask app in backend/app.py (which does `import content`), so we
# put backend/ on sys.path first, then re-export its `app`.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app import app  # noqa: E402,F401  -> Vercel loads this top-level `app`
