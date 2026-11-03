from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..events import bus
from ..models import Comment, ExperimentRun, Scenario, User
from ..schemas import CommentIn, CommentOut, RunDetail, RunIn, RunOut
from ..security import current_user, require_role
from ..stats import compare

router = APIRouter(prefix="/api", tags=["experiments"])


@router.post("/projects/{project_id}/runs", response_model=RunOut, status_code=201)
async def create_run(project_id: int, body: RunIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if int(request.headers.get("content-length") or 0) > settings.max_payload_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Experiment payload too large")
    require_role(db, project_id, user, "editor")
    if body.scenario_id is not None:
        sc = db.get(Scenario, body.scenario_id)
        if not sc or sc.project_id != project_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Scenario does not belong to this project")
    a = [r.model_dump() for r in body.a]
    b = [r.model_dump() for r in body.b]
    stats, verdict = compare(a, b)  # never trust client-side conclusions
    run = ExperimentRun(
        project_id=project_id, scenario_id=body.scenario_id, preset=body.preset, label_a=body.label_a, label_b=body.label_b,
        duration=body.duration, params_a=body.params_a.model_dump(), params_b=body.params_b.model_dump(),
        replicates={"a": a, "b": b}, stats=stats, verdict=verdict, created_by=user.id,
    )
    db.add(run)
    db.commit()
    await bus.publish(project_id, {"type": "run_saved", "id": run.id, "label": run.label_b, "verdict": verdict, "by": user.name})
    return run


@router.get("/projects/{project_id}/runs", response_model=list[RunOut])
def list_runs(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user, "viewer")
    return db.query(ExperimentRun).filter_by(project_id=project_id).order_by(ExperimentRun.created_at.desc()).all()


def _run(db: Session, run_id: int, user: User, role: str) -> ExperimentRun:
    run = db.get(ExperimentRun, run_id)
    if not run:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Run not found")
    require_role(db, run.project_id, user, role)
    return run


@router.get("/runs/compare")
def compare_runs(a: int = Query(...), b: int = Query(...), user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Compare the intervention arms of two saved experiments (e.g. two versions of a city)."""
    ra, rb = _run(db, a, user, "viewer"), _run(db, b, user, "viewer")
    if [r["seed"] for r in ra.replicates["b"]] != [r["seed"] for r in rb.replicates["b"]]:
        note = "Different seeds: comparison is not paired; interpret with care."
    else:
        note = "Same seeds: paired comparison under identical demand."
    stats, verdict = compare(ra.replicates["b"], rb.replicates["b"])
    return {"a": {"id": ra.id, "label": ra.label_b}, "b": {"id": rb.id, "label": rb.label_b}, "stats": stats, "verdict": verdict, "note": note}


@router.get("/runs/{run_id}", response_model=RunDetail)
def get_run(run_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _run(db, run_id, user, "viewer")


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    run = _run(db, run_id, user, "editor")
    db.delete(run)
    db.commit()
    return Response(status_code=204)


@router.get("/runs/{run_id}/comments", response_model=list[CommentOut])
def list_comments(run_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _run(db, run_id, user, "viewer").comments


@router.post("/runs/{run_id}/comments", response_model=CommentOut, status_code=201)
async def add_comment(run_id: int, body: CommentIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    run = _run(db, run_id, user, "viewer")  # viewers may discuss results
    c = Comment(run_id=run.id, user_id=user.id, text=body.text.strip())
    db.add(c)
    db.commit()
    await bus.publish(run.project_id, {"type": "comment", "run_id": run.id, "text": c.text, "by": user.name})
    return c
