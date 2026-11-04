from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

Role = Literal["owner", "editor", "viewer"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ───────────── auth
class RegisterIn(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=128)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(ORM):
    id: int
    email: str
    name: str


class TokenOut(BaseModel):
    token: str
    user: UserOut


# ───────────── simulation parameters (mirrors frontend/src/sim/types.ts SimParams)
class SimParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seed: int = Field(ge=0, le=2**31 - 1)
    vehicles: int = Field(ge=0, le=5000)
    capacity: float = Field(ge=0.1, le=3)
    smartNav: float = Field(ge=0, le=1)
    signals: Literal["fixed", "adaptive"]
    preemption: bool
    storm: float = Field(ge=0, le=1)
    powerDemand: float = Field(ge=0.1, le=3)
    repairCrews: int = Field(ge=1, le=10)
    ambulances: int = Field(ge=0, le=10)
    incidentRate: float = Field(ge=0, le=120)
    startHour: float = Field(default=7, ge=0, lt=24)
    dynamicDemand: bool = True
    metro: float = Field(default=1, ge=0, le=1)


# ───────────── projects
class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)


class MemberIn(BaseModel):
    email: EmailStr
    role: Literal["editor", "viewer"] = "editor"


class MemberOut(BaseModel):
    user: UserOut
    role: Role


class ProjectOut(ORM):
    id: int
    name: str
    description: str
    owner_id: int
    created_at: datetime
    role: Role | None = None
    scenario_count: int = 0
    run_count: int = 0


# ───────────── scenarios
class ScenarioIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    preset: str = Field(min_length=1, max_length=40)
    params: SimParams
    intervention: dict[str, Any] | None = None
    notes: str = Field(default="", max_length=5000)


class ScenarioOut(ORM):
    id: int
    project_id: int
    name: str
    preset: str
    params: dict[str, Any]
    intervention: dict[str, Any] | None
    notes: str
    version: int
    created_at: datetime
    updated_at: datetime


# ───────────── experiment runs
class Replicate(BaseModel):
    seed: int
    summary: dict[str, float]
    history: list[dict[str, float]] = Field(default_factory=list, max_length=4000)

    @field_validator("summary")
    @classmethod
    def finite(cls, v: dict[str, float]) -> dict[str, float]:
        import math
        return {k: (x if math.isfinite(x) else 0.0) for k, x in v.items()}


class RunIn(BaseModel):
    scenario_id: int | None = None
    preset: str = Field(min_length=1, max_length=40)
    label_a: str = Field(max_length=120)
    label_b: str = Field(max_length=120)
    duration: int = Field(ge=30, le=7200)
    params_a: SimParams
    params_b: SimParams
    a: list[Replicate] = Field(min_length=1, max_length=20)
    b: list[Replicate] = Field(min_length=1, max_length=20)

    @field_validator("b")
    @classmethod
    def same_reps(cls, b: list[Replicate], info) -> list[Replicate]:
        a = info.data.get("a")
        if a is not None and [r.seed for r in a] != [r.seed for r in b]:
            raise ValueError("A and B must use the same seeds (common random numbers)")
        return b


class RunOut(ORM):
    id: int
    project_id: int
    scenario_id: int | None
    preset: str
    label_a: str
    label_b: str
    duration: int
    params_a: dict[str, Any]
    params_b: dict[str, Any]
    stats: list[dict[str, Any]]
    verdict: str
    created_at: datetime


class RunDetail(RunOut):
    replicates: dict[str, Any]


class CommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class CommentOut(ORM):
    id: int
    text: str
    created_at: datetime
    user: UserOut


# ───────────── sharing
class ShareIn(BaseModel):
    kind: Literal["scenario", "run"]
    id: int
    expires_days: int | None = Field(default=None, ge=1, le=365)


class ShareOut(BaseModel):
    token: str
    kind: str
    target_id: int
    expires_at: datetime | None
