"""LLM planner for the SYNAPSE Copilot.

The simulation runs in the browser, so tools execute there. This module is a
stateless, rate-limited proxy that owns three things the client must not:

  * the provider API key (never sent to the browser),
  * the system instructions,
  * the catalogue of *authorised* tools the model may call.

Each POST /api/copilot/step forwards the conversation (Gemini `contents`
format, including previous function calls and their results) and returns the
model's next message: either function calls for the browser to execute, or the
final answer.
"""
from __future__ import annotations

import json
import os
import time
from collections import defaultdict, deque
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
MAX_CONTENTS = 60
MAX_BODY = 400_000
RATE_WINDOW_S = 600
RATE_MAX = 60


def api_key() -> str | None:
    return os.getenv("GEMINI_API_KEY") or None


def model_name() -> str:
    return os.getenv("GEMINI_MODEL", "gemini-flash-latest")


def model_chain() -> list[str]:
    """Primary model first, then fallbacks (GEMINI_FALLBACK_MODELS, comma-separated)."""
    fallbacks = os.getenv("GEMINI_FALLBACK_MODELS", "gemini-flash-lite-latest").split(",")
    chain = [model_name()] + [m.strip() for m in fallbacks if m.strip()]
    return list(dict.fromkeys(chain))


RETRYABLE = {429, 500, 502, 503, 504}
CALL_TIMEOUT_S = float(os.getenv("GEMINI_TIMEOUT_S", "75"))


def _strip_signatures(contents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**c, "parts": [{k: v for k, v in p.items() if k != "thoughtSignature"} for p in c.get("parts", [])]} for c in contents]


SYSTEM = """You are SYNAPSE Copilot, the operations agent of SYNAPSE — a live, agent-based digital twin of
Medellín Centro (Colombia) built on real OpenStreetMap roads, hospitals, fire stations and substations.
Traffic demand, electrical loads and incidents are synthetic and seeded; never present them as real-world data.

How you work:
- You can only learn about the city through tools. Never invent numbers, streets, units or results.
- Before recommending any intervention, test it with run_experiment (at least 2 seeds) and base the
  recommendation on the measured KPIs. The first strategy you pass is the baseline ("do nothing" or the
  current policy); include 2–4 alternatives.
- Prefer few, purposeful tool calls. If the user names a street, pass it exactly as written.
- Actions that change the live city (block_road, create_emergency, trip_substation, clear_incident) are
  fine when the user asks for them or clearly implies them. To change policy parameters, call
  propose_parameters: the user confirms in the UI — never claim it is already applied.
- Answer in the user's language (Spanish or English). Be concise: 2–5 short paragraphs or a short list.
  Lead with the conclusion, then the evidence (numbers with units, seeds, minutes simulated), then caveats.
  Use **bold** for the key figure. No tables, no headings.

Parameter meanings: vehicles (200–2400 agents), capacity (0.5–1.5 lane multiplier), smartNav (0–1 share of
drivers with live navigation), signals ('fixed' 30 s or 'adaptive' max-pressure), preemption (emergency green
wave), storm (0–1), powerDemand (0.6–1.6), repairCrews (1–4), ambulances (1–3 per hospital),
incidentRate (random emergencies per hour)."""

PARAMS_SCHEMA = {
    "type": "object",
    "properties": {
        "vehicles": {"type": "integer", "description": "Private vehicles in the network (200–2400)"},
        "capacity": {"type": "number", "description": "Usable-lane multiplier (0.5–1.5)"},
        "smartNav": {"type": "number", "description": "Share of drivers on live navigation (0–1)"},
        "signals": {"type": "string", "enum": ["fixed", "adaptive"]},
        "preemption": {"type": "boolean", "description": "Emergency vehicles get green at junctions"},
        "storm": {"type": "number", "description": "Storm intensity (0–1)"},
        "powerDemand": {"type": "number", "description": "Electricity demand multiplier (0.6–1.6)"},
        "repairCrews": {"type": "integer", "description": "Grid repair crews (1–4)"},
        "ambulances": {"type": "integer", "description": "Ambulances per hospital (1–3)"},
        "incidentRate": {"type": "number", "description": "Random emergencies per hour (0–20)"},
    },
}

