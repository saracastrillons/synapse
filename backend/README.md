# SYNAPSE API

FastAPI backend for the SYNAPSE digital twin: accounts, shared projects, persisted
scenarios and experiments, public share links, geospatial queries (PostGIS /
pgRouting) and real-time collaboration over WebSockets (Redis pub/sub).

The simulation itself runs in the browser (deterministic TypeScript engine). The
API stores what users decide to keep and **does not trust client conclusions**:
when an A/B experiment is saved, it recomputes means, standard deviations, deltas,
a Welch t-test per KPI and the verdict from the raw per-seed results, and it
rejects experiments whose arms were not run on the same seeds.

## Run locally (SQLite, no Docker)

```bash
cd backend
py -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --port 8010
```

Interactive docs: http://localhost:8010/docs. On first start the road network
(6,151 segments) and the 23 critical facilities are loaded from
`frontend/public/data/medellin.json`.

## Full stack (PostgreSQL + PostGIS + pgRouting + Redis)

```bash
docker compose up --build
```

Web on http://localhost:8080, API on http://localhost:8010.

## Endpoints

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` (JWT bearer, PBKDF2-SHA256 passwords) |
| Projects | `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/{id}` |
| Collaboration | `GET/POST /api/projects/{id}/members`, `DELETE …/members/{user}` — roles owner / editor / viewer; `WS /api/ws/projects/{id}` (first message `{type: "auth", token}`) presence + live events |
| Scenarios | `GET/POST /api/projects/{id}/scenarios`, `GET/PUT/DELETE /api/scenarios/{id}` (versioned) |
| Experiments | `GET/POST /api/projects/{id}/runs`, `GET/DELETE /api/runs/{id}`, `GET /api/runs/compare?a=&b=`, `GET/POST /api/runs/{id}/comments` |
| Sharing | `POST /api/share`, `GET /api/share/{token}` (public, read-only, view counter), `DELETE /api/share/{token}` |
| Geospatial | `GET /api/geo/stats`, `GET /api/geo/facilities?lat&lon&radius_m&kind` (`ST_DWithin`), `GET /api/geo/nearest-road` (KNN `<->`), `GET /api/geo/route` (`pgr_dijkstra`) |
| Ops | `GET /api/health` — database, PostGIS, pgRouting and event-bus status |

Every geospatial query has a pure-Python fallback, so the same API (and the same
tests) work on SQLite during development.

## Security notes

- Non-members get `404` for a project (ids cannot be enumerated); insufficient role → `403`.
- Simulation parameters are validated against a strict schema (`extra="forbid"`, ranges).
- Payload size is capped (`MAX_PAYLOAD_BYTES`); share links can expire and be revoked.
- Failed logins are rate-limited (8 per 5 min per client + email → `429`).
- WebSocket clients authenticate in-band, so JWTs never appear in URLs or access logs.
- Set `JWT_SECRET` (≥ 32 chars) in production; in development a random secret is persisted to the git-ignored `backend/.dev_jwt_secret`.

## Tests

```bash
.venv\Scripts\python -m pytest -q          # SQLite
set TEST_DATABASE_URL=postgresql+psycopg://synapse:synapse@localhost:5432/synapse
.venv\Scripts\python -m pytest -q          # against PostGIS/pgRouting
```

CI runs both variants on every push.
