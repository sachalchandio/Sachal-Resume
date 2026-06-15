# =========================================================================
# Single-image production build — one container that serves the React SPA
# AND the Flask API on one origin. Ideal for free single-service hosts
# (Render, Railway, Fly). For the two-tier nginx + Flask setup, use
# docker-compose.yml instead.
# =========================================================================

# --- Stage 1: build the React app ---
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: Flask (gunicorn) serving the API + the built SPA ---
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000
WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY --from=web /web/dist ./webroot

RUN useradd --create-home appuser && chown -R appuser /app
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import os,urllib.request,sys; sys.exit(0) if urllib.request.urlopen(f'http://localhost:{os.environ.get(\"PORT\",\"8000\")}/healthz').status==200 else sys.exit(1)"

# Shell form so ${PORT} (set by the host) is expanded.
CMD gunicorn --bind 0.0.0.0:${PORT:-8000} --workers 2 --threads 4 app:app
