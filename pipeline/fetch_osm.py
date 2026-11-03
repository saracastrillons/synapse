"""
SYNAPSE data pipeline — builds the Medellín digital-twin dataset from OpenStreetMap.

Downloads roads, buildings and critical infrastructure for a bounded area of
Medellín (Centro / La Candelaria) through the public Overpass API and converts
them into a compact JSON file consumed by the simulation engine:

  * a simplified, directed road graph (intersections + polyline edges)
  * building footprints with estimated heights
  * points of interest: hospitals, fire stations, police, power substations

Coordinates are projected to a local metric plane (x = east, z = south) centred
on the bounding box, so the frontend can work directly in meters.

Usage:  py pipeline/fetch_osm.py
Output: frontend/public/data/medellin.json   (© OpenStreetMap contributors, ODbL)
"""
from __future__ import annotations

import json
import math
import random
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

BBOX = (6.236, -75.580, 6.264, -75.558)  # south, west, north, east
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "pipeline" / ".cache"
OUT = ROOT / "frontend" / "public" / "data" / "medellin.json"

ROAD_CLASSES = {
    # highway tag: (class, lanes, speed km/h)
    "motorway": ("arterial", 3, 70), "motorway_link": ("arterial", 1, 50),
    "trunk": ("arterial", 3, 60), "trunk_link": ("arterial", 1, 40),
    "primary": ("arterial", 2, 50), "primary_link": ("arterial", 1, 40),
    "secondary": ("collector", 2, 40), "secondary_link": ("collector", 1, 30),
    "tertiary": ("collector", 1, 35), "tertiary_link": ("collector", 1, 30),
    "residential": ("local", 1, 30), "unclassified": ("local", 1, 30),
    "living_street": ("local", 1, 20),
}

LAT0 = (BBOX[0] + BBOX[2]) / 2
LON0 = (BBOX[1] + BBOX[3]) / 2
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))


def project(lat: float, lon: float) -> tuple[float, float]:
    """WGS84 -> local plane in meters (x east, z south — Three.js convention)."""
    return round((lon - LON0) * M_PER_DEG_LON, 1), round(-(lat - LAT0) * M_PER_DEG_LAT, 1)


