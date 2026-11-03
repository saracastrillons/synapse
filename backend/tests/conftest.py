import os
import tempfile

import pytest

# isolated database for the whole test session — must be set before importing the app
_tmp = tempfile.mkdtemp(prefix="synapse-test-")
# TEST_DATABASE_URL lets CI run the same suite against PostgreSQL + PostGIS + pgRouting
os.environ["DATABASE_URL"] = os.getenv("TEST_DATABASE_URL") or f"sqlite:///{_tmp}/test.db"
os.environ["JWT_SECRET"] = "test-secret-that-is-long-enough-for-hs256"
os.environ.pop("REDIS_URL", None)

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


_n = 0


@pytest.fixture
def make_user(client):
    def _make(name="Sara"):
        global _n
        _n += 1
        r = client.post("/api/auth/register", json={"email": f"user{_n}@synapse.dev", "name": name, "password": "correct-horse-1"})
        assert r.status_code == 201, r.text
        body = r.json()
        return {"headers": {"Authorization": f"Bearer {body['token']}"}, "token": body["token"], **body["user"]}
    return _make


PARAMS = {
    "seed": 2026, "vehicles": 1300, "capacity": 1, "smartNav": 0.35, "signals": "adaptive", "preemption": True,
    "storm": 0, "powerDemand": 1, "repairCrews": 2, "ambulances": 1, "incidentRate": 4,
}


def summary(speed, congestion, trip=360.0):
    return {"speed": speed, "congestion": congestion, "trip": trip, "throughput": 10000, "co2": 7500, "power": 1, "response": 0, "removed": 0}
