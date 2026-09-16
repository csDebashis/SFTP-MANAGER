"""Contract tests for the import-ready Vercel demonstration deployment."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.main import _is_vercel_runtime, create_app
from app.sftp.blob_storage import VercelBlobMockStorage


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def test_vercel_services_route_api_before_frontend() -> None:
    config_path = REPOSITORY_ROOT / "vercel.json"
    if not config_path.is_file():
        pytest.skip("root vercel.json is outside the isolated backend image build context")
    config = json.loads(config_path.read_text(encoding="utf-8"))

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


def test_vercel_runtime_uses_durable_blob_files_and_secure_demo_sessions(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("VERCEL_TMP_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("MOCK_SFTP_ROOT", raising=False)
    monkeypatch.delenv("APP_LOG_DIR", raising=False)
    monkeypatch.delenv("COOKIE_SECURE", raising=False)
    monkeypatch.delenv("SEED_DEMO_USERS", raising=False)
    monkeypatch.delenv("DEPLOYMENT_MODE", raising=False)
    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test-token")
    monkeypatch.setattr(VercelBlobMockStorage, "seed", AsyncMock())

    app = create_app()

    assert app.state.vercel_demo is True
    assert app.state.durable_database is False
    assert app.state.seed_demo is True
    assert app.state.durable_mock_files is True
    assert app.state.database.url == f"sqlite+aiosqlite:///{tmp_path / 'sftp-manager' / 'sftp-manager.db'}"
    assert app.state.gateway.mock_root == (tmp_path / "sftp-manager" / "mock-sftp").resolve()
    assert app.state.gateway.mock_storage_type == "vercel-blob"

    with TestClient(app) as client:
        assert client.get("/api/v1/health/ready").json() == {"status": "ready"}
        response = client.post(
            "/api/v1/auth/login",
            json={"email": "admin@example.com", "password": "Admin123!Secure"},
        )

    assert response.status_code == 200
    assert "Secure" in response.headers["set-cookie"]
    assert (tmp_path / "sftp-manager" / "logs" / "application.log").is_file()


def test_read_only_serverless_runtime_uses_tmp_without_vercel_environment(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("VERCEL_TMP_DIR", str(tmp_path))
    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///./data/sftp-manager.db")
    monkeypatch.setenv("MOCK_SFTP_ROOT", "./data/mock-sftp")
    monkeypatch.setenv("APP_LOG_DIR", "./logs")
    monkeypatch.setenv("SEED_DEMO_USERS", "false")
    monkeypatch.delenv("DEPLOYMENT_MODE", raising=False)
    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test-token")
    monkeypatch.setattr(VercelBlobMockStorage, "seed", AsyncMock())
    monkeypatch.setenv("BOOTSTRAP_ADMIN_EMAIL", "admin@example.com")
    monkeypatch.delenv("BOOTSTRAP_ADMIN_PASSWORD_FILE", raising=False)
    monkeypatch.setattr("app.main.os.access", lambda *_args: False)

    assert _is_vercel_runtime() is True

    app = create_app()

    assert app.state.vercel_demo is True
    assert app.state.durable_database is False
    assert app.state.seed_demo is True
    assert app.state.durable_mock_files is True
    assert app.state.database.url == f"sqlite+aiosqlite:///{tmp_path / 'sftp-manager' / 'sftp-manager.db'}"
    assert app.state.gateway.mock_root == (tmp_path / "sftp-manager" / "mock-sftp").resolve()
    with TestClient(app) as client:
        assert client.get("/api/v1/health/ready").json() == {"status": "ready"}

    assert (tmp_path / "sftp-manager" / "logs" / "application.log").is_file()


def test_vercel_uses_configured_postgres_for_durable_sessions(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("VERCEL_TMP_DIR", str(tmp_path))
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://app:secret@example-pooler.neon.tech/appdb?sslmode=require",
    )
    monkeypatch.setenv("SEED_DEMO_USERS", "false")
    monkeypatch.delenv("DEPLOYMENT_MODE", raising=False)

    app = create_app()

    assert app.state.vercel_demo is False
    assert app.state.durable_database is True
    assert app.state.seed_demo is False
    assert app.state.database.url.startswith("postgresql+asyncpg://app:secret@")
    assert "sslmode" not in app.state.database.url
    assert app.state.gateway.mock_root == (tmp_path / "sftp-manager" / "mock-sftp").resolve()


def test_explicit_demo_mode_controls_durable_vercel_seeding(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("VERCEL_TMP_DIR", str(tmp_path))
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://app:secret@example-pooler.neon.tech/appdb?sslmode=require",
    )
    monkeypatch.setenv("DEPLOYMENT_MODE", "demo")
    monkeypatch.setenv("SEED_DEMO_USERS", "false")
    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test-token")

    app = create_app()

    assert app.state.deployment_mode == "demo"
    assert app.state.seed_demo is True


def test_vercel_demo_requires_durable_blob_storage(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("VERCEL_TMP_DIR", str(tmp_path))
    monkeypatch.setenv("DEPLOYMENT_MODE", "demo")
    monkeypatch.delenv("BLOB_READ_WRITE_TOKEN", raising=False)

    with pytest.raises(RuntimeError, match="requires BLOB_READ_WRITE_TOKEN"):
        create_app()


def test_vercel_production_mode_requires_postgresql(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("VERCEL_TMP_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("DEPLOYMENT_MODE", "production")

    with pytest.raises(RuntimeError, match="requires a PostgreSQL DATABASE_URL"):
        create_app()
