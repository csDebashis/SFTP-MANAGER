"""Contract tests for the import-ready Vercel demonstration deployment."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def test_vercel_services_route_api_before_frontend() -> None:
    config = json.loads((REPOSITORY_ROOT / "vercel.json").read_text(encoding="utf-8"))

    assert config["services"]["frontend"] == {"root": "frontend/", "framework": "nextjs"}
    assert config["services"]["backend"] == {
        "root": "backend/",
        "framework": "fastapi",
        "entrypoint": "app.main:app",
    }
    assert config["rewrites"] == [
        {"source": "/api/(.*)", "destination": {"service": "backend"}},
        {"source": "/(.*)", "destination": {"service": "frontend"}},
    ]


def test_vercel_runtime_uses_tmp_storage_and_secure_demo_sessions(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("VERCEL_TMP_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("MOCK_SFTP_ROOT", raising=False)
    monkeypatch.delenv("APP_LOG_DIR", raising=False)
    monkeypatch.delenv("COOKIE_SECURE", raising=False)
    monkeypatch.delenv("SEED_DEMO_USERS", raising=False)

    app = create_app()

    assert app.state.vercel_demo is True
    assert app.state.seed_demo is True
    assert app.state.database.url == f"sqlite+aiosqlite:///{tmp_path / 'sftp-manager' / 'sftp-manager.db'}"
    assert app.state.gateway.mock_root == (tmp_path / "sftp-manager" / "mock-sftp").resolve()

    with TestClient(app) as client:
        assert client.get("/api/v1/health/ready").json() == {"status": "ready"}
        response = client.post(
            "/api/v1/auth/login",
            json={"email": "admin@gmail.com", "password": "Admin123!Secure"},
        )

    assert response.status_code == 200
    assert "Secure" in response.headers["set-cookie"]
    assert (tmp_path / "sftp-manager" / "logs" / "application.log").is_file()
