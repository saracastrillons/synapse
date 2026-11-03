import pytest

from app.stats import compare, t_two_sided_p, welch
from conftest import PARAMS, summary


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# ───────────────────────────── auth
def test_register_login_me(client, make_user):
    u = make_user()
    assert client.get("/api/auth/me", headers=u["headers"]).json()["email"] == u["email"]
    ok = client.post("/api/auth/login", json={"email": u["email"].upper(), "password": "correct-horse-1"})
    assert ok.status_code == 200
    bad = client.post("/api/auth/login", json={"email": u["email"], "password": "wrong-password"})
    assert bad.status_code == 401
    dup = client.post("/api/auth/register", json={"email": u["email"], "name": "x", "password": "another-pass-1"})
    assert dup.status_code == 409


def test_requires_auth(client):
    assert client.get("/api/projects").status_code == 401
    assert client.get("/api/projects", headers={"Authorization": "Bearer forged"}).status_code == 401


def test_password_is_hashed(client, make_user):
    from app.db import SessionLocal
    from app.models import User
    u = make_user()
    with SessionLocal() as db:
        stored = db.get(User, u["id"]).password_hash
    assert stored.startswith("pbkdf2_sha256$") and "correct-horse-1" not in stored


# ───────────────────────────── projects & permissions
def _project(client, owner):
    r = client.post("/api/projects", json={"name": "Medellín pilot", "description": "Centro"}, headers=owner["headers"])
    assert r.status_code == 201
    return r.json()


def test_project_isolation_and_roles(client, make_user):
    owner, editor, viewer, stranger = make_user("Owner"), make_user("Editor"), make_user("Viewer"), make_user("Stranger")
    p = _project(client, owner)
    pid = p["id"]
    assert p["role"] == "owner"
    # strangers cannot even see that the project exists
    assert client.get(f"/api/projects/{pid}", headers=stranger["headers"]).status_code == 404
    client.post(f"/api/projects/{pid}/members", json={"email": editor["email"], "role": "editor"}, headers=owner["headers"])
    client.post(f"/api/projects/{pid}/members", json={"email": viewer["email"], "role": "viewer"}, headers=owner["headers"])
    # only the owner manages members
    assert client.post(f"/api/projects/{pid}/members", json={"email": stranger["email"]}, headers=editor["headers"]).status_code == 403
    sc = {"name": "Accident", "preset": "oriental", "params": PARAMS}
    assert client.post(f"/api/projects/{pid}/scenarios", json=sc, headers=viewer["headers"]).status_code == 403
    assert client.post(f"/api/projects/{pid}/scenarios", json=sc, headers=editor["headers"]).status_code == 201
    assert len(client.get(f"/api/projects/{pid}/scenarios", headers=viewer["headers"]).json()) == 1
    assert {m["role"] for m in client.get(f"/api/projects/{pid}/members", headers=viewer["headers"]).json()} == {"owner", "editor", "viewer"}
    assert client.delete(f"/api/projects/{pid}", headers=editor["headers"]).status_code == 403
    assert client.delete(f"/api/projects/{pid}", headers=owner["headers"]).status_code == 204
    assert client.get(f"/api/projects/{pid}", headers=owner["headers"]).status_code == 404


def test_scenario_versioning_and_validation(client, make_user):
    u = make_user()
    pid = _project(client, u)["id"]
    bad = {**PARAMS, "hackerField": 1}
    assert client.post(f"/api/projects/{pid}/scenarios", json={"name": "x", "preset": "baseline", "params": bad}, headers=u["headers"]).status_code == 422
    out_of_range = {**PARAMS, "smartNav": 4}
    assert client.post(f"/api/projects/{pid}/scenarios", json={"name": "x", "preset": "baseline", "params": out_of_range}, headers=u["headers"]).status_code == 422
    s = client.post(f"/api/projects/{pid}/scenarios", json={"name": "Storm", "preset": "storm", "params": PARAMS}, headers=u["headers"]).json()
    assert s["version"] == 1
    s2 = client.put(f"/api/scenarios/{s['id']}", json={"name": "Storm v2", "preset": "storm", "params": {**PARAMS, "repairCrews": 4}}, headers=u["headers"]).json()
    assert s2["version"] == 2 and s2["params"]["repairCrews"] == 4


