import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import ExperimentRun, Project, Scenario, ShareLink, User
from ..schemas import ShareIn, ShareOut
from ..security import current_user, require_role

router = APIRouter(prefix="/api/share", tags=["sharing"])


def _target(db: Session, kind: str, target_id: int):
    model = Scenario if kind == "scenario" else ExperimentRun
    obj = db.get(model, target_id)
    if not obj:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{kind} not found")
    return obj


@router.post("", response_model=ShareOut, status_code=201)
def create_share(body: ShareIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    obj = _target(db, body.kind, body.id)
    require_role(db, obj.project_id, user, "editor")
    link = ShareLink(
        token=secrets.token_urlsafe(16), kind=body.kind, target_id=body.id, created_by=user.id,
        expires_at=datetime.now(timezone.utc) + timedelta(days=body.expires_days) if body.expires_days else None,
    )
    db.add(link)
    db.commit()
    return {"token": link.token, "kind": link.kind, "target_id": link.target_id, "expires_at": link.expires_at}


@router.get("/{token}")
def open_share(token: str, db: Session = Depends(get_db)):
    """Public, read-only view of a shared scenario or experiment (no account needed)."""
    link = db.query(ShareLink).filter_by(token=token).first()
    expired = False
    if link and link.expires_at:
        exp = link.expires_at if link.expires_at.tzinfo else link.expires_at.replace(tzinfo=timezone.utc)
        expired = exp < datetime.now(timezone.utc)
    if not link or link.revoked or expired:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Link not found or expired")
    obj = _target(db, link.kind, link.target_id)
    link.views += 1
    db.commit()
    project = db.get(Project, obj.project_id)
    if link.kind == "scenario":
        payload = {"name": obj.name, "preset": obj.preset, "params": obj.params, "intervention": obj.intervention, "notes": obj.notes, "version": obj.version}
    else:
        payload = {
            "preset": obj.preset, "label_a": obj.label_a, "label_b": obj.label_b, "duration": obj.duration,
            "params_a": obj.params_a, "params_b": obj.params_b, "stats": obj.stats, "verdict": obj.verdict,
            "replicates": obj.replicates, "created_at": obj.created_at,
        }
    return {"kind": link.kind, "project": project.name if project else None, "views": link.views, "data": payload}


@router.delete("/{token}", status_code=204)
def revoke_share(token: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    link = db.query(ShareLink).filter_by(token=token).first()
    if not link:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Link not found")
    require_role(db, _target(db, link.kind, link.target_id).project_id, user, "editor")
    link.revoked = True
    db.commit()
