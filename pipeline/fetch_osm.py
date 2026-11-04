"""
SYNAPSE data pipeline — builds the digital-twin datasets from OpenStreetMap.

Downloads roads, buildings, critical infrastructure and rail transit for a
bounded downtown area of each city through the public Overpass API and converts
them into a compact JSON file consumed by the simulation engine:

  * a simplified, directed road graph (intersections + polyline edges)
  * building footprints with estimated heights
  * points of interest: hospitals, fire stations, police, power substations
  * rail transit lines (metro, light rail, tram) with stations and elevation

Coordinates are projected to a local metric plane (x = east, z = south) centred
on the bounding box, so the frontend can work directly in meters.

Usage:  py pipeline/fetch_osm.py [medellin|bogota|newyork|all]
Output: frontend/public/data/<city>.json   (© OpenStreetMap contributors, ODbL)
"""
from __future__ import annotations

import json
import math
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

CITIES = {
    # bbox: south, west, north, east · tall: height range (m) of untagged towers near the core
    "medellin": {"bbox": (6.236, -75.580, 6.264, -75.558), "city": "Medellín", "area": "Centro · La Candelaria",
                 "country": "Colombia", "cache": "", "tall": 55},
    "bogota": {"bbox": (4.590, -74.087, 4.618, -74.063), "city": "Bogotá", "area": "Centro · La Candelaria · Santa Fe",
               "country": "Colombia", "cache": "bogota-", "tall": 45},
    "newyork": {"bbox": (40.702, -74.019, 40.724, -73.993), "city": "New York", "area": "Lower Manhattan",
                "country": "United States", "cache": "newyork-", "tall": 120},
}
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "pipeline" / ".cache"
OUT_DIR = ROOT / "frontend" / "public" / "data"
MAX_BUILDINGS = 12_000

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

M_PER_DEG_LAT = 110_574.0
CITY = "medellin"
BBOX = CITIES[CITY]["bbox"]
LAT0 = LON0 = M_PER_DEG_LON = 0.0


def configure(city: str) -> None:
    global CITY, BBOX, LAT0, LON0, M_PER_DEG_LON
    CITY = city
    BBOX = CITIES[city]["bbox"]
    LAT0 = (BBOX[0] + BBOX[2]) / 2
    LON0 = (BBOX[1] + BBOX[3]) / 2
    M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))


configure(CITY)


def project(lat: float, lon: float) -> tuple[float, float]:
    """WGS84 -> local plane in meters (x east, z south — Three.js convention)."""
    return round((lon - LON0) * M_PER_DEG_LON, 1), round(-(lat - LAT0) * M_PER_DEG_LAT, 1)


def overpass(name: str, query: str) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"{CITIES[CITY]['cache']}{name}.json"
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
            raw_speed = str(tags.get("maxspeed", speed))
            speed = int(raw_speed.split()[0])
            if "mph" in raw_speed:  # e.g. New York: "25 mph"
                speed = round(speed * 1.609)
        except ValueError:
            pass
        oneway = tags.get("oneway") in ("yes", "1", "true") or tags.get("junction") == "roundabout" \
            or tags["highway"] in ("motorway", "motorway_link")
        reverse = tags.get("oneway") == "-1"
        ids = [n for n in w["nodes"] if n in nodes]
        if len(ids) < 2:
            continue
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
    tall = CITIES[CITY]["tall"]
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
            # downtown: mostly low/mid-rise, with taller towers near the core
            x, z = pts[0]
            core = max(0.0, 1 - math.hypot(x, z) / 1400)
            height = 6 + rng.random() * 10 + (rng.random() ** 3) * tall * core
        area = abs(sum(pts[i][0] * pts[i - 1][1] - pts[i - 1][0] * pts[i][1] for i in range(len(pts)))) / 2
        if area < 25:
            continue
        out.append({"p": [[round(x), round(z)] for x, z in pts], "h": round(min(height, 450), 1), "est": estimated})
    return out