# ───────────────────────────── experiments
def _run_body(a, b, seeds=(2026, 2027, 2028)):
    return {
        "preset": "baseline", "label_a": "Baseline", "label_b": "Fixed signals", "duration": 600,
        "params_a": PARAMS, "params_b": {**PARAMS, "signals": "fixed"},
        "a": [{"seed": s, "summary": x} for s, x in zip(seeds, a)],
        "b": [{"seed": s, "summary": x} for s, x in zip(seeds, b)],
    }


def test_run_stats_are_recomputed_server_side(client, make_user):
    u = make_user()
    pid = _project(client, u)["id"]
    a = [summary(27.5, 0.176), summary(27.1, 0.18), summary(27.9, 0.17)]
    b = [summary(25.4, 0.239), summary(25.0, 0.245), summary(25.8, 0.233)]
    r = client.post(f"/api/projects/{pid}/runs", json=_run_body(a, b), headers=u["headers"])
    assert r.status_code == 201, r.text
    run = r.json()
    assert run["verdict"] == "A"  # fixed-time signals are worse
    speed = next(s for s in run["stats"] if s["kpi"] == "speed")
    assert speed["better"] is False and speed["consistent"] is True
    assert speed["mean_a"] == pytest.approx(27.5) and speed["p_value"] < 0.01
    detail = client.get(f"/api/runs/{run['id']}", headers=u["headers"]).json()
    assert len(detail["replicates"]["a"]) == 3


def test_run_rejects_unpaired_seeds(client, make_user):
    u = make_user()
    pid = _project(client, u)["id"]
    body = _run_body([summary(27, 0.2)], [summary(26, 0.2)], seeds=(1,))
    body["b"][0]["seed"] = 99
    assert client.post(f"/api/projects/{pid}/runs", json=body, headers=u["headers"]).status_code == 422


def test_compare_two_versions(client, make_user):
    u = make_user()
    pid = _project(client, u)["id"]
    r1 = client.post(f"/api/projects/{pid}/runs", json=_run_body([summary(27, .2)] * 3, [summary(25, .25)] * 3), headers=u["headers"]).json()
    r2 = client.post(f"/api/projects/{pid}/runs", json=_run_body([summary(27, .2)] * 3, [summary(29, .15)] * 3), headers=u["headers"]).json()
    cmp = client.get(f"/api/runs/compare?a={r1['id']}&b={r2['id']}", headers=u["headers"]).json()
    assert cmp["verdict"] == "B" and "paired" in cmp["note"]


def test_comments_by_viewer(client, make_user):
    owner, viewer = make_user(), make_user("Viewer")
    pid = _project(client, owner)["id"]
    client.post(f"/api/projects/{pid}/members", json={"email": viewer["email"], "role": "viewer"}, headers=owner["headers"])
    run = client.post(f"/api/projects/{pid}/runs", json=_run_body([summary(27, .2)], [summary(26, .2)], seeds=(5,)), headers=owner["headers"]).json()
    c = client.post(f"/api/runs/{run['id']}/comments", json={"text": "Interesting trade-off"}, headers=viewer["headers"])
    assert c.status_code == 201 and c.json()["user"]["name"] == "Viewer"
    assert len(client.get(f"/api/runs/{run['id']}/comments", headers=owner["headers"]).json()) == 1


