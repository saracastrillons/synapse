import pytest

from app import copilot


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


class FakeClient:
    """Stands in for httpx.AsyncClient and records what would be sent to Gemini."""
    sent: list = []
    overloaded: str | None = None
    reply = FakeResponse(200, {"candidates": [{"content": {"role": "model", "parts": [
        {"functionCall": {"name": "get_city_state", "args": {}}, "thoughtSignature": "sig-123"}]}}]})

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json, headers):
        FakeClient.sent.append({"url": url, "json": json, "headers": headers})
        if FakeClient.overloaded and FakeClient.overloaded in url:
            return FakeResponse(503, {"error": {"message": "high demand"}})
        return FakeClient.reply


@pytest.fixture
def fake_llm(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(copilot.httpx, "AsyncClient", FakeClient)
    FakeClient.sent = []
    FakeClient.overloaded = None
    copilot._calls.clear()
    return FakeClient


def test_status_without_key(client, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    s = client.get("/api/copilot/status").json()
    assert s["enabled"] is False and "run_experiment" in s["tools"]
    r = client.post("/api/copilot/step", json={"contents": [{"role": "user", "parts": [{"text": "hi"}]}]})
    assert r.status_code == 503


def test_step_forwards_tools_and_keeps_key_server_side(client, fake_llm):
    r = client.post("/api/copilot/step", json={"contents": [{"role": "user", "parts": [{"text": "How is traffic?"}]}]})
    assert r.status_code == 200, r.text
    parts = r.json()["parts"]
    assert parts[0]["functionCall"]["name"] == "get_city_state"
    assert parts[0]["thoughtSignature"] == "sig-123"  # echoed verbatim for thinking models
    sent = fake_llm.sent[0]
    assert sent["headers"]["x-goog-api-key"] == "test-key"
    assert "test-key" not in r.text
    names = {t["name"] for t in sent["json"]["tools"][0]["functionDeclarations"]}
    assert {"run_experiment", "propose_parameters", "block_road"} <= names
    assert all("parameters" not in t or t["parameters"]["properties"] for t in sent["json"]["tools"][0]["functionDeclarations"])
    assert "Never invent numbers" in sent["json"]["systemInstruction"]["parts"][0]["text"]


def test_provider_error_is_reported(client, fake_llm, monkeypatch):
    monkeypatch.setattr(FakeClient, "reply", FakeResponse(400, {"error": {"message": "API key not valid"}}))
    r = client.post("/api/copilot/step", json={"contents": [{"role": "user", "parts": [{"text": "x"}]}]})
    assert r.status_code == 502 and "API key not valid" in r.json()["detail"]


def test_rate_limit(client, fake_llm, monkeypatch):
    monkeypatch.setattr(copilot, "RATE_MAX", 3)
    body = {"contents": [{"role": "user", "parts": [{"text": "x"}]}]}
    codes = [client.post("/api/copilot/step", json=body).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


def test_rejects_oversized_conversation(client, fake_llm):
    body = {"contents": [{"role": "user", "parts": [{"text": "x" * 500_000}]}]}
    assert client.post("/api/copilot/step", json=body).status_code == 413


def test_falls_back_to_next_model_when_overloaded(client, fake_llm, monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", "primary-model")
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", "backup-model")
    FakeClient.overloaded = "primary-model"
    contents = [{"role": "user", "parts": [{"text": "x"}]}, {"role": "model", "parts": [{"functionCall": {"name": "get_city_state", "args": {}}, "thoughtSignature": "s"}]}]
    r = client.post("/api/copilot/step", json={"contents": contents})
    assert r.status_code == 200 and r.json()["model"] == "backup-model"
    assert [("primary-model" in s["url"], "backup-model" in s["url"]) for s in fake_llm.sent] == [(True, False), (False, True)]
    assert "thoughtSignature" not in str(fake_llm.sent[1]["json"]["contents"])  # signatures are model-specific


def test_does_not_retry_on_bad_key(client, fake_llm, monkeypatch):
    monkeypatch.setattr(FakeClient, "reply", FakeResponse(400, {"error": {"message": "API key not valid"}}))
    client.post("/api/copilot/step", json={"contents": [{"role": "user", "parts": [{"text": "x"}]}]})
    assert len(fake_llm.sent) == 1
