# Sachal Chandio — Portfolio

A production-shaped Flask portfolio for a senior backend / DevOps engineer.
The hero is a live, orbitable **Three.js** model of a multi-provider architecture
(provider silos streaming into a unified-search core), and the app ships with the
operational scaffolding the site talks about: a container image, Compose file,
Kubernetes manifests, and real health endpoints the probes call.

## Stack

- **Backend:** Flask 3 (data-driven Jinja2 templates, JSON API endpoints)
- **Frontend:** vanilla JS, CSS custom properties, Three.js (CDN, ES modules)
- **Ops:** Docker, Docker Compose, Kubernetes (liveness/readiness probes), Gunicorn

## Run locally

```bash
python -m venv venv
# Windows:  venv\Scripts\activate
# macOS/Linux:  source venv/bin/activate
pip install -r requirements.txt
python app.py
# → http://localhost:5000
```

## Run with Docker

```bash
docker compose up --build
# → http://localhost:8000
```

The image runs Gunicorn as a non-root user and defines a `HEALTHCHECK`
that hits `/healthz`.

## Deploy to Kubernetes

```bash
docker build -t sachal-portfolio:latest .
kubectl apply -f k8s/
kubectl port-forward svc/sachal-portfolio 8080:80
# → http://localhost:8080
```

`k8s/deployment.yaml` runs 2 replicas with CPU/memory requests and limits, a
**liveness** probe on `/healthz`, and a **readiness** probe on `/readyz`.

## Routes

| Route           | Purpose                                            |
|-----------------|----------------------------------------------------|
| `/`             | The portfolio page                                 |
| `/resume`       | Download the PDF résumé                             |
| `/api/metrics`  | JSON feed of headline metrics                       |
| `/api/contact`  | `POST` — validates and logs a contact message       |
| `/healthz`      | Liveness — process up + uptime                      |
| `/readyz`       | Readiness — ready to serve traffic                  |

## Editing content

All copy lives in plain Python structures at the top of [`app.py`](app.py)
(`PROFILE`, `METRICS`, `CAPABILITIES`, `PROJECTS`, `EXPERIENCE`, `STACK`,
`EDUCATION`) and renders through Jinja2 — change the data, not the markup.
