from __future__ import annotations

from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from app.main import create_app
from .conftest import login


def test_seeded_admin_and_user_can_login(client: TestClient) -> None:
    admin = client.post("/api/v1/auth/login", json={"email": "admin@gmail.com", "password": "Admin123!Secure"})
    assert admin.status_code == 200
    assert admin.json()["user"]["role"] == "ADMIN"

    client.cookies.clear()
    user = client.post("/api/v1/auth/login", json={"email": "user@gmail.com", "password": "User123!Secure"})
    assert user.status_code == 200
    assert user.json()["user"]["role"] == "USER"


def test_bootstrap_admin_is_created_in_sqlite(tmp_path, monkeypatch) -> None:
    password_file = tmp_path / "admin-password"
    password_file.write_text("Bootstrap123!Secure", encoding="utf-8")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_EMAIL", "owner@example.com")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD_FILE", str(password_file))
    app = create_app(f"sqlite+aiosqlite:///{tmp_path / 'bootstrap.db'}", tmp_path / "mock", seed_demo=False)
    with TestClient(app) as bootstrap_client:
        response = bootstrap_client.post("/api/v1/auth/login", json={"email": "owner@example.com", "password": "Bootstrap123!Secure"})
        assert response.status_code == 200
        assert response.json()["user"]["role"] == "ADMIN"


def test_signup_requires_admin_approval(client: TestClient, admin_headers: dict[str, str]) -> None:
    client.cookies.clear()
    signup = client.post(
        "/api/v1/auth/signup",
        json={"displayName": "Pending Person", "email": "pending@example.com", "password": "Pending123!Secure"},
    )
    assert signup.status_code == 201

    pending_headers = login(client, "pending@example.com", "Pending123!Secure")
    dashboard = client.get("/api/v1/dashboard")
    assert dashboard.status_code == 403

    client.cookies.clear()
    admin_headers = login(client, "admin@gmail.com", "Admin123!Secure")
    users = client.get("/api/v1/users").json()["items"]
    pending = next(user for user in users if user["email"] == "pending@example.com")
    approved = client.post(f"/api/v1/users/{pending['id']}/approve", json={"role": "USER"}, headers=admin_headers)
    assert approved.status_code == 200
    assert approved.json()["state"] == "ACTIVE"

    client.cookies.clear()
    login(client, "pending@example.com", "Pending123!Secure")
    assert client.get("/api/v1/dashboard").status_code == 200


def test_admin_can_manage_groups_and_grants(client: TestClient, admin_headers: dict[str, str]) -> None:
    users = client.get("/api/v1/users").json()["items"]
    mock_user = next(user for user in users if user["email"] == "user@gmail.com")
    server = client.get("/api/v1/sftp-servers").json()["items"][0]

    group = client.post(
        "/api/v1/groups",
        json={"name": "Finance", "description": "Finance users", "memberIds": [mock_user["id"]]},
        headers=admin_headers,
    )
    assert group.status_code == 201

    grant = client.post(
        "/api/v1/access-grants",
        json={
            "principalType": "GROUP",
            "principalId": group.json()["id"],
            "serverId": server["id"],
            "path": "/finance",
            "permissions": ["LIST", "DOWNLOAD"],
            "recursive": True,
        },
        headers=admin_headers,
    )
    assert grant.status_code == 201
    assert grant.json()["permissions"] == ["DOWNLOAD", "LIST"]
    assert grant.json()["principalName"] == "Finance"
    assert grant.json()["serverName"] == server["name"]

    listed_grant = next(
        item
        for item in client.get("/api/v1/access-grants").json()["items"]
        if item["id"] == grant.json()["id"]
    )
    assert listed_grant["principalName"] == "Finance"
    assert listed_grant["serverName"] == server["name"]

    updated = client.patch(
        f"/api/v1/access-grants/{grant.json()['id']}",
        json={
            "principalType": "GROUP",
            "principalId": group.json()["id"],
            "serverId": server["id"],
            "path": "/finance/month-end",
            "permissions": ["LIST", "DOWNLOAD", "UPLOAD"],
            "recursive": False,
        },
        headers=admin_headers,
    )
    assert updated.status_code == 200
    assert updated.json()["path"] == "/finance/month-end"
    assert updated.json()["permissions"] == ["DOWNLOAD", "LIST", "UPLOAD"]
    assert updated.json()["recursive"] is False
    assert updated.json()["principalName"] == "Finance"
    assert updated.json()["serverName"] == server["name"]
    audit_events = client.get("/api/v1/audit-events").json()["items"]
    grant_event = next(event for event in audit_events if event["action"] == "GRANT_UPDATE" and event["resourceId"] == grant.json()["id"])
    assert grant_event["serverName"] == server["name"]
    assert grant_event["folderPath"] == "/finance/month-end"
    assert grant_event["detail"] == {
        "principalType": "GROUP",
        "principalName": "Finance",
        "permissions": ["DOWNLOAD", "LIST", "UPLOAD"],
        "recursive": False,
    }
    access = client.get(
        f"/api/v1/users/{mock_user['id']}/effective-access",
        params={"serverId": server["id"], "path": "/finance/month-end"},
    )
    assert access.status_code == 200
    assert set(access.json()["permissions"]) >= {"LIST", "DOWNLOAD", "UPLOAD"}
    assert client.delete(f"/api/v1/access-grants/{grant.json()['id']}", headers=admin_headers).status_code == 204


