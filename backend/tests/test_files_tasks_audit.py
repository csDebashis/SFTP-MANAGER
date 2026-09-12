from __future__ import annotations

import sqlite3
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from .conftest import login


def root(client: TestClient) -> dict[str, object]:
    response = client.get("/api/v1/files/roots")
    assert response.status_code == 200
    return response.json()["items"][0]


def upload_file(
    client: TestClient,
    headers: dict[str, str],
    server_id: str,
    path: str,
    filename: str,
    content: bytes,
    *,
    replace: bool = False,
) -> object:
    started = client.post(
        "/api/v1/files/uploads",
        json={"serverId": server_id, "path": path, "fileName": filename, "size": len(content), "replace": replace},
        headers=headers,
    )
    assert started.status_code == 201, started.text
    session = started.json()
    offset = session["receivedBytes"]
    chunk_size = session["chunkSize"]
    while offset < len(content):
        chunk = content[offset:offset + chunk_size]
        written = client.put(
            f"/api/v1/files/uploads/{session['uploadId']}/content",
            content=chunk,
            headers={**headers, "Content-Type": "application/octet-stream", "X-Upload-Offset": str(offset)},
        )
        assert written.status_code == 200, written.text
        offset = written.json()["receivedBytes"]
    return client.post(f"/api/v1/files/uploads/{session['uploadId']}/complete", headers=headers)


def test_mock_user_full_file_lifecycle(client: TestClient, user_headers: dict[str, str]) -> None:
    access_root = root(client)
    server_id = str(access_root["serverId"])

    listing = client.get("/api/v1/files/list", params={"serverId": server_id, "path": "/"})
    assert listing.status_code == 200
    assert {item["name"] for item in listing.json()["items"]} >= {"finance", "shared"}

    created = client.post(
        "/api/v1/files/folders",
        json={"serverId": server_id, "parent": "/shared", "name": "incoming"},
        headers=user_headers,
    )
    assert created.status_code == 201

    uploaded = upload_file(client, user_headers, server_id, "/shared/incoming", "sample.txt", b"sample content")
    assert uploaded.status_code == 200

    replaced = upload_file(client, user_headers, server_id, "/shared/incoming", "sample.txt", b"replacement content", replace=True)
    assert replaced.status_code == 200

    downloaded = client.get(
        "/api/v1/files/download",
        params={"serverId": server_id, "path": "/shared/incoming/sample.txt"},
    )
    assert downloaded.status_code == 200
    assert downloaded.content == b"replacement content"

    renamed = client.post(
        "/api/v1/files/rename",
        json={"serverId": server_id, "path": "/shared/incoming/sample.txt", "name": "renamed.txt"},
        headers=user_headers,
    )
    assert renamed.status_code == 200

    moved = client.post(
        "/api/v1/files/move",
        json={
            "serverId": server_id,
            "source": "/shared/incoming/renamed.txt",
            "destination": "/shared/moved.txt",
        },
        headers=user_headers,
    )
    assert moved.status_code == 200

    deleted = client.delete(
        "/api/v1/files/item",
        params={"serverId": server_id, "path": "/shared/moved.txt"},
        headers=user_headers,
    )
    assert deleted.status_code == 204
    assert client.delete(
        "/api/v1/files/item",
        params={"serverId": server_id, "path": "/shared/incoming"},
        headers=user_headers,
    ).status_code == 204

    actions = {event["action"] for event in client.get("/api/v1/audit-events").json()["items"]}
    assert {
        "FOLDER_CREATE",
        "FILE_UPLOAD",
        "FILE_REPLACE",
        "FILE_DOWNLOAD",
        "ITEM_RENAME",
        "ITEM_MOVE",
        "ITEM_DELETE",
    }.issubset(actions)
    assert "FOLDER_LIST" not in actions


def test_matching_upload_completes_task(client: TestClient, user_headers: dict[str, str]) -> None:
    server_id = str(root(client)["serverId"])
    tasks = client.get("/api/v1/tasks").json()["items"]
    task = next(item for item in tasks if item["title"] == "Upload month-end reconciliation")
    assert task["status"] == "PENDING"

    upload = upload_file(
        client,
        user_headers,
        server_id,
        "/finance/month-end",
        "reconciliation-2026-09.csv",
        b"account,amount\na,10\n",
    )
    assert upload.status_code == 200
    tasks = client.get("/api/v1/tasks").json()["items"]
    assert next(item for item in tasks if item["id"] == task["id"])["status"] == "COMPLETED"