def seg_dist(px: float, pz: float, a: list[float], b: list[float]) -> tuple[float, float]:
    """Distance from point to segment ab, plus the segment heading."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dz * dz or 1e-9
    t = max(0.0, min(1.0, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2))
    return math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz), math.atan2(dz, dx)


def fill_blocks(graph: dict, osm_buildings: list[dict], half_w: float, half_h: float) -> list[dict]:
    """OSM only maps part of some downtowns' buildings. Fill the remaining city blocks with
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


# ───────────────────────────── rail transit
RAIL_MODES = {"subway": "metro", "light_rail": "metro", "train": "rail", "monorail": "metro", "tram": "tram"}
DEFAULT_COLOURS = {"metro": "#22d3ee", "rail": "#a78bfa", "tram": "#34d399"}
# lines without an OSM colour get distinct (non-official) colours so they stay distinguishable
FALLBACK_PALETTE = ["#e879f9", "#f59e0b", "#a3e635", "#fb7185", "#38bdf8", "#34d399"]


def _stitch(ways: list[list[tuple[float, float, int]]]) -> list[tuple[float, float, int]]:
    """Chain member ways (each a list of (lat, lon, elevation)) into one ordered polyline."""
    line: list[tuple[float, float, int]] = []
    for i, w in enumerate(ways):
        if not w:
            continue
        if not line:
            line = list(w)
            continue
        if i == 1:
            # the first way may be stored backwards: orient it towards the second one
            ends = [(math.dist(line[-1][:2], w[0][:2]), False), (math.dist(line[-1][:2], w[-1][:2]), False),
                    (math.dist(line[0][:2], w[0][:2]), True), (math.dist(line[0][:2], w[-1][:2]), True)]
            if min(ends)[1]:
                line.reverse()
        end = line[-1]
        d_fwd = math.dist(w[0][:2], end[:2])
        d_rev = math.dist(w[-1][:2], end[:2])
        line.extend(w if d_fwd <= d_rev else list(reversed(w)))
    return line


def clean_station(name: str) -> str:
    """'Estación Metro San Antonio. Línea A' -> 'San Antonio', 'hospital metro' -> 'Hospital'."""
    n = re.sub(r"[.,]?\s*(L[ií]nea|Line)\s+\S+$", "", name.strip(), flags=re.I)
    for _ in range(3):
        n = re.sub(r"^(Estaci[oó]n|Station|de|del|Metro|Tranv[ií]a|Subway)\s+", "", n, flags=re.I)
        n = re.sub(r"\s+(Metro|Station|Estaci[oó]n|Subway)$", "", n, flags=re.I)
    n = n.strip(" .-")
    return n[:1].upper() + n[1:] if n else name


def _is_rail_stop(tags: dict) -> bool:
    """Bus terminals are often tagged public_transport=station too: keep rail stops only."""
    if tags.get("railway") in ("station", "halt", "tram_stop", "stop"):
        return True
    if any(tags.get(k) == "yes" for k in ("subway", "train", "light_rail", "tram", "monorail")):
        return True
    return tags.get("station") in ("subway", "light_rail", "train", "tram") or tags.get("public_transport") == "stop_position" and tags.get("bus") != "yes"


def _elevation(tags: dict) -> int:
    layer = str(tags.get("layer", "0"))
    if tags.get("tunnel") in ("yes", "building_passage") or layer.startswith("-"):
        return -1
    if tags.get("bridge") or (layer.isdigit() and int(layer) > 0):
        return 1
    return 0