def test_admin_can_create_and_test_mock_server(client: TestClient, admin_headers: dict[str, str]) -> None:
    created = client.post(
        "/api/v1/sftp-servers",
        json={"name": "Secondary Mock", "host": "mock.local", "adapterType": "MOCK", "rootPath": "/"},
        headers=admin_headers,
    )
    assert created.status_code == 201
    assert created.json()["hostKeyFingerprint"] == "mock-local"
    assert created.json()["lastTest"]["success"] is True
    tested = client.post(f"/api/v1/sftp-servers/{created.json()['id']}/test", headers=admin_headers)
    assert tested.status_code == 200
    assert tested.json()["success"] is True


def test_deleting_server_atomically_removes_associated_configuration(client: TestClient, admin_headers: dict[str, str]) -> None:
    server = client.get("/api/v1/sftp-servers").json()["items"][0]
    server_id = server["id"]
    upload = client.post(
        "/api/v1/files/uploads",
        json={"serverId": server_id, "path": "/shared", "fileName": "pending-delete.bin", "size": 32},
        headers=admin_headers,
    )
    assert upload.status_code == 201

    response = client.delete(f"/api/v1/sftp-servers/{server_id}", headers=admin_headers)

    assert response.status_code == 204
    assert all(item["id"] != server_id for item in client.get("/api/v1/sftp-servers").json()["items"])
    assert all(item["serverId"] != server_id for item in client.get("/api/v1/access-grants").json()["items"])
    assert all(item["serverId"] != server_id for item in client.get("/api/v1/tasks").json()["items"])
    assert client.get(f"/api/v1/files/uploads/{upload.json()['uploadId']}").status_code == 404

    event = next(
        item
        for item in client.get("/api/v1/audit-events").json()["items"]
        if item["action"] == "SERVER_DELETE" and item["resourceId"] == server_id
    )
    assert event["serverName"] == server["name"]
    assert event["detail"] == {
        "serverName": server["name"],
        "deletedGrantCount": 1,
        "deletedTaskDefinitionCount": 0,
        "deletedTaskCount": 1,
        "deletedUploadSessionCount": 1,
    }
    assert (client.app.state.gateway.mock_root / "shared" / "welcome.txt").is_file()


def test_real_server_automatically_discovers_and_pins_host_key(client: TestClient, admin_headers: dict[str, str]) -> None:
    gateway_test = AsyncMock(return_value={"success": True, "message": "Connection successful", "fingerprint": "SHA256:automatically-discovered"})
    client.app.state.gateway.test = gateway_test
    response = client.post(
        "/api/v1/sftp-servers",
        json={"name": "Automatically Pinned", "host": "sftp.example.com", "username": "demo", "password": "secret-value", "adapterType": "REAL", "rootPath": "/"},
        headers=admin_headers,
    )
    assert response.status_code == 201
    assert response.json()["hostKeyFingerprint"] == "SHA256:automatically-discovered"
    assert response.json()["lastTest"]["success"] is True
    transient = gateway_test.await_args.args[0]
    assert transient.host_key_fingerprint == "SHA256:automatically-discovered"
    assert gateway_test.await_args.kwargs == {"discover_host_key": True}


def test_failed_connection_does_not_save_server(client: TestClient, admin_headers: dict[str, str]) -> None:
    client.app.state.gateway.test = AsyncMock(return_value={"success": False, "message": "ConnectionRefusedError"})
    response = client.post(
        "/api/v1/sftp-servers",
        json={"name": "Unavailable Server", "host": "sftp.invalid", "username": "demo", "password": "secret-value", "adapterType": "REAL", "rootPath": "/"},
        headers=admin_headers,
    )
    assert response.status_code == 502
    servers = client.get("/api/v1/sftp-servers").json()["items"]
    assert all(server["name"] != "Unavailable Server" for server in servers)


def test_password_change_revokes_sessions(client: TestClient, user_headers: dict[str, str]) -> None:
    changed = client.post(
        "/api/v1/auth/password/change",
        json={"currentPassword": "User123!Secure", "newPassword": "User456!Secure"},
        headers=user_headers,
    )
    assert changed.status_code == 200
    assert client.get("/api/v1/auth/me").status_code == 401
    assert client.post("/api/v1/auth/login", json={"email": "user@gmail.com", "password": "User123!Secure"}).status_code == 401
    assert client.post("/api/v1/auth/login", json={"email": "user@gmail.com", "password": "User456!Secure"}).status_code == 200