def test_user_cannot_access_admin_apis(client: TestClient, user_headers: dict[str, str]) -> None:
    assert client.get("/api/v1/users").status_code == 403
    response = client.post(
        "/api/v1/sftp-servers",
        json={"name": "Forbidden", "host": "example.com", "password": "secret"},
        headers=user_headers,
    )
    assert response.status_code == 403


def test_folder_listing_is_not_audited(client: TestClient, user_headers: dict[str, str]) -> None:
    server_id = str(root(client)["serverId"])
    before = {event["id"] for event in client.get("/api/v1/audit-events").json()["items"]}
    assert client.get("/api/v1/files/list", params={"serverId": server_id, "path": "/shared"}).status_code == 200
    events = client.get("/api/v1/audit-events").json()["items"]
    assert {event["id"] for event in events} == before
    assert all(event["action"] != "FOLDER_LIST" for event in events)


def test_file_audit_request_metadata_is_visible_only_to_audit_roles(
    client: TestClient,
    user_headers: dict[str, str],
) -> None:
    server_id = str(root(client)["serverId"])
    request_headers = {
        **user_headers,
        "X-Forwarded-For": "203.0.113.42",
        "User-Agent": "Audit Browser/1.0",
    }
    uploaded = upload_file(client, request_headers, server_id, "/shared", "audit-sample.txt", b"audit content")
    assert uploaded.status_code == 200

    events = client.get("/api/v1/audit-events").json()["items"]
    event = next(item for item in events if item["action"] == "FILE_UPLOAD" and item["itemName"] == "audit-sample.txt")
    assert event["actorDisplay"] == "user@gmail.com"
    assert event["serverName"] == "Mock SFTP"
    assert event["path"] == "/shared/audit-sample.txt"
    assert event["folderPath"] == "/shared"
    assert event["requestId"]
    assert "sourceIp" not in event
    assert "clientDetails" not in event

    database_path = client.app.state.database.url.removeprefix("sqlite+aiosqlite:///")
    with sqlite3.connect(database_path) as connection:
        stored = connection.execute(
            "SELECT source_ip, client_details FROM audit_events WHERE id = ?",
            (event["id"],),
        ).fetchone()
    assert stored == ("203.0.113.42", "Audit Browser/1.0")

    client.cookies.clear()
    login(client, "admin@gmail.com", "Admin123!Secure")
    admin_events = client.get("/api/v1/audit-events").json()["items"]
    admin_event = next(item for item in admin_events if item["id"] == event["id"])
    assert admin_event["sourceIp"] == "203.0.113.42"
    assert admin_event["clientDetails"] == "Audit Browser/1.0"

    # Dashboard recent activity is an end-user activity surface even for an Admin.
    assert all(
        "sourceIp" not in item and "clientDetails" not in item
        for item in client.get("/api/v1/dashboard").json()["recentActivity"]
    )


