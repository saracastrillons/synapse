"""Password hashing (PBKDF2-SHA256, stdlib) and JWT bearer authentication."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import Project, ProjectMember, User

ITERATIONS = 310_000  # OWASP 2023 recommendation for PBKDF2-HMAC-SHA256
bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"pbkdf2_sha256${ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt_b64, hash_b64 = stored.split("$")
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt_b64), int(iters))
    return hmac.compare_digest(digest, base64.b64decode(hash_b64))


def create_token(user: User) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=settings.jwt_days)
    return jwt.encode({"sub": str(user.id), "exp": exp}, settings.jwt_secret, algorithm="HS256")


def user_from_token(token: str, db: Session) -> User | None:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    return db.get(User, int(payload["sub"]))


def current_user(creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)) -> User:
    user = user_from_token(creds.credentials, db) if creds else None
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    return user


ROLE_RANK = {"viewer": 0, "editor": 1, "owner": 2}


def require_role(db: Session, project_id: int, user: User, minimum: str) -> Project:
    """Authorisation: the user must be a member with at least `minimum` role.
    Non-members get 404 so project ids cannot be enumerated."""
    project = db.get(Project, project_id)
    member = None
    if project:
        member = db.query(ProjectMember).filter_by(project_id=project_id, user_id=user.id).first()
    if not project or not member:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if ROLE_RANK[member.role] < ROLE_RANK[minimum]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires {minimum} role")
    return project