def build_transit(rel_data: dict, way_tags: dict, station_data: dict, half_w: float, half_h: float) -> dict:
    margin = 150
    best: dict[str, dict] = {}
    for rel in rel_data.get("elements", []):
        if rel.get("type") != "relation":
            continue
        tags = rel.get("tags", {})
        mode = RAIL_MODES.get(tags.get("route", ""))
        if not mode:
            continue
        ways = []
        building = False  # any track still under construction or only proposed → line not in service
        for m in rel.get("members", []):
            if m.get("type") != "way" or str(m.get("role", "")).startswith("platform") or not m.get("geometry"):
                continue
            wt = way_tags.get(m["ref"], {})
            building = building or wt.get("railway") in ("construction", "proposed") or "construction" in wt
            elev = _elevation(wt)
            if mode == "tram" and elev > 0:
                elev = 0  # street-running trams: layer tags refer to short bridges, not a viaduct
            ways.append([(g["lat"], g["lon"], elev) for g in m["geometry"] if g])
        pts = [(*project(lat, lon), e) for lat, lon, e in _stitch(ways)]
        # longest contiguous run inside the twin's extent
        runs, cur = [], []
        for p in pts:
            if abs(p[0]) <= half_w + margin and abs(p[1]) <= half_h + margin:
                cur.append(p)
            elif cur:
                runs.append(cur)
                cur = []
        if cur:
            runs.append(cur)
        if not runs:
            continue
        length_of = lambda r: sum(math.dist(r[i][:2], r[i + 1][:2]) for i in range(len(r) - 1))
        run = max(runs, key=length_of)
        simple = [run[0]]
        for p in run[1:]:
            if math.dist(p[:2], simple[-1][:2]) >= 6:
                simple.append(p)
        length = length_of(simple)
        if length < 300:
            continue
        ref = tags.get("ref") or tags.get("name", "?")
        key = f"{mode}:{ref}"
        if key in best and best[key]["len"] >= length:
            continue
        colour = tags.get("colour") or tags.get("color") or ""  # hex or CSS colour name
        best[key] = {"id": key, "ref": ref, "name": tags.get("name", ref), "mode": mode, "colour": colour,
                     "status": "construction" if building else "open",
                     "pts": [[round(x, 1), round(z, 1), e] for x, z, e in simple], "len": round(length, 1), "stations": []}

    lines = list(best.values())
    # stations: snap each named station node to every line passing within 90 m
    for el in station_data.get("elements", []):
        name = el.get("tags", {}).get("name")
        if not name or "lat" not in el:
            continue
        x, z = project(el["lat"], el["lon"])
        for ln in lines:
            pts = ln["pts"]
            acc, best_d, best_s = 0.0, 1e9, 0.0
            for i in range(len(pts) - 1):
                a, b = pts[i], pts[i + 1]
                seg = math.dist(a[:2], b[:2]) or 1e-9
                t = max(0.0, min(1.0, ((x - a[0]) * (b[0] - a[0]) + (z - a[1]) * (b[1] - a[1])) / seg ** 2))
                d = math.hypot(a[0] + t * (b[0] - a[0]) - x, a[1] + t * (b[1] - a[1]) - z)
                if d < best_d:
                    best_d, best_s = d, acc + t * seg
                acc += seg
            name = clean_station(name)
            if best_d < 90 and all(s["name"] != name for s in ln["stations"]):
                ln["stations"].append({"name": name, "s": round(best_s, 1)})
    for ln in lines:
        ln["stations"].sort(key=lambda s: s["s"])
        merged = []  # separate platform nodes of one station
        for st in ln["stations"]:
            if merged and st["s"] - merged[-1]["s"] < 120:
                if len(st["name"]) < len(merged[-1]["name"]):  # prefer the cleaner (shorter) name
                    merged[-1] = {**merged[-1], "name": st["name"]}
                continue
            merged.append(st)
        ln["stations"] = merged
    lines = [ln for ln in lines if len(ln["stations"]) >= 2]
    for i, ln in enumerate(sorted(lines, key=lambda l: (l["mode"], l["ref"]))):
        ln["colour"] = ln["colour"] or FALLBACK_PALETTE[i % len(FALLBACK_PALETTE)]
    return {"lines": sorted(lines, key=lambda l: (l["mode"], l["ref"]))}