def test_interrupted_upload_returns_retryable_error_and_is_audited(
    client: TestClient,
    user_headers: dict[str, str],
    monkeypatch,
) -> None:
    server_id = str(root(client)["serverId"])
    started = client.post(
        "/api/v1/files/uploads",
        json={"serverId": server_id, "path": "/shared", "fileName": "interrupted.bin", "size": 15},
        headers=user_headers,
    )
    assert started.status_code == 201
    upload_id = started.json()["uploadId"]
    monkeypatch.setattr(client.app.state.gateway, "write_upload_chunk", AsyncMock(side_effect=ConnectionError("connection lost")))

    response = client.put(
        f"/api/v1/files/uploads/{upload_id}/content",
        content=b"partial content",
        headers={**user_headers, "Content-Type": "application/octet-stream", "X-Upload-Offset": "0"},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "SFTP write was interrupted. Retry to resume the upload."
    events = client.get("/api/v1/audit-events").json()["items"]
    event = next(item for item in events if item["action"] == "FILE_UPLOAD_INTERRUPTED" and item["path"] == "/shared/interrupted.bin")
    assert event["outcome"] == "FAILURE"
    assert event["detail"] == {"safeErrorCode": "SFTP_UPLOAD_CHUNK_FAILED"}


def test_upload_progress_is_remote_acknowledged_and_resumable(client: TestClient, user_headers: dict[str, str]) -> None:
    server_id = str(root(client)["serverId"])
    content = b"remote acknowledged content"
    started = client.post(
        "/api/v1/files/uploads",
        json={"serverId": server_id, "path": "/shared", "fileName": "resumable.bin", "size": len(content)},
        headers=user_headers,
    )
    assert started.status_code == 201
    upload_id = started.json()["uploadId"]

    first = client.put(
        f"/api/v1/files/uploads/{upload_id}/content",
        content=content[:8],
        headers={**user_headers, "Content-Type": "application/octet-stream", "X-Upload-Offset": "0"},
    )
    assert first.status_code == 200
    assert first.json()["receivedBytes"] == 8
    temporary = client.app.state.gateway._mock_path(f"/shared/.resumable.bin.uploading-{upload_id}")
    assert temporary.stat().st_size == 8

    resumed = client.get(f"/api/v1/files/uploads/{upload_id}")
    assert resumed.status_code == 200
    assert resumed.json()["receivedBytes"] == 8
    second = client.put(
        f"/api/v1/files/uploads/{upload_id}/content",
        content=content[8:],
        headers={**user_headers, "Content-Type": "application/octet-stream", "X-Upload-Offset": "8"},
    )
    assert second.status_code == 200
    assert second.json()["receivedBytes"] == len(content)
    completed = client.post(f"/api/v1/files/uploads/{upload_id}/complete", headers=user_headers)
    assert completed.status_code == 200
    assert client.app.state.gateway._mock_path("/shared/resumable.bin").read_bytes() == content


def test_concurrent_uploads_cannot_silently_overwrite_the_same_target(
    client: TestClient,
    user_headers: dict[str, str],
) -> None:
    server_id = str(root(client)["serverId"])
    sessions = []
    for content in (b"first", b"second"):
        started = client.post(
            "/api/v1/files/uploads",
            json={"serverId": server_id, "path": "/shared", "fileName": "parallel.txt", "size": len(content)},
            headers=user_headers,
        )
        assert started.status_code == 201
        session = started.json()
        written = client.put(
            f"/api/v1/files/uploads/{session['uploadId']}/content",
            content=content,
            headers={**user_headers, "Content-Type": "application/octet-stream", "X-Upload-Offset": "0"},
        )
        assert written.status_code == 200
        sessions.append(session)

    first = client.post(f"/api/v1/files/uploads/{sessions[0]['uploadId']}/complete", headers=user_headers)
    second = client.post(f"/api/v1/files/uploads/{sessions[1]['uploadId']}/complete", headers=user_headers)

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["detail"] == "A file with this name already exists"
    assert client.app.state.gateway._mock_path("/shared/parallel.txt").read_bytes() == b"first"


def test_csrf_is_required_for_mutation(client: TestClient) -> None:
    response = client.post("/api/v1/auth/login", json={"email": "user@gmail.com", "password": "User123!Secure"})
    assert response.status_code == 200
    root_item = root(client)
    denied = client.post(
        "/api/v1/files/folders",
        json={"serverId": root_item["serverId"], "parent": "/shared", "name": "blocked"},
    )
    assert denied.status_code == 403


def test_task_transitions_and_reopen_authorization(client: TestClient, user_headers: dict[str, str]) -> None:
    task = client.get("/api/v1/tasks").json()["items"][0]
    completed = client.post(f"/api/v1/tasks/{task['id']}/complete", headers=user_headers)
    assert completed.status_code == 200
    assert completed.json()["status"] == "COMPLETED"

    assert client.post(f"/api/v1/tasks/{task['id']}/start", headers=user_headers).status_code == 409
    assert client.post(f"/api/v1/tasks/{task['id']}/reopen", headers=user_headers).status_code == 403

    client.cookies.clear()
    admin_headers = login(client, "admin@gmail.com", "Admin123!Secure")
    reopened = client.post(f"/api/v1/tasks/{task['id']}/reopen", headers=admin_headers)
    assert reopened.status_code == 200
    assert reopened.json()["status"] == "PENDING"
