from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


def make_engine(url: str):
    if url.startswith("sqlite"):
        eng = create_engine(url, connect_args={"check_same_thread": False})

        @event.listens_for(eng, "connect")
        def _fk(dbapi_conn, _):  # enforce ON DELETE CASCADE in SQLite
            dbapi_conn.execute("PRAGMA foreign_keys=ON")

        return eng
    return create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=10)


engine = make_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def is_postgres() -> bool:
    return engine.dialect.name == "postgresql"


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