TOOLS: list[dict[str, Any]] = [
    {"name": "get_city_state", "description": "Current KPIs of the live twin: clock, mean speed, delay index, trips/h, CO2, power served, active incidents, outages.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "find_hotspots", "description": "Most congested streets right now, worst first, and a 10-minute congestion forecast.",
     "parameters": {"type": "object", "properties": {"k": {"type": "integer", "description": "How many (1–8)"}}}},
    {"name": "list_incidents", "description": "Active incidents (accidents, medical, fires) with status and assigned unit.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "block_road", "description": "Create a lane-blocking accident on a named street in the live twin (dispatch happens automatically).",
     "parameters": {"type": "object", "properties": {"street": {"type": "string"}, "minutes": {"type": "integer", "description": "Clearance time once a unit arrives (default 15)"}}, "required": ["street"]}},
    {"name": "clear_incident", "description": "Clear an incident immediately.",
     "parameters": {"type": "object", "properties": {"incident_id": {"type": "integer"}}, "required": ["incident_id"]}},
    {"name": "compute_detour", "description": "Shortest detour around a blocked street segment with A* and Dijkstra (time, length, streets used, nodes expanded). Defaults to the active blocking incident.",
     "parameters": {"type": "object", "properties": {"incident_id": {"type": "integer"}}}},
    {"name": "evaluate_dispatch", "description": "ETA of every ambulance (or fire truck) to a street using A* on live travel times.",
     "parameters": {"type": "object", "properties": {"street": {"type": "string"}, "unit": {"type": "string", "enum": ["ambulance", "fire"]}}, "required": ["street"]}},
    {"name": "create_emergency", "description": "Create an emergency on a street in the live twin; the dispatcher sends the minimum-ETA unit and the camera follows it.",
     "parameters": {"type": "object", "properties": {"kind": {"type": "string", "enum": ["medical", "fire", "accident"]}, "street": {"type": "string"}}, "required": ["kind", "street"]}},
    {"name": "grid_status", "description": "Substations: online/offline, load vs capacity, repair ETA.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "trip_substation", "description": "Take a substation offline (simulated failure) for some minutes.",
     "parameters": {"type": "object", "properties": {"name": {"type": "string"}, "minutes": {"type": "integer"}}, "required": ["name"]}},
    {"name": "compare_algorithms", "description": "Route corner to corner across the twin with A* and Dijkstra; returns cost, nodes expanded and runtime of each.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "run_experiment", "description": "Run controlled simulations in a background worker. Every strategy is simulated on the same seeds (common random numbers). The first strategy is the baseline. Returns mean KPIs per strategy ranked by the objective.",
     "parameters": {"type": "object", "properties": {
         "strategies": {"type": "array", "description": "2–5 strategies; first = baseline", "items": {"type": "object", "properties": {
             "label": {"type": "string"}, "params": PARAMS_SCHEMA}, "required": ["label"]}},
         "objective": {"type": "string", "enum": ["traffic", "emergency", "grid"], "description": "What 'best' means"},
         "minutes": {"type": "integer", "description": "Simulated minutes per run (3–15, default 7)"},
         "seeds": {"type": "integer", "description": "Replicates (1–3, default 2)"},
         "include_active_incidents": {"type": "boolean", "description": "Reproduce current blocking incidents in every run (default true)"},
         "storm": {"type": "number", "description": "Optional storm intensity for the stress test (0–1)"},
         "trip_substation": {"type": "string", "description": "Optional substation that fails during each run"},
     }, "required": ["strategies", "objective"]}},
    {"name": "propose_parameters", "description": "Propose a policy change to apply to the live twin. The user confirms it in the UI.",
     "parameters": {"type": "object", "properties": {"label": {"type": "string"}, "params": PARAMS_SCHEMA}, "required": ["label", "params"]}},
    {"name": "focus_map", "description": "Move the camera to a street.",
     "parameters": {"type": "object", "properties": {"street": {"type": "string"}}, "required": ["street"]}},
]


# Gemini rejects OBJECT schemas with no properties: argument-less tools omit `parameters`.
for _t in TOOLS:
    if not _t["parameters"]["properties"]:
        del _t["parameters"]


class StepIn(BaseModel):
    contents: list[dict[str, Any]] = Field(min_length=1, max_length=MAX_CONTENTS)


router = APIRouter(prefix="/api/copilot", tags=["copilot"])
_calls: dict[str, deque[float]] = defaultdict(deque)


def _rate_limit(ip: str) -> None:
    q = _calls[ip]
    now = time.monotonic()
    while q and q[0] < now - RATE_WINDOW_S:
        q.popleft()
    if len(q) >= RATE_MAX:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Copilot rate limit reached, try again in a few minutes")
    q.append(now)


@router.get("/status")
def copilot_status():
    return {"enabled": bool(api_key()), "provider": "gemini", "model": model_name(), "tools": [t["name"] for t in TOOLS]}


@router.post("/step")
async def step(body: StepIn, request: Request):
    key = api_key()
    if not key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "LLM copilot not configured (set GEMINI_API_KEY)")
    if len(json.dumps(body.contents)) > MAX_BODY:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Conversation too long — start a new one")
    _rate_limit(request.client.host if request.client else "?")
    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": body.contents,
        "tools": [{"functionDeclarations": TOOLS}],
        "toolConfig": {"functionCallingConfig": {"mode": "AUTO"}},
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
    }
    # Overloaded or rate-limited models are common at peak hours: fall through a chain of models.
    errors: list[str] = []
    r = None
    used = model_name()
    async with httpx.AsyncClient(timeout=CALL_TIMEOUT_S) as client:
        for i, model in enumerate(model_chain()):
            body_for_model = payload
            if i > 0:
                # thinking signatures are model-specific: drop them when switching models
                body_for_model = {**payload, "contents": _strip_signatures(payload["contents"])}
            try:
                r = await client.post(GEMINI_URL.format(model=model), json=body_for_model, headers={"x-goog-api-key": key})
            except httpx.HTTPError as exc:
                errors.append(f"{model}: {exc.__class__.__name__}")
                r = None
                continue
            if r.status_code == 200:
                used = model
                break
            try:
                msg = r.json().get("error", {}).get("message", r.text)
            except ValueError:
                msg = r.text
            errors.append(f"{model} ({r.status_code}): {msg[:160]}")
            if r.status_code not in RETRYABLE:
                break  # bad key or bad request: switching models will not help
            r = None
    if r is None or r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "LLM provider error — " + " | ".join(errors))
    data = r.json()
    cands = data.get("candidates") or []
    if not cands or "content" not in cands[0]:
        reason = (cands[0].get("finishReason") if cands else None) or data.get("promptFeedback", {}).get("blockReason", "empty response")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"LLM returned no content ({reason})")
    # parts are returned verbatim: thinking models attach signatures that must be echoed back
    return {"parts": cands[0]["content"].get("parts", []), "model": used, "usage": data.get("usageMetadata", {})}
