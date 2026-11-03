"""Project event bus for real-time collaboration over WebSockets.

In-process fan-out by default; when REDIS_URL is set, events are published to a
Redis channel so every API replica delivers them to its own connected clients.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

from .config import settings

log = logging.getLogger("synapse.events")
CHANNEL = "synapse:events"


class EventBus:
    def __init__(self) -> None:
        self.rooms: dict[int, dict[WebSocket, dict[str, Any]]] = defaultdict(dict)
        self.redis = None
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if not settings.redis_url:
            return
        try:
            from redis import asyncio as aioredis

            self.redis = aioredis.from_url(settings.redis_url, decode_responses=True)
            await self.redis.ping()
            self._task = asyncio.create_task(self._listen())
            log.info("event bus: redis pub/sub")
        except Exception as exc:  # fall back to in-process delivery
            log.warning("redis unavailable (%s); using in-process events", exc)
            self.redis = None

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        if self.redis:
            await self.redis.aclose()

    async def _listen(self) -> None:
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(CHANNEL)
        async for msg in pubsub.listen():
            if msg.get("type") == "message":
                data = json.loads(msg["data"])
                await self._deliver(data["project_id"], data["event"])

    async def join(self, project_id: int, ws: WebSocket, user: dict[str, Any]) -> None:
        self.rooms[project_id][ws] = user
        await self.publish(project_id, {"type": "presence", "users": self.presence(project_id)})

    async def leave(self, project_id: int, ws: WebSocket) -> None:
        self.rooms[project_id].pop(ws, None)
        await self.publish(project_id, {"type": "presence", "users": self.presence(project_id)})

    def presence(self, project_id: int) -> list[dict[str, Any]]:
        seen: dict[int, dict[str, Any]] = {}
        for u in self.rooms[project_id].values():
            seen[u["id"]] = u
        return list(seen.values())

    async def publish(self, project_id: int, event: dict[str, Any]) -> None:
        if self.redis:
            await self.redis.publish(CHANNEL, json.dumps({"project_id": project_id, "event": event}, default=str))
        else:
            await self._deliver(project_id, event)

    async def _deliver(self, project_id: int, event: dict[str, Any]) -> None:
        dead = []
        for ws in list(self.rooms[project_id]):
            try:
                await ws.send_json(event)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.rooms[project_id].pop(ws, None)

    @property
    def backend(self) -> str:
        return "redis" if self.redis else "in-process"


bus = EventBus()