# ───────────────────────────── sharing
def test_share_links(client, make_user):
    u = make_user()
    pid = _project(client, u)["id"]
    s = client.post(f"/api/projects/{pid}/scenarios", json={"name": "Heat wave", "preset": "heat", "params": PARAMS}, headers=u["headers"]).json()
    link = client.post("/api/share", json={"kind": "scenario", "id": s["id"]}, headers=u["headers"]).json()
    public = client.get(f"/api/share/{link['token']}")  # no auth header
    assert public.status_code == 200 and public.json()["data"]["preset"] == "heat"
    assert client.get(f"/api/share/{link['token']}").json()["views"] == 2
    assert client.delete(f"/api/share/{link['token']}", headers=u["headers"]).status_code == 204
    assert client.get(f"/api/share/{link['token']}").status_code == 404
    assert client.get("/api/share/not-a-token").status_code == 404


# ───────────────────────────── geospatial
SAN_VICENTE = (6.2638, -75.5652)
PARQUE_BERRIO = (6.2502, -75.5683)


def test_geo_seeded_from_osm(client):
    s = client.get("/api/geo/stats").json()
    assert s["segments"] == 6151
    assert s["facilities"]["hospital"] >= 5


def test_facilities_near(client):
    r = client.get("/api/geo/facilities", params={"lat": SAN_VICENTE[0], "lon": SAN_VICENTE[1], "radius_m": 1200, "kind": "hospital"}).json()
    assert r and all(x["kind"] == "hospital" for x in r)
    assert [x["distance_m"] for x in r] == sorted(x["distance_m"] for x in r)
    assert "San Vicente" in r[0]["name"]


def test_nearest_road_and_route(client):
    road = client.get("/api/geo/nearest-road", params={"lat": PARQUE_BERRIO[0], "lon": PARQUE_BERRIO[1]}).json()
    assert road["distance_m"] < 80
    route = client.get("/api/geo/route", params={"from_lat": PARQUE_BERRIO[0], "from_lon": PARQUE_BERRIO[1], "to_lat": SAN_VICENTE[0], "to_lon": SAN_VICENTE[1]}).json()
    assert route["found"] and route["length_m"] > 1000 and len(route["coordinates"]) > 10


def test_geo_validation(client):
    assert client.get("/api/geo/facilities", params={"lat": 120, "lon": 0}).status_code == 422


# ───────────────────────────── real-time collaboration
def test_websocket_presence_and_events(client, make_user):
    u = make_user("Sara")
    pid = _project(client, u)["id"]
    with client.websocket_connect(f"/api/ws/projects/{pid}") as ws:
        ws.send_json({"type": "auth", "token": u["token"]})
        hello = ws.receive_json()
        assert hello["type"] == "presence" and hello["users"][0]["name"] == "Sara"
        client.post(f"/api/projects/{pid}/scenarios", json={"name": "Live", "preset": "baseline", "params": PARAMS}, headers=u["headers"])
        ev = ws.receive_json()
        assert ev["type"] == "scenario_saved" and ev["name"] == "Live"


def test_websocket_rejects_non_members(client, make_user):
    owner, stranger = make_user(), make_user()
    pid = _project(client, owner)["id"]
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/ws/projects/{pid}") as ws:
            ws.send_json({"type": "auth", "token": stranger["token"]})
            ws.receive_json()


def test_login_rate_limited(client, make_user):
    u = make_user()
    for _ in range(8):
        assert client.post("/api/auth/login", json={"email": u["email"], "password": "wrong-password"}).status_code == 401
    blocked = client.post("/api/auth/login", json={"email": u["email"], "password": "correct-horse-1"})
    assert blocked.status_code == 429 and "Retry-After" in blocked.headers


# ───────────────────────────── statistics
def test_t_distribution_reference_values():
    # Student t, two-sided: t=2.228, df=10 → p≈0.05; t=0 → p=1
    assert t_two_sided_p(2.228, 10) == pytest.approx(0.05, abs=1e-3)
    assert t_two_sided_p(0, 5) == pytest.approx(1.0)


def test_welch_and_verdict():
    t, p = welch([1.0, 2.0, 3.0], [1.0, 2.0, 3.0])
    assert t == 0 and p == pytest.approx(1.0)
    rows, verdict = compare([{"summary": summary(20, .3)}], [{"summary": summary(20, .3)}])
    assert verdict == "tie" and all(r["better"] is None for r in rows)
