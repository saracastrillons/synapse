from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import geo
from ..db import get_db

router = APIRouter(prefix="/api/geo", tags=["geospatial"])

Lat = Annotated[float, Query(ge=-90, le=90)]
Lon = Annotated[float, Query(ge=-180, le=180)]


@router.get("/stats")
def stats(db: Session = Depends(get_db)):
    return geo.network_stats(db)


@router.get("/facilities")
def facilities(lat: Lat, lon: Lon, radius_m: float = Query(1500, gt=0, le=20000),
               kind: Literal["hospital", "fire", "police", "substation"] | None = None, db: Session = Depends(get_db)):
    """Critical facilities within a radius, nearest first (PostGIS ST_DWithin on geography)."""
    return geo.facilities_near(db, lat, lon, radius_m, kind)


@router.get("/nearest-road")
def nearest_road(lat: Lat, lon: Lon, db: Session = Depends(get_db)):
    r = geo.nearest_road(db, lat, lon)
    if not r:
        raise HTTPException(404, "No road within range")
    return r


@router.get("/route")
def route(from_lat: Lat, from_lon: Lon, to_lat: Lat, to_lon: Lon, db: Session = Depends(get_db)):
    """Server-side shortest path (pgRouting when available) — an independent check of the in-browser A*."""
    return geo.route(db, (from_lat, from_lon), (to_lat, to_lon))
