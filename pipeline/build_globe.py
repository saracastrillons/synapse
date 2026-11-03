"""
Builds the holographic globe dataset: land-masked points on a Fibonacci sphere
plus coastline rings, from Natural Earth 1:110m land polygons (public domain).

Usage:  py pipeline/build_globe.py
Output: frontend/public/data/globe.json
"""
from __future__ import annotations

import json
import math
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "pipeline" / ".cache" / "land110.json"
URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson"
OUT = ROOT / "frontend" / "public" / "data" / "globe.json"
SAMPLES = 70_000


def rings(geojson: dict) -> list[list[tuple[float, float]]]:
    out = []
    for f in geojson["features"]:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            out.append([(lon, lat) for lon, lat in poly[0]])
    return out


def inside(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def main() -> None:
    if not SRC.exists():
        SRC.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(URL, SRC)
    land = rings(json.loads(SRC.read_text(encoding="utf-8")))
    boxes = [(min(p[0] for p in r), max(p[0] for p in r), min(p[1] for p in r), max(p[1] for p in r)) for r in land]

    golden = math.pi * (3 - math.sqrt(5))
    points = []
    for i in range(SAMPLES):
        y = 1 - (i / (SAMPLES - 1)) * 2
        lat = math.degrees(math.asin(y))
        lon = math.degrees((golden * i) % (2 * math.pi)) - 180
        for ring, (x0, x1, y0, y1) in zip(land, boxes):
            if x0 <= lon <= x1 and y0 <= lat <= y1 and inside(lon, lat, ring):
                points += [round(lat, 2), round(lon, 2)]
                break

    coast = [[v for lon, lat in r[::2] for v in (round(lat, 2), round(lon, 2))] for r in land if len(r) > 6]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"points": points, "coast": coast, "source": "Natural Earth 1:110m (public domain)"},
                              separators=(",", ":")), encoding="utf-8")
    print(f"land points={len(points) // 2} coast rings={len(coast)} -> {OUT} ({OUT.stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()
