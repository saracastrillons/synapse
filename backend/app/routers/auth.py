import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..schemas import LoginIn, RegisterIn, TokenOut, UserOut
from ..security import create_token, current_user, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Brute-force protection: at most MAX_FAILURES failed logins per (client, email) per window.
WINDOW_S = 300
MAX_FAILURES = 8
_failures: dict[tuple[str, str], deque[float]] = defaultdict(deque)


def _recent_failures(key: tuple[str, str]) -> deque[float]:
    q = _failures[key]
    while q and q[0] < time.monotonic() - WINDOW_S:
        q.popleft()
    return q


@router.post("/register", response_model=TokenOut, status_code=201)
def register(body: RegisterIn, db: Session = Depends(get_db)):
    email = body.email.lower()
    if db.query(User).filter_by(email=email).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
    user = User(email=email, name=body.name.strip(), password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    return {"token": create_token(user), "user": user}


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    key = (request.client.host if request.client else "?", body.email.lower())
    failures = _recent_failures(key)
    if len(failures) >= MAX_FAILURES:
        retry = int(WINDOW_S - (time.monotonic() - failures[0])) + 1
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many failed attempts, try again later", headers={"Retry-After": str(retry)})
    user = db.query(User).filter_by(email=body.email.lower()).first()
    if not user or not verify_password(body.password, user.password_hash):
        failures.append(time.monotonic())
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    _failures.pop(key, None)
    return {"token": create_token(user), "user": user}


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user
