<div align="center">

# `[ SC ]` &nbsp;Sachal Chandio — Portfolio

### Backends that stay **fast**, **consistent**, **observable**, and **hard to break**.

A two-tier portfolio — a **Flask** JSON API and a **React + TypeScript** SPA — with two
interactive **Three.js** scenes, served as one container or two. Design, tests, and CI included.

<br/>

[![CI](https://github.com/sachalchandio/Sachal-Resume/actions/workflows/ci.yml/badge.svg)](https://github.com/sachalchandio/Sachal-Resume/actions/workflows/ci.yml)
&nbsp;
![backend tests](https://img.shields.io/badge/backend_tests-8_passing-4DE3D2?style=flat-square&labelColor=0A0E1A)
![frontend tests](https://img.shields.io/badge/frontend_tests-7_passing-7C6CF0?style=flat-square&labelColor=0A0E1A)
![license](https://img.shields.io/badge/license-MIT-FFB454?style=flat-square&labelColor=0A0E1A)

<br/>

![Python](https://img.shields.io/badge/Python_3.12-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask_3-000000?style=for-the-badge&logo=flask&logoColor=white)
![React](https://img.shields.io/badge/React_18-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript_5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite_5-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=three.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=for-the-badge&logo=kubernetes&logoColor=white)

<br/>

**[ Live demo — _add your deploy URL here_ ]** &nbsp;·&nbsp; [GitHub](https://github.com/sachalchandio) &nbsp;·&nbsp; [LinkedIn](https://www.linkedin.com/in/sachal-chandio-749b7528/)

<br/>

<img src="docs/preview-portfolio.png" alt="Portfolio — the engineering side" width="92%"/>

</div>

---

## ✨ Highlights

- **Two-tier architecture** — a Flask JSON API the React SPA consumes; ships as one image *or* nginx + Flask.
- **Live 3D, two ways** — an orbitable [architecture model](frontend/src/three/ArchitectureScene.tsx) on the hero and a drifting [crystal field](frontend/src/three/CrystalScene.tsx) on the off-duty page, both as React components.
- **Data-driven** — every word lives in [`backend/content.py`](backend/content.py) and is served as JSON. Edit the data, not the markup.
- **Real ops** — non-root Docker image, `/healthz` + `/readyz` probes, and Kubernetes manifests that actually use them.
- **Tested & gated** — `pytest` + `Vitest` suites and a GitHub Actions pipeline that won't ship a red build.
- **Accessible & responsive** — keyboard focus, `prefers-reduced-motion`, and a clean collapse to mobile.

---

## 🏗 Architecture

```mermaid
flowchart LR
    V["🧑‍💼 Visitor"] --> FE

    subgraph FE["⚛️  React SPA · Vite + TypeScript"]
        direction TB
        R1["Portfolio  /"]
        R2["Off-Duty  /off-duty"]
        R3["Three.js scenes"]
    end

    FE -->|"fetch JSON"| BE

    subgraph BE["🐍  Flask API · gunicorn"]
        direction TB
        A1["GET /api/portfolio"]
        A2["GET /api/off-duty"]
        A3["POST /api/contact"]
        A4["/healthz · /readyz"]
    end

    BE --> DATA[("content.py<br/>single source of truth")]
```

> **Two deployment shapes from one codebase:** a single image where Flask serves the built SPA **and** the API on one origin ([`Dockerfile`](Dockerfile)) — ideal for a free host — or a two-service split with nginx serving the React build and proxying to Flask ([`docker-compose.yml`](docker-compose.yml)).

---

## 🧰 Tech stack

| Layer        | Tools |
|--------------|-------|
| **Frontend** | React 18 · TypeScript · Vite · React Router · Three.js · vanilla CSS (custom properties) |
| **Backend**  | Flask 3 · gunicorn · flask-cors |
| **Testing**  | pytest · Vitest · Testing Library |
| **Ops**      | Docker · nginx · Kubernetes · GitHub Actions |

#### 🎨 Design — _"Deep Infrastructure"_

A control-room palette for a backend engineer — telemetry cyan, depth violet, a sparing amber, on midnight.

![void](https://img.shields.io/badge/-0A0E1A?style=flat-square&color=0A0E1A&label=void)
![cyan](https://img.shields.io/badge/-4DE3D2?style=flat-square&color=4DE3D2&label=cyan)
![violet](https://img.shields.io/badge/-7C6CF0?style=flat-square&color=7C6CF0&label=violet)
![amber](https://img.shields.io/badge/-FFB454?style=flat-square&color=FFB454&label=amber)

Type: **Space Grotesk** (display) · **IBM Plex Sans** (body) · **IBM Plex Mono** (telemetry).

---

## 📂 Project structure

```
Sachal-Resume/
├── backend/                  # Flask JSON API
│   ├── app.py                #   routes + SPA serving
│   ├── content.py            #   all content (single source of truth)
│   ├── tests/                #   pytest suite
│   └── Dockerfile            #   API-only image (two-tier setup)
├── frontend/                 # React + TypeScript SPA (Vite)
│   ├── src/
│   │   ├── pages/            #   Portfolio · OffDuty · NotFound
│   │   ├── components/       #   Nav, Reveal, Counter, ContactForm, …
│   │   ├── three/            #   ArchitectureScene · CrystalScene
│   │   └── api.ts            #   typed API client
│   ├── nginx.conf            #   serves SPA + proxies /api (two-tier)
│   └── Dockerfile            #   web image (two-tier setup)
├── k8s/                      # Kubernetes manifests (backend + frontend)
├── Dockerfile                # single-image build (SPA + API, one origin)
├── docker-compose.yml        # two-tier local stack
└── .github/workflows/ci.yml  # tests + build pipeline
```

---

## 🚀 Quickstart

<details open>
<summary><b>Local dev</b> — two terminals</summary>

```bash
# 1 · API  →  http://localhost:5000
cd backend && pip install -r requirements.txt && python app.py

# 2 · Web  →  http://localhost:5173   (Vite proxies /api to the backend)
cd frontend && npm install && npm run dev
```
</details>

<details>
<summary><b>One container</b> — Flask serves the SPA + API</summary>

```bash
docker build -t sachal-portfolio .
docker run -p 8000:8000 sachal-portfolio
# → http://localhost:8000
```
</details>

<details>
<summary><b>Two-tier stack</b> — nginx + Flask</summary>

```bash
docker compose up --build
# → http://localhost:8080
```
</details>

---

## 🧪 Tests & CI

```bash
cd backend  && pip install -r requirements-dev.txt && pytest -q   # 8 passing
cd frontend && npm test                                          # 7 passing
```

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push & PR:
**backend `pytest`** → **frontend `typecheck → test → build`** → **build both Docker images**.

---

## ☁️ Deploy

The single-image [`Dockerfile`](Dockerfile) deploys as-is to any Docker host
(Render, Railway, Fly.io, Hugging Face Spaces). One service, one URL serving the
site and `/api/*`.

| Setting | Value |
|---|---|
| Runtime | Docker |
| Dockerfile | `./Dockerfile` |
| Build context | repo root |
| Health check | `/healthz` |
| Port | `$PORT` (auto) |

---

## 🔌 API

| Route            | Method | Purpose                              |
|------------------|--------|--------------------------------------|
| `/api/portfolio` | `GET`  | All data for the main page           |
| `/api/off-duty`  | `GET`  | Games, anime, the lines I keep around |
| `/api/contact`   | `POST` | Validate + log a contact message     |
| `/api/metrics`   | `GET`  | Headline metrics feed                |
| `/resume`        | `GET`  | Download the PDF résumé              |
| `/healthz`       | `GET`  | Liveness                             |
| `/readyz`        | `GET`  | Readiness                            |

---

## 🎮 The off-duty page

There's a human behind the commits — a whole second page with an animated anime
shelf (five quotes each), a Berserk wall, and the games on rotation.

<div align="center">
<img src="docs/preview-offduty.png" alt="Off-Duty — the human side" width="92%"/>
</div>

---

<div align="center">

**Sachal Chandio** — Senior Software Engineer · Backend · Distributed Data · DevOps

[sachalchandio@gmail.com](mailto:sachalchandio@gmail.com) &nbsp;·&nbsp; [GitHub](https://github.com/sachalchandio) &nbsp;·&nbsp; [LinkedIn](https://www.linkedin.com/in/sachal-chandio-749b7528/) &nbsp;·&nbsp; [YouTube](https://www.youtube.com/c/sachalchandio)

<sub>Built with Flask · React · Three.js · Docker · Kubernetes</sub>

</div>
