# Sachal Chandio — Portfolio

A two-tier portfolio: a **Flask JSON API** backend and a **React (Vite + TypeScript)**
single-page frontend. The frontend consumes content from the API and renders two
routes — the engineering portfolio (`/`) and an off-duty page (`/off-duty`) — with
two interactive **Three.js** scenes written as React components.

```
┌─────────────────┐      /api/portfolio        ┌──────────────────┐
│  React (Vite)   │  ───────────────────────▶  │   Flask API      │
│  nginx :80      │      /api/off-duty          │  gunicorn :8000  │
│  SPA + 3D       │      /api/contact           │  content.py      │
└─────────────────┘      /resume, /healthz      └──────────────────┘
```

## Layout

```
backend/    Flask API — content.py (data) + app.py (routes), CORS, health probes
frontend/   React + TypeScript SPA (Vite), Three.js scenes, React Router
k8s/        Kubernetes manifests (backend + frontend)
docker-compose.yml
```

## Run locally (two terminals)

**Backend** — http://localhost:5000

```bash
cd backend
pip install -r requirements.txt
python app.py
```

**Frontend** — http://localhost:5173 (Vite proxies `/api`, `/resume`, `/healthz` to :5000)

```bash
cd frontend
npm install
npm run dev
```

## Run with Docker (one command)

```bash
docker compose up --build
# → http://localhost:8080
```

nginx serves the built React app and proxies `/api`, `/resume`, `/healthz`
to the Flask backend over the compose network.

## Deploy to Kubernetes

```bash
docker build -t sachal-portfolio-api:latest ./backend
docker build -t sachal-portfolio-web:latest ./frontend
kubectl apply -f k8s/
kubectl port-forward svc/portfolio-frontend 8080:80
# → http://localhost:8080
```

Two Deployments (2 replicas each) with resource limits; the backend Service is
named `backend` so the frontend's nginx upstream resolves in-cluster, and the
Flask pods expose `/healthz` (liveness) and `/readyz` (readiness) probes.

## API

| Route            | Method | Purpose                                  |
|------------------|--------|------------------------------------------|
| `/api/portfolio` | GET    | All data for the main page               |
| `/api/off-duty`  | GET    | Games, anime, Berserk lines              |
| `/api/contact`   | POST   | Validate + log a contact message         |
| `/api/metrics`   | GET    | Headline metrics feed                    |
| `/resume`        | GET    | Download the PDF résumé                   |
| `/healthz`       | GET    | Liveness                                 |
| `/readyz`        | GET    | Readiness                                |

## Editing content

All copy lives in [`backend/content.py`](backend/content.py) as plain Python
structures and is served as JSON — change the data, not the components.

## Adding your photos

Drop `portrait.jpg` and `portrait-2.jpg` into [`frontend/public/`](frontend/public)
and they appear automatically (About panel and the off-the-clock section). Until
then a clean `[SC]` monogram stands in.
