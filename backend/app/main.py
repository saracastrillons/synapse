"""SYNAPSE API — accounts, projects, persisted scenarios & experiments, sharing,
geospatial queries and real-time collaboration for the digital twin."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from . import copilot, geo
from .config import settings
from .db import Base, SessionLocal, engine, get_db, is_postgres
from .events import bus
from .models import ProjectMember
from .routers import auth, geo as geo_router, projects, runs, share
from .security import user_from_token

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    if is_postgres():
        with engine.begin() as c:
            c.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        geo.seed(db)
    await bus.start()
    yield
    await bus.stop()


app = FastAPI(
    title="SYNAPSE API",
    version="0.2.0",
    description="Backend of SYNAPSE — The Living Digital Twin of Earth.",
    lifespan=lifespan,
)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

for r in (auth.router, projects.router, runs.router, share.router, geo_router.router, copilot.router):
    app.include_router(r)


@app.get("/api/health", tags=["ops"])
def health(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"status": "ok", "database": engine.dialect.name, "events": bus.backend, **geo.capabilities(),
            "copilot": {"enabled": bool(copilot.api_key()), "model": copilot.model_name()}}


@app.websocket("/api/ws/projects/{project_id}")
async def project_socket(ws: WebSocket, project_id: int):
    """Live channel for a project: presence plus scenario/run/comment events.
    The client authenticates with its first message ({"type": "auth", "token": …}) so the
    JWT never appears in URLs or access logs."""
    await ws.accept()
    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=5)
    except Exception:
        await ws.close(code=4401)
        return
    token = hello.get("token") if isinstance(hello, dict) and hello.get("type") == "auth" else None
    with SessionLocal() as db:
        user = user_from_token(str(token), db) if token else None
        member = user and db.query(ProjectMember).filter_by(project_id=project_id, user_id=user.id).first()
    if not user or not member:
        await ws.close(code=4403)
        return
    await bus.join(project_id, ws, {"id": user.id, "name": user.name})
    try:
        while True:
            msg = await ws.receive_json()
            # lightweight client events, e.g. "Sara is running an experiment"
            if isinstance(msg, dict) and msg.get("type") == "activity":
                await bus.publish(project_id, {"type": "activity", "by": user.name, "text": str(msg.get("text", ""))[:200]})
    except WebSocketDisconnect:
        pass
    finally:
        await bus.leave(project_id, ws)