def build_city() -> None:
    b = bbox_str()
    roads = overpass("roads", f"""[out:json][timeout:120];
      way["highway"~"^({'|'.join(ROAD_CLASSES)})$"]({b}); (._;>;); out body;""")
    buildings = overpass("buildings", f"""[out:json][timeout:180];
      way["building"]({b}); (._;>;); out body;""")
    pois = overpass("pois", f"""[out:json][timeout:120];
      (nwr["amenity"~"^(hospital|fire_station|police)$"]({b});
       nwr["power"="substation"]({b}););
      out center tags;""")
    rail = "^(subway|light_rail|tram|train|monorail)$"
    transit_rel = overpass("transit", f"""[out:json][timeout:180];
      relation["route"~"{rail}"]({b}); out geom;""")
    transit_ways = overpass("transit-ways", f"""[out:json][timeout:180];
      relation["route"~"{rail}"]({b}); way(r); out tags;""")
    # stations are mapped in several ways: station nodes, stop positions of the routes, named platforms
    stations = overpass("stations", f"""[out:json][timeout:120];
      (nwr["railway"~"^(station|halt|tram_stop)$"]({b}); nwr["public_transport"="station"]({b}););
      out center tags;""")
    stops = overpass("transit-stops", f"""[out:json][timeout:180];
      relation["route"~"{rail}"]({b})->.r;
      (node(r.r)["name"]; way(r.r)["public_transport"="platform"]["name"]; relation(r.r)["public_transport"="platform"]["name"];);
      out center tags;""")

    graph = build_roads(roads)
    blds = build_buildings(buildings)
    places = build_pois(pois)
    half_w = (BBOX[3] - BBOX[1]) / 2 * M_PER_DEG_LON
    half_h = (BBOX[2] - BBOX[0]) / 2 * M_PER_DEG_LAT
    procedural = fill_blocks(graph, blds, half_w, half_h) if len(blds) < MAX_BUILDINGS * 0.6 else []
    print(f"osm buildings={len(blds)} procedural={len(procedural)}")
    blds += procedural
    if len(blds) > MAX_BUILDINGS:  # rendering budget: keep the largest footprints
        area = lambda b: abs(sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(b["p"], b["p"][1:] + b["p"][:1])))
        blds = sorted(blds, key=lambda b: -area(b))[:MAX_BUILDINGS]
    way_tags = {w["id"]: w.get("tags", {}) for w in transit_ways.get("elements", []) if w.get("type") == "way"}
    station_points = {"elements": [
        {"tags": el.get("tags", {}), "lat": el.get("lat", el.get("center", {}).get("lat")), "lon": el.get("lon", el.get("center", {}).get("lon"))}
        for el in stations.get("elements", []) + stops.get("elements", [])
        if (el.get("lat") is not None or el.get("center")) and _is_rail_stop(el.get("tags", {}))
    ]}
    transit = build_transit(transit_rel, way_tags, station_points, half_w, half_h)
    dataset = {
        "meta": {
            "id": CITY, "city": CITIES[CITY]["city"], "area": CITIES[CITY]["area"], "country": CITIES[CITY]["country"],
            "center": {"lat": LAT0, "lon": LON0}, "bbox": BBOX,
            "extent": {"halfWidth": round(half_w), "halfHeight": round(half_h)},
            "source": "© OpenStreetMap contributors (ODbL) via Overpass API",
            "notes": "Roads, POIs, rail lines and buildings with est=false/true come from OSM (est=true: height estimated). "
                     "Buildings with est='proc' are procedurally generated to fill unmapped blocks.",
        },
        "roads": graph,
        "buildings": blds,
        "pois": places,
        "transit": transit,
    }
    out = OUT_DIR / f"{CITY}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(dataset, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"nodes={len(graph['nodes'])} edges={len(graph['edges'])} buildings={len(blds)} pois={len(places)}")
    for ln in transit["lines"]:
        elev = sorted({p[2] for p in ln["pts"]})
        print(f"  {ln['mode']:5} {ln['ref']:>6} {ln['name'][:42]:42} {ln['len']:6.0f} m  {len(ln['stations']):2} st  elev={elev} {ln['colour']}")
    print(f"wrote {out} ({out.stat().st_size / 1e6:.2f} MB)")


def main() -> None:
    arg = sys.argv[1] if len(sys.argv) > 1 else "medellin"
    for city in (list(CITIES) if arg == "all" else [arg]):
        configure(city)
        print(f"== {city}", flush=True)
        build_city()


if __name__ == "__main__":
    sys.exit(main())
