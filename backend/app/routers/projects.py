from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..events import bus
from ..models import ExperimentRun, Project, ProjectMember, Scenario, User
from ..schemas import MemberIn, MemberOut, ProjectIn, ProjectOut, ProjectPatch, ScenarioIn, ScenarioOut
from ..security import current_user, require_role

router = APIRouter(prefix="/api", tags=["projects"])


def _project_out(db: Session, p: Project, role: str) -> ProjectOut:
    out = ProjectOut.model_validate(p)
    out.role = role  # type: ignore[assignment]
    out.scenario_count = db.query(func.count(Scenario.id)).filter_by(project_id=p.id).scalar() or 0
    out.run_count = db.query(func.count(ExperimentRun.id)).filter_by(project_id=p.id).scalar() or 0
    return out


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = (db.query(Project, ProjectMember.role).join(ProjectMember, ProjectMember.project_id == Project.id)
            .filter(ProjectMember.user_id == user.id).order_by(Project.created_at.desc()).all())
    return [_project_out(db, p, role) for p, role in rows]


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(body: ProjectIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = Project(name=body.name, description=body.description, owner_id=user.id)
    db.add(p)
    db.flush()
    db.add(ProjectMember(project_id=p.id, user_id=user.id, role="owner"))
    db.commit()
    return _project_out(db, p, "owner")


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = require_role(db, project_id, user, "viewer")
    role = db.query(ProjectMember.role).filter_by(project_id=p.id, user_id=user.id).scalar()
    return _project_out(db, p, role)


@router.patch("/projects/{project_id}", response_model=ProjectOut)
def update_project(project_id: int, body: ProjectPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = require_role(db, project_id, user, "editor")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(p, k, v)
    db.commit()
    return get_project(project_id, user, db)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = require_role(db, project_id, user, "owner")
    db.delete(p)
    db.commit()
    return Response(status_code=204)


# ───────────── members (collaboration)
@router.get("/projects/{project_id}/members", response_model=list[MemberOut])
def list_members(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user, "viewer")
    return [{"user": m.user, "role": m.role} for m in db.query(ProjectMember).filter_by(project_id=project_id)]


@router.post("/projects/{project_id}/members", response_model=MemberOut, status_code=201)
async def add_member(project_id: int, body: MemberIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user, "owner")
    invitee = db.query(User).filter_by(email=body.email.lower()).first()
    if not invitee:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No SYNAPSE account with that email")
    m = db.query(ProjectMember).filter_by(project_id=project_id, user_id=invitee.id).first()
    if m and m.role == "owner":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot change the owner's role")
    if m:
        m.role = body.role
    else:
        m = ProjectMember(project_id=project_id, user_id=invitee.id, role=body.role)
        db.add(m)
    db.commit()
    await bus.publish(project_id, {"type": "member_added", "user": invitee.name, "role": body.role, "by": user.name})
    return {"user": invitee, "role": m.role}


@router.delete("/projects/{project_id}/members/{user_id}", status_code=204)
def remove_member(project_id: int, user_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user, "owner" if user_id != user.id else "viewer")
    m = db.query(ProjectMember).filter_by(project_id=project_id, user_id=user_id).first()
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a member")
    if m.role == "owner":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The owner cannot be removed")
    db.delete(m)
    db.commit()
    return Response(status_code=204)


# ───────────── scenarios
@router.get("/projects/{project_id}/scenarios", response_model=list[ScenarioOut])
def list_scenarios(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user, "viewer")
    return db.query(Scenario).filter_by(project_id=project_id).order_by(Scenario.updated_at.desc()).all()


@router.post("/projects/{project_id}/scenarios", response_model=ScenarioOut, status_code=201)
async def create_scenario(project_id: int, body: ScenarioIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user, "editor")
    s = Scenario(project_id=project_id, created_by=user.id, **body.model_dump(mode="json"))
    db.add(s)
    db.commit()
    await bus.publish(project_id, {"type": "scenario_saved", "id": s.id, "name": s.name, "by": user.name})
    return s


def _scenario(db: Session, scenario_id: int, user: User, role: str) -> Scenario:
    s = db.get(Scenario, scenario_id)
    if not s:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Scenario not found")
    require_role(db, s.project_id, user, role)
    return s


@router.get("/scenarios/{scenario_id}", response_model=ScenarioOut)
def get_scenario(scenario_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _scenario(db, scenario_id, user, "viewer")


@router.put("/scenarios/{scenario_id}", response_model=ScenarioOut)
async def update_scenario(scenario_id: int, body: ScenarioIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = _scenario(db, scenario_id, user, "editor")
    for k, v in body.model_dump(mode="json").items():
        setattr(s, k, v)
    s.version += 1
    db.commit()
    await bus.publish(s.project_id, {"type": "scenario_saved", "id": s.id, "name": s.name, "version": s.version, "by": user.name})
    return s


@router.delete("/scenarios/{scenario_id}", status_code=204)
def delete_scenario(scenario_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = _scenario(db, scenario_id, user, "editor")
    db.delete(s)
    db.commit()
    return Response(status_code=204)
