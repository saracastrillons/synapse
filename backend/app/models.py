from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(80))
    password_hash: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    members: Mapped[list[ProjectMember]] = relationship(back_populates="project", cascade="all, delete-orphan")
    scenarios: Mapped[list[Scenario]] = relationship(back_populates="project", cascade="all, delete-orphan")
    runs: Mapped[list[ExperimentRun]] = relationship(back_populates="project", cascade="all, delete-orphan")


class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(10))  # owner | editor | viewer

    project: Mapped[Project] = relationship(back_populates="members")
    user: Mapped[User] = relationship()


class Scenario(Base):
    """A saved, reproducible experiment setup: preset + parameters (incl. seed) + scheduled events."""
    __tablename__ = "scenarios"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    preset: Mapped[str] = mapped_column(String(40))
    params: Mapped[dict[str, Any]] = mapped_column(JSON)
    intervention: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    project: Mapped[Project] = relationship(back_populates="scenarios")


class ExperimentRun(Base):
    """Results of an A/B experiment. Statistics are recomputed server-side from the replicates."""
    __tablename__ = "experiment_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    scenario_id: Mapped[int | None] = mapped_column(ForeignKey("scenarios.id", ondelete="SET NULL"), nullable=True)
    preset: Mapped[str] = mapped_column(String(40))
    label_a: Mapped[str] = mapped_column(String(120))
    label_b: Mapped[str] = mapped_column(String(120))
    duration: Mapped[int] = mapped_column(Integer)
    params_a: Mapped[dict[str, Any]] = mapped_column(JSON)
    params_b: Mapped[dict[str, Any]] = mapped_column(JSON)
    replicates: Mapped[dict[str, Any]] = mapped_column(JSON)  # {"a": [...], "b": [...]}: seed, summary, history
    stats: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    verdict: Mapped[str] = mapped_column(String(10))  # A | B | tie
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    project: Mapped[Project] = relationship(back_populates="runs")
    comments: Mapped[list[Comment]] = relationship(back_populates="run", cascade="all, delete-orphan", order_by="Comment.id")


class Comment(Base):
    __tablename__ = "comments"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("experiment_runs.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    run: Mapped[ExperimentRun] = relationship(back_populates="comments")
    user: Mapped[User] = relationship()


class ShareLink(Base):
    __tablename__ = "share_links"
    id: Mapped[int] = mapped_column(primary_key=True)
    token: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(10))  # scenario | run
    target_id: Mapped[int] = mapped_column(Integer)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    views: Mapped[int] = mapped_column(Integer, default=0)


# ───────────────────────────── geospatial layer (seeded from the OSM pipeline)
# Geometry is kept as WKT (portable); on PostgreSQL the seeder adds PostGIS `geom`
# columns with GiST indexes and pgRouting-compatible source/target/cost columns.

class RoadSegment(Base):
    __tablename__ = "road_segments"
    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[int] = mapped_column(Integer, index=True)
    target: Mapped[int] = mapped_column(Integer, index=True)
    name: Mapped[str] = mapped_column(String(160), default="")
    cls: Mapped[str] = mapped_column(String(12))
    lanes: Mapped[int] = mapped_column(Integer)
    speed_kmh: Mapped[float] = mapped_column(Float)
    oneway: Mapped[bool] = mapped_column(Boolean)
    length_m: Mapped[float] = mapped_column(Float)
    cost: Mapped[float] = mapped_column(Float)  # free-flow seconds
    reverse_cost: Mapped[float] = mapped_column(Float)  # -1 when one-way (pgRouting convention)
    min_lat: Mapped[float] = mapped_column(Float)
    min_lon: Mapped[float] = mapped_column(Float)
    max_lat: Mapped[float] = mapped_column(Float)
    max_lon: Mapped[float] = mapped_column(Float)
    wkt: Mapped[str] = mapped_column(Text)


class Facility(Base):
    __tablename__ = "facilities"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), index=True)
    name: Mapped[str] = mapped_column(String(160))
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