def test_user_can_update_own_name_and_email_without_changing_generated_id(client: TestClient, user_headers: dict[str, str]) -> None:
    original = client.get("/api/v1/auth/me").json()["user"]

    response = client.patch(
        f"/api/v1/users/{original['id']}",
        json={"displayName": "Updated User", "email": "Updated.User@Gmail.com"},
        headers=user_headers,
    )

    assert response.status_code == 200
    updated = response.json()
    assert updated["id"] == original["id"]
    assert updated["displayName"] == "Updated User"
    assert updated["email"] == "updated.user@gmail.com"
    assert client.get("/api/v1/auth/me").json()["user"] == updated
    assert all(root["serverId"] for root in client.get("/api/v1/files/roots").json()["items"])
    assert any(task["assigneeId"] == original["id"] for task in client.get("/api/v1/tasks").json()["items"])

    audit = next(
        event
        for event in client.get("/api/v1/audit-events").json()["items"]
        if event["action"] == "USER_UPDATE" and event["resourceId"] == original["id"]
    )
    assert audit["actorId"] == original["id"]
    assert audit["detail"]["userId"] == original["id"]
    assert set(audit["detail"]["changedFields"]) == {"displayName", "email"}

    client.cookies.clear()
    assert client.post("/api/v1/auth/login", json={"email": "user@gmail.com", "password": "User123!Secure"}).status_code == 401
    assert client.post("/api/v1/auth/login", json={"email": "updated.user@gmail.com", "password": "User123!Secure"}).status_code == 200


def test_user_profile_updates_enforce_user_id_scope_and_unique_email(client: TestClient, admin_headers: dict[str, str]) -> None:
    admin = next(user for user in client.get("/api/v1/users").json()["items"] if user["email"] == "admin@gmail.com")
    client.cookies.clear()
    user_headers = login(client, "user@gmail.com", "User123!Secure")
    current = client.get("/api/v1/auth/me").json()["user"]

    assert client.patch(f"/api/v1/users/{current['id']}", json={"role": "ADMIN"}, headers=user_headers).status_code == 403
    assert client.patch(f"/api/v1/users/{admin['id']}", json={"displayName": "Not allowed"}, headers=user_headers).status_code == 403
    duplicate = client.patch(f"/api/v1/users/{current['id']}", json={"email": "ADMIN@GMAIL.COM"}, headers=user_headers)
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == "Email address is already in use"


def test_login_rate_limit(client: TestClient) -> None:
    statuses = [client.post("/api/v1/auth/login", json={"email": "missing@example.com", "password": "WrongPassword123!"}).status_code for _ in range(5)]
    assert statuses[:4] == [401, 401, 401, 401]
    assert statuses[4] == 429
    assert client.post("/api/v1/auth/login", json={"email": "missing@example.com", "password": "WrongPassword123!"}).status_code == 429


def test_last_active_admin_cannot_be_demoted(client: TestClient, admin_headers: dict[str, str]) -> None:
    admin = next(user for user in client.get("/api/v1/users").json()["items"] if user["email"] == "admin@gmail.com")
    response = client.patch(
        f"/api/v1/users/{admin['id']}",
        json={"role": "USER"},
        headers=admin_headers,
    )
    assert response.status_code == 409
    assert client.get("/api/v1/auth/me").json()["user"]["role"] == "ADMIN"


def test_grant_update_revalidates_principal(client: TestClient, admin_headers: dict[str, str]) -> None:
    grant = client.get("/api/v1/access-grants").json()["items"][0]
    response = client.patch(
        f"/api/v1/access-grants/{grant['id']}",
        json={
            "principalType": "USER",
            "principalId": "00000000-0000-0000-0000-000000000000",
            "serverId": grant["serverId"],
            "path": grant["path"],
            "permissions": ["LIST"],
            "recursive": True,
        },
        headers=admin_headers,
    )
    assert response.status_code == 422


def test_grant_validation_error_is_readable_text(client: TestClient, admin_headers: dict[str, str]) -> None:
    grant = client.get("/api/v1/access-grants").json()["items"][0]
    response = client.patch(
        f"/api/v1/access-grants/{grant['id']}",
        json={
            "principalType": grant["principalType"],
            "principalId": grant["principalId"],
            "serverId": grant["serverId"],
            "path": "relative-path",
            "permissions": grant["permissions"],
            "recursive": grant["recursive"],
        },
        headers=admin_headers,
    )
    assert response.status_code == 422
    assert response.json() == {"detail": 'Folder path must start with "/" and use an absolute POSIX path.'}
