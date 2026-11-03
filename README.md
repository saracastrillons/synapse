# SYNAPSE — The Living Digital Twin of Earth

**An interactive computational laboratory that turns urban problems into reproducible experiments.**
Agent-based traffic, emergency response and power-grid simulation on the real OpenStreetMap network of Medellín, Colombia — with an AI copilot that runs simulations to test its own recommendations before it makes them.

> Pilot city: **Medellín · Centro / La Candelaria** (≈ 2.4 × 3.1 km, 5,592 junctions, 6,151 road segments, 140 signalised intersections, 12 emergency units, 3 substations).

---

## What you can do

| Module | What it does |
|---|---|
| **Earth Command** | Holographic 3D globe (20k land points, coastlines, data arcs, satellites). Click Medellín and the camera descends into the city. |
| **City Twin** | 3D city with OSM roads coloured by live congestion, extruded buildings whose windows go dark during blackouts, ~1,300 autonomous vehicles, signals, hospitals, fire stations, substations, heatmap and storm effects. |
| **Scenario Lab** | Six situations (baseline, +40 % demand, Avenida Oriental accident, storm & blackout, ambulance gauntlet, heat wave). Run an **A/B experiment** with up to 5 seeds, compare 8 KPIs with mean ± sd, export CSV/JSON, share a link, open a printable executive report. |
| **Time Machine** | Snapshots every 15 simulated seconds. Click the timeline to rewind, change a decision and watch the new branch diverge from the dashed original. |
| **Autonomous Agents** | Every vehicle has a goal, constraints and a strategy (fixed route vs. live navigation). Click one to follow it and read its decision log. |
| **AI Command Center** | A **Gemini tool-calling agent** (English & Spanish) that picks among 14 authorised engine tools, runs controlled experiments and explains its recommendation with the measured deltas and a confidence level. Policy changes are only *proposed* — the user confirms them. Falls back to a deterministic on-device planner offline. |
| **Compare experiments** | Put any two experiments (local or cloud) side by side — two versions of the city — with KPI deltas, time series and server-side Welch t-tests. |

Try: *"A major accident just blocked Avenida Oriental. Find the fastest way to restore traffic flow."*
The copilot blocks the road, computes the detour with A* and Dijkstra, simulates four response strategies on identical seeds, ranks them and lets you apply the winner live.

## Engineering highlights

- **Deterministic engine.** Fixed 0.2 s step, one seeded PRNG stored inside the state, no wall-clock inputs. Same seed + parameters + events ⇒ identical run (verified by tests, and identical between Node and the browser).
- **Shared engine, two runtimes.** The same TypeScript engine drives the live 3D view and a **Web Worker** that runs batches of headless experiments without dropping frames.
- **Models:** Intelligent Driver Model car-following on a lane-level directed graph · A* (admissible heuristic) and Dijkstra on live travel times · fixed-time vs **max-pressure** adaptive signals with emergency pre-emption · severity-ordered, ETA-minimising dispatch · substation load/hazard model with repair crews · per-edge z-score anomaly detection · trend forecast of the delay index.
- **LLM agent with guard-rails.** The API owns the key, the system prompt and the tool catalogue; the browser executes tools on the live twin and returns results to the model. Model-supplied parameters are sanitised (unknown keys dropped, ranges clamped), the loop is step-bounded and rate-limited, and failures degrade to the offline planner.
- **Experimental rigour.** A/B arms use common random numbers; results report replicate spread and whether the effect has the same sign in every seed.
- **Data pipeline** (`pipeline/`): Python scripts download OSM via Overpass, build a simplified directed graph, keep the largest strongly-connected component (Kosaraju), project to local metres and generate the globe from Natural Earth.
- **Rendering:** React Three Fiber, custom GLSL (holographic globe, atmosphere, building windows/blackouts, flowing route lines, heatmap, rain), instanced meshes for vehicles and signals, bloom post-processing.

## Cloud workspace (backend)

The twin runs entirely in the browser, so the public demo needs no server. When the **SYNAPSE API** is running, a *Cloud workspace* panel adds:

- **Accounts & projects** with owner / editor / viewer roles and invitations.
- **Saved, versioned scenarios** (preset + parameters + seed) that anyone on the team can replay live.
- **Saved experiments** whose statistics are **recomputed server-side** (means, sd, Welch t-test per KPI, verdict); unpaired seeds are rejected.
- **Real-time collaboration**: presence and a live activity feed over WebSockets, fanned out through Redis pub/sub.
- **Comments** on experiment results and **public read-only links** (`?share=…`) that open a scenario or result without an account.
- **Geospatial API** on PostgreSQL + PostGIS + pgRouting: facilities within a radius, nearest road (KNN), server-side shortest path.

See [backend/README.md](backend/README.md).

## Architecture

```
backend/                  FastAPI · SQLAlchemy · PostgreSQL/PostGIS/pgRouting (SQLite in dev) · Redis · JWT · WebSockets
pipeline/                 Python → OSM/Natural Earth → frontend/public/data/*.json
frontend/src/
  sim/                    engine (pure TS, no DOM): graph, routing, engine, scenarios, experiment, worker
  runtime.ts              live loop, Time Machine snapshots & branches, worker client
  lab.ts                  A/B experiments, statistics, exports, share links, reports
  ai/copilot.ts           planning agent: intent → tool plan → simulations → explanation
  three/                  Globe, CityScene, geometry & shaders
  ui/                     HUD, Scenario Lab, Command Center, charts
```

## Run it

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
npm test           # engine test-suite (routing optimality, determinism, Time Machine replay, dispatch, grid)
npm run e2e        # Playwright end-to-end tests in real Chromium (desktop + phone)
npm run build      # static build in frontend/dist — deployable to Vercel / Netlify / GitHub Pages
```

Backend (optional — enables the Cloud workspace):

```bash
cd backend
py -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --port 8010
```

Everything with Docker (PostgreSQL + PostGIS + pgRouting, Redis, API, web on http://localhost:8080):

```bash
docker compose up --build
```

Rebuild the datasets (optional):

```bash
py pipeline/fetch_osm.py
py pipeline/build_globe.py
```

## Data & honesty note

Roads, critical facilities and 1,396 building footprints come from **© OpenStreetMap contributors (ODbL)**; 6,067 additional buildings are procedurally generated to fill unmapped blocks and are flagged as such in the dataset. Traffic demand, electrical loads and incidents are **synthetic, seeded and uncalibrated**: SYNAPSE compares strategies; it does not forecast Medellín's real traffic.

## Roadmap

- LLM planner (tool-calling) on top of the same authorised engine tools.
- Alembic migrations, rate limiting, observability (Prometheus metrics).
- More cities, calibration against open traffic counts.

---

Built by **[saracastrillons](https://github.com/saracastrillons)** · Systems Engineering · part of a portfolio with **NEXUS** (observes the world) and **AETHER** (analyses business data) — SYNAPSE lets you experiment with what *could* happen before deciding.
