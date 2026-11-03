"""Geospatial layer: seeds the OSM-derived network into the database and answers
spatial queries. On PostgreSQL it uses PostGIS (geography distances, GiST/KNN
indexes) and pgRouting when the extension is present; on SQLite it falls back to
equivalent pure-Python computations so the API behaves the same in development."""
from __future__ import annotations

import heapq
import json
import logging
import math
from functools import lru_cache
from typing import Any

from sqlalchemy import func, insert, text
from sqlalchemy.orm import Session

from .config import settings
from .db import engine, is_postgres
from .models import Facility, RoadSegment

log = logging.getLogger("synapse.geo")
M_PER_DEG_LAT = 110_574.0
EARTH_R = 6_371_008.8


def _unproject(meta: dict[str, Any]):
    lat0, lon0 = meta["center"]["lat"], meta["center"]["lon"]
    m_lon = 111_320.0 * math.cos(math.radians(lat0))
    return lambda x, z: (lat0 - z / M_PER_DEG_LAT, lon0 + x / m_lon)


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


_caps: dict[str, bool] | None = None


def capabilities() -> dict[str, bool]:
    global _caps
    if _caps is not None:
        return _caps
    if not is_postgres():
        return {"postgis": False, "pgrouting": False}
    with engine.connect() as c:
        exts = {r[0] for r in c.execute(text("SELECT extname FROM pg_extension"))}
    _caps = {"postgis": "postgis" in exts, "pgrouting": "pgrouting" in exts}
    return _caps


def seed(db: Session) -> None:
    if db.query(RoadSegment.id).first():
        if is_postgres():
            _postgis_upgrade(db)
        return
    if not settings.data_path.exists():
        log.warning("dataset %s not found; geo endpoints will be empty", settings.data_path)
        return
    data = json.loads(settings.data_path.read_text(encoding="utf-8"))
    to_ll = _unproject(data["meta"])
    rows = []
    for i, e in enumerate(data["roads"]["edges"]):
        ll = [to_ll(x, z) for x, z in e["pts"]]
        cost = e["len"] / max(1.0, e["speed"] / 3.6)
        rows.append({
            "id": i + 1, "source": e["a"], "target": e["b"], "name": e["name"], "cls": e["cls"], "lanes": e["lanes"],
            "speed_kmh": e["speed"], "oneway": e["oneway"], "length_m": e["len"], "cost": cost,
            "reverse_cost": -1.0 if e["oneway"] else cost,
            "min_lat": min(p[0] for p in ll), "max_lat": max(p[0] for p in ll),
            "min_lon": min(p[1] for p in ll), "max_lon": max(p[1] for p in ll),
            "wkt": "LINESTRING(" + ",".join(f"{lon:.7f} {lat:.7f}" for lat, lon in ll) + ")",
        })
    db.execute(insert(RoadSegment), rows)
    fac = []
    for p in data["pois"]:
        lat, lon = to_ll(p["x"], p["z"])
        fac.append({"kind": p["kind"], "name": p["name"], "lat": lat, "lon": lon})
    db.execute(insert(Facility), fac)
    db.commit()
    log.info("seeded %d road segments and %d facilities", len(rows), len(fac))
    if is_postgres():
        _postgis_upgrade(db)


def _postgis_upgrade(db: Session) -> None:
    db.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
    try:
        db.execute(text("CREATE EXTENSION IF NOT EXISTS pgrouting"))
        db.commit()
    except Exception:  # image without pgRouting
        db.rollback()
    for stmt in [
        "ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS geom geometry(LineString, 4326)",
        "UPDATE road_segments SET geom = ST_GeomFromText(wkt, 4326) WHERE geom IS NULL",
        "CREATE INDEX IF NOT EXISTS road_segments_geom_gix ON road_segments USING GIST (geom)",
        "ALTER TABLE facilities ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326)",
        "UPDATE facilities SET geom = ST_SetSRID(ST_MakePoint(lon, lat), 4326) WHERE geom IS NULL",
        "CREATE INDEX IF NOT EXISTS facilities_geom_gix ON facilities USING GIST (geom)",
        "ANALYZE road_segments", "ANALYZE facilities",
    ]:
        db.execute(text(stmt))
    db.commit()


# ───────────────────────────── queries
def facilities_near(db: Session, lat: float, lon: float, radius_m: float, kind: str | None) -> list[dict[str, Any]]:
    if capabilities()["postgis"]:
        sql = """SELECT id, kind, name, lat, lon,
                   ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography) AS distance_m
                 FROM facilities
                 WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, :r)
                   AND (CAST(:kind AS text) IS NULL OR kind = :kind)
                 ORDER BY distance_m"""
        return [dict(r._mapping) for r in db.execute(text(sql), {"lat": lat, "lon": lon, "r": radius_m, "kind": kind})]
    q = db.query(Facility)
    if kind:
        q = q.filter(Facility.kind == kind)
    out = []
    for f in q:
        d = haversine(lat, lon, f.lat, f.lon)
        if d <= radius_m:
            out.append({"id": f.id, "kind": f.kind, "name": f.name, "lat": f.lat, "lon": f.lon, "distance_m": d})
    return sorted(out, key=lambda r: r["distance_m"])


def _parse_wkt(wkt: str) -> list[tuple[float, float]]:
    """LINESTRING(lon lat, …) → [(lat, lon), …]"""
    body = wkt[wkt.index("(") + 1: wkt.rindex(")")]
    return [(float(p.split()[1]), float(p.split()[0])) for p in body.split(",")]