def overpass(name: str, query: str) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"{name}.json"
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    body = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(6):
        url = MIRRORS[attempt % len(MIRRORS)]
        print(f"  downloading {name} from {url} (attempt {attempt + 1})", flush=True)
        req = urllib.request.Request(url, data=body, headers={"User-Agent": "synapse-digital-twin/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                raw = resp.read().decode("utf-8")
            break
        except OSError as exc:  # HTTPError / URLError / timeouts
            print(f"    failed: {exc}", flush=True)
            time.sleep(5 * (attempt + 1))
    else:
        raise RuntimeError(f"Overpass unavailable for {name}")
    cached.write_text(raw, encoding="utf-8")
    return json.loads(raw)


def bbox_str() -> str:
    return ",".join(str(v) for v in BBOX)


def build_roads(data: dict) -> dict:
    nodes = {n["id"]: (n["lat"], n["lon"]) for n in data["elements"] if n["type"] == "node"}
    ways = [w for w in data["elements"] if w["type"] == "way" and w["tags"].get("highway") in ROAD_CLASSES]

    # Count how many ways touch each OSM node -> intersections are nodes with degree != 2
    use = defaultdict(int)
    for w in ways:
        for i, nid in enumerate(w["nodes"]):
            use[nid] += 2 if i in (0, len(w["nodes"]) - 1) else 1
    is_junction = {nid for nid, c in use.items() if c != 2}

    junction_index: dict[int, int] = {}
    out_nodes: list[list[float]] = []

    def jid(osm_id: int) -> int:
        if osm_id not in junction_index:
            junction_index[osm_id] = len(out_nodes)
            out_nodes.append(list(project(*nodes[osm_id])))
        return junction_index[osm_id]

    edges = []
    for w in ways:
        tags = w["tags"]
        cls, lanes, speed = ROAD_CLASSES[tags["highway"]]
        try:
            lanes = max(1, int(str(tags.get("lanes", "")).split(";")[0]) // (1 if tags.get("oneway") == "yes" else 2))
        except ValueError:
            pass
        try:
            speed = int(str(tags.get("maxspeed", speed)).split()[0])
        except ValueError:
            pass
        oneway = tags.get("oneway") in ("yes", "1", "true") or tags.get("junction") == "roundabout" \
            or tags["highway"] in ("motorway", "motorway_link")
        reverse = tags.get("oneway") == "-1"
        ids = [n for n in w["nodes"] if n in nodes]
        if reverse:
            ids.reverse()
            oneway = True

        seg = [ids[0]]
        for nid in ids[1:]:
            seg.append(nid)
            if nid in is_junction or nid == ids[-1]:
                pts = [list(project(*nodes[s])) for s in seg]
                length = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
                if length > 1:
                    edges.append({
                        "a": jid(seg[0]), "b": jid(seg[-1]), "pts": pts, "len": round(length, 1),
                        "cls": cls, "lanes": lanes, "speed": speed, "oneway": oneway,
                        "name": tags.get("name", ""),
                    })
                seg = [nid]

    # Keep only the largest strongly connected component so every route is reachable.
    adj = defaultdict(list)
    radj = defaultdict(list)
    for e in edges:
        adj[e["a"]].append(e["b"]); radj[e["b"]].append(e["a"])
        if not e["oneway"]:
            adj[e["b"]].append(e["a"]); radj[e["a"]].append(e["b"])
    keep = largest_scc(len(out_nodes), adj, radj)
    remap = {old: new for new, old in enumerate(sorted(keep))}
    edges = [e for e in edges if e["a"] in keep and e["b"] in keep]
    for e in edges:
        e["a"], e["b"] = remap[e["a"]], remap[e["b"]]
    out_nodes = [out_nodes[i] for i in sorted(keep)]
    return {"nodes": out_nodes, "edges": edges}


def largest_scc(n: int, adj, radj) -> set[int]:
    """Kosaraju, iterative."""
    seen, order = [False] * n, []
    for s in range(n):
        if seen[s]:
            continue
        stack = [(s, iter(adj[s]))]
        seen[s] = True
        while stack:
            v, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                order.append(v); stack.pop()
            elif not seen[nxt]:
                seen[nxt] = True
                stack.append((nxt, iter(adj[nxt])))
    comp = [-1] * n
    best, best_size, c = -1, 0, 0
    for s in reversed(order):
        if comp[s] != -1:
            continue
        size, stack = 0, [s]
        comp[s] = c
        while stack:
            v = stack.pop(); size += 1
            for u in radj[v]:
                if comp[u] == -1:
                    comp[u] = c; stack.append(u)
        if size > best_size:
            best, best_size = c, size
        c += 1
    return {i for i in range(n) if comp[i] == best}


def build_buildings(data: dict) -> list[dict]:
    nodes = {n["id"]: (n["lat"], n["lon"]) for n in data["elements"] if n["type"] == "node"}
    rng = random.Random(42)
    out = []
    for w in data["elements"]:
        if w["type"] != "way" or "building" not in w.get("tags", {}):
            continue
        pts = [project(*nodes[n]) for n in w["nodes"] if n in nodes]
        if len(pts) < 4:
            continue
        pts = pts[:-1]  # closed ring
        tags = w["tags"]
        height = None
        try:
            height = float(str(tags.get("height", "")).replace("m", "").strip())
        except ValueError:
            pass
        if not height and tags.get("building:levels"):
            try:
                height = float(tags["building:levels"]) * 3.2
            except ValueError:
                pass
        estimated = height is None
        if estimated:
            # Centro de Medellín: mostly 2–5 storeys, with taller towers near the core.
            x, z = pts[0]
            core = max(0.0, 1 - math.hypot(x, z) / 1400)
            height = 6 + rng.random() * 10 + (rng.random() ** 3) * 55 * core
        area = abs(sum(pts[i][0] * pts[i - 1][1] - pts[i - 1][0] * pts[i][1] for i in range(len(pts)))) / 2
        if area < 25:
            continue
        out.append({"p": [[round(x), round(z)] for x, z in pts], "h": round(height, 1), "est": estimated})
    return out


def seg_dist(px: float, pz: float, a: list[float], b: list[float]) -> tuple[float, float]:
    """Distance from point to segment ab, plus the segment heading."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dz * dz or 1e-9
    t = max(0.0, min(1.0, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2))
    return math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz), math.atan2(dz, dx)


def fill_blocks(graph: dict, osm_buildings: list[dict], half_w: float, half_h: float) -> list[dict]:
    """OSM only maps part of Centro's buildings. Fill the remaining city blocks with
    procedural footprints aligned to the nearest street (flag est="proc")."""
    cell = 40.0
    segs = defaultdict(list)
    for e in graph["edges"]:
        for a, b in zip(e["pts"], e["pts"][1:]):
            for cx in range(int((min(a[0], b[0]) - 30) // cell), int((max(a[0], b[0]) + 30) // cell) + 1):
                for cz in range(int((min(a[1], b[1]) - 30) // cell), int((max(a[1], b[1]) + 30) // cell) + 1):
                    segs[(cx, cz)].append((a, b, e["cls"]))
    taken = defaultdict(list)
    for bld in osm_buildings:
        xs = [p[0] for p in bld["p"]]; zs = [p[1] for p in bld["p"]]
        r = max(max(xs) - min(xs), max(zs) - min(zs)) / 2
        c = (sum(xs) / len(xs), sum(zs) / len(zs), r)
        taken[(int(c[0] // cell), int(c[1] // cell))].append(c)

    rng = random.Random(7)
    out = []
    step = 19.0
    z = -half_h
    while z < half_h:
        x = -half_w
        while x < half_w:
            px, pz = x + rng.uniform(-3, 3), z + rng.uniform(-3, 3)
            key = (int(px // cell), int(pz // cell))
            near = [s for dx in (-1, 0, 1) for dz in (-1, 0, 1) for s in segs.get((key[0] + dx, key[1] + dz), [])]
            best, heading, cls = 1e9, 0.0, "local"
            for a, b, c in near:
                d, h = seg_dist(px, pz, a, b)
                if d < best:
                    best, heading, cls = d, h, c
            setback = {"arterial": 17, "collector": 13, "local": 10}[cls]
            w, dpt = rng.uniform(11, 17), rng.uniform(11, 17)
            clear = all(math.hypot(px - c[0], pz - c[1]) > c[2] + 8
                        for dx in (-1, 0, 1) for dz in (-1, 0, 1) for c in taken.get((key[0] + dx, key[1] + dz), []))
            if setback + 1 < best < 55 and clear:
                ca, sa = math.cos(heading), math.sin(heading)
                corners = [(-w / 2, -dpt / 2), (w / 2, -dpt / 2), (w / 2, dpt / 2), (-w / 2, dpt / 2)]
                pts = [[round(px + u * ca - v * sa), round(pz + u * sa + v * ca)] for u, v in corners]
                core = max(0.0, 1 - math.hypot(px, pz) / 1500)
                h = 7 + rng.random() * 11 + (rng.random() ** 4) * 70 * core
                out.append({"p": pts, "h": round(h, 1), "est": "proc"})
                taken[key].append((px, pz, max(w, dpt) / 2))
            x += step
        z += step
    return out


def build_pois(data: dict) -> list[dict]:
    kinds = {"hospital": "hospital", "fire_station": "fire", "police": "police"}
    out = []
    for el in data["elements"]:
        tags = el.get("tags", {})
        kind = kinds.get(tags.get("amenity", "")) or ("substation" if tags.get("power") == "substation" else None)
        if not kind:
            continue
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None:
            continue
        x, z = project(lat, lon)
        out.append({"kind": kind, "name": tags.get("name", kind.title()), "x": x, "z": z})
    return out


def main() -> None:
    b = bbox_str()
    roads = overpass("roads", f"""[out:json][timeout:120];
      way["highway"~"^({'|'.join(ROAD_CLASSES)})$"]({b}); (._;>;); out body;""")
    buildings = overpass("buildings", f"""[out:json][timeout:120];
      way["building"]({b}); (._;>;); out body;""")
    pois = overpass("pois", f"""[out:json][timeout:120];
      (nwr["amenity"~"^(hospital|fire_station|police)$"]({b});
       nwr["power"="substation"]({b}););
      out center tags;""")

    graph = build_roads(roads)
    blds = build_buildings(buildings)
    places = build_pois(pois)
    half_w = (BBOX[3] - BBOX[1]) / 2 * M_PER_DEG_LON
    half_h = (BBOX[2] - BBOX[0]) / 2 * M_PER_DEG_LAT
    procedural = fill_blocks(graph, blds, half_w, half_h)
    print(f"osm buildings={len(blds)} procedural={len(procedural)}")
    blds += procedural
    dataset = {
        "meta": {
            "city": "Medellín", "area": "Centro · La Candelaria", "country": "Colombia",
            "center": {"lat": LAT0, "lon": LON0}, "bbox": BBOX,
            "extent": {"halfWidth": round(half_w), "halfHeight": round(half_h)},
            "source": "© OpenStreetMap contributors (ODbL) via Overpass API",
            "notes": "Roads, POIs and buildings with est=false/true come from OSM (est=true: height estimated). "
                     "Buildings with est='proc' are procedurally generated to fill unmapped blocks.",
        },
        "roads": graph,
        "buildings": blds,
        "pois": places,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(dataset, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"nodes={len(graph['nodes'])} edges={len(graph['edges'])} buildings={len(blds)} pois={len(places)}")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    sys.exit(main())
