"""Runtime configuration, read from environment variables (12-factor style)."""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

try:  # backend/.env (git-ignored) holds local secrets such as GEMINI_API_KEY
    from dotenv import load_dotenv

    load_dotenv(ROOT / "backend" / ".env")
except ImportError:
    pass


def _jwt_secret() -> str:
    """JWT_SECRET from the environment; in development, a random secret persisted to a
    git-ignored file so restarting the API does not sign everybody out."""
    if os.getenv("JWT_SECRET"):
        return os.environ["JWT_SECRET"]
    path = ROOT / "backend" / ".dev_jwt_secret"
    try:
        if path.exists():
            return path.read_text().strip()
        secret = secrets.token_urlsafe(48)
        path.write_text(secret)
        return secret
    except OSError:
        return secrets.token_urlsafe(48)


@dataclass(frozen=True)
class Settings:
    # SQLite keeps local development dependency-free; production uses PostgreSQL + PostGIS.
    database_url: str = os.getenv("DATABASE_URL", f"sqlite:///{ROOT / 'backend' / 'synapse.db'}")
    redis_url: str | None = os.getenv("REDIS_URL") or None
    jwt_secret: str = field(default_factory=_jwt_secret)
    jwt_days: int = int(os.getenv("JWT_DAYS", "7"))
    cors_origins: list[str] = field(default_factory=lambda: [
        o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:5191").split(",") if o.strip()
    ])
    data_path: Path = Path(os.getenv("DATA_PATH", str(ROOT / "frontend" / "public" / "data" / "medellin.json")))
    max_payload_bytes: int = int(os.getenv("MAX_PAYLOAD_BYTES", str(3 * 1024 * 1024)))


settings = Settings()