def _point_segment_m(lat: float, lon: float, a: tuple[float, float], b: tuple[float, float]) -> float:
    k = math.cos(math.radians(lat))
    ax, ay = (a[1] - lon) * k, a[0] - lat
    bx, by = (b[1] - lon) * k, b[0] - lat
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy or 1e-18)))
    return math.hypot(ax + t * dx, ay + t * dy) * M_PER_DEG_LAT


def nearest_road(db: Session, lat: float, lon: float) -> dict[str, Any] | None:
    if capabilities()["postgis"]:
        sql = """SELECT id, name, cls, source, target,
                   ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography) AS distance_m
                 FROM road_segments ORDER BY geom <-> ST_SetSRID(ST_MakePoint(:lon, :lat), 4326) LIMIT 1"""
        r = db.execute(text(sql), {"lat": lat, "lon": lon}).first()
        return dict(r._mapping) if r else None
    pad = 0.004
    cands = db.query(RoadSegment).filter(
        RoadSegment.min_lat <= lat + pad, RoadSegment.max_lat >= lat - pad,
        RoadSegment.min_lon <= lon + pad, RoadSegment.max_lon >= lon - pad).all()
    best, bd = None, math.inf
    for s in cands:
        pts = _parse_wkt(s.wkt)
        d = min(_point_segment_m(lat, lon, pts[i], pts[i + 1]) for i in range(len(pts) - 1))
        if d < bd:
            best, bd = s, d
    if not best:
        return None
    return {"id": best.id, "name": best.name, "cls": best.cls, "source": best.source, "target": best.target, "distance_m": bd}


@lru_cache(maxsize=1)
def _graph() -> dict[int, list[tuple[int, float, int]]]:
    from .db import SessionLocal
    adj: dict[int, list[tuple[int, float, int]]] = {}
    with SessionLocal() as db:
        for s in db.query(RoadSegment.id, RoadSegment.source, RoadSegment.target, RoadSegment.cost, RoadSegment.reverse_cost):
            adj.setdefault(s.source, []).append((s.target, s.cost, s.id))
            if s.reverse_cost >= 0:
                adj.setdefault(s.target, []).append((s.source, s.reverse_cost, s.id))
    return adj


def _dijkstra(src: int, dst: int) -> tuple[float, list[int], int]:
    adj = _graph()
    dist, prev, seen = {src: 0.0}, {}, set()
    heap = [(0.0, src)]
    while heap:
        d, u = heapq.heappop(heap)
        if u in seen:
            continue
        seen.add(u)
        if u == dst:
            break
        for v, c, eid in adj.get(u, []):
            nd = d + c
            if nd < dist.get(v, math.inf):
                dist[v], prev[v] = nd, (u, eid)
                heapq.heappush(heap, (nd, v))
    if dst not in dist:
        return math.inf, [], len(seen)
    edges, v = [], dst
    while v != src:
        u, eid = prev[v]
        edges.append(eid)
        v = u
    return dist[dst], edges[::-1], len(seen)


def route(db: Session, a: tuple[float, float], b: tuple[float, float]) -> dict[str, Any]:
    ra, rb = nearest_road(db, *a), nearest_road(db, *b)
    if not ra or not rb:
        return {"found": False, "reason": "no road near one of the points"}
    src, dst = ra["source"], rb["target"]
    if capabilities()["pgrouting"]:
        sql = """SELECT d.seq, d.edge, d.agg_cost FROM pgr_dijkstra(
                   'SELECT id, source, target, cost, reverse_cost FROM road_segments', :s, :t, directed => true) d
                 ORDER BY d.seq"""
        rows = db.execute(text(sql), {"s": src, "t": dst}).all()
        edges = [r.edge for r in rows if r.edge != -1]
        cost = rows[-1].agg_cost if rows else math.inf
        engine_name, expanded = "pgRouting pgr_dijkstra", None
    else:
        cost, edges, expanded = _dijkstra(src, dst)
        engine_name = "Python Dijkstra (pgRouting unavailable)"
    if not edges:
        return {"found": False, "engine": engine_name}
    segs = {s.id: s for s in db.query(RoadSegment).filter(RoadSegment.id.in_(edges))}
    coords: list[tuple[float, float]] = []
    for eid in edges:
        coords.extend(_parse_wkt(segs[eid].wkt))
    names = []
    for eid in edges:
        n = segs[eid].name
        if n and (not names or names[-1] != n):
            names.append(n)
    return {
        "found": True, "engine": engine_name, "cost_s": cost, "edges": len(edges), "expanded": expanded,
        "length_m": sum(segs[e].length_m for e in edges), "streets": names[:12],
        "from_road": ra, "to_road": rb, "coordinates": [[lat, lon] for lat, lon in coords],
    }


def network_stats(db: Session) -> dict[str, Any]:
    by_cls = db.query(RoadSegment.cls, func.count(RoadSegment.id), func.sum(RoadSegment.length_m)).group_by(RoadSegment.cls).all()
    by_kind = db.query(Facility.kind, func.count(Facility.id)).group_by(Facility.kind).all()
    return {
        "segments": sum(c for _, c, _ in by_cls),
        "km_by_class": {cls: round((km or 0) / 1000, 2) for cls, _, km in by_cls},
        "facilities": dict(by_kind),
        **capabilities(),
    }
