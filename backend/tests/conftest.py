from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture()
def client(tmp_path: Path):
    database = tmp_path / "test.db"
    mock_root = tmp_path / "mock-sftp"
    app = create_app(f"sqlite+aiosqlite:///{database}", mock_root, seed_demo=True)
    with TestClient(app) as test_client:
        yield test_client


def login(client: TestClient, email: str, password: str) -> dict[str, str]:
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": response.json()["csrfToken"]}


@pytest.fixture()
def admin_headers(client: TestClient) -> dict[str, str]:
    return login(client, "admin@example.com", "Admin123!Secure")


@pytest.fixture()
def user_headers(client: TestClient) -> dict[str, str]:
    return login(client, "user@example.com", "User123!Secure")
