"""Recurring task generation, overdue state, and SFTP file-check coverage."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from app.main import _localize_schedule_time, check_matching_task_files, first_schedule_occurrence, generate_due_task_instances


def _assignee_id(client: TestClient) -> str:
    users = client.get("/api/v1/users").json()["items"]
    return next(user["id"] for user in users if user["email"] == "user@gmail.com")


def _server_id(client: TestClient) -> str:
    return client.get("/api/v1/sftp-servers").json()["items"][0]["id"]


def _definition_payload(client: TestClient, start_at: datetime, **changes: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "title": "Scheduled delivery",
        "instructions": "Deliver the expected CSV file.",
        "serverId": _server_id(client),
        "targetPath": "/shared",
        "assigneeId": _assignee_id(client),
        "scheduleType": "ONCE",
        "startAt": start_at.isoformat(),
        "timezone": "UTC",
        "weekdays": [],
        "monthDay": None,
        "dueOffsetMinutes": 60,
        "completionMode": "MANUAL",
        "filenameGlob": None,
    }
    payload.update(changes)
    return payload


def test_scheduler_jobs_are_configured(client: TestClient) -> None:
    assert {job.id for job in client.app.state.scheduler.get_jobs()} == {
        "overdue",
        "task-file-check",
        "task-generation",
    }


def test_daily_definition_generates_once_and_advances(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    start = datetime.now(timezone.utc) - timedelta(seconds=1)
    created = client.post(
        "/api/v1/task-definitions",
        json=_definition_payload(client, start, scheduleType="DAILY"),
        headers=admin_headers,
    )

    assert created.status_code == 201, created.text
    definition = created.json()
    assert definition["scheduleType"] == "DAILY"
    assert definition["enabled"] is True
    assert datetime.fromisoformat(definition["nextRunAt"]) > start + timedelta(hours=23)
    occurrences = [
        task for task in client.get("/api/v1/tasks").json()["items"]
        if task["definitionId"] == definition["id"]
    ]
    assert len(occurrences) == 1
    assert occurrences[0]["occurrenceKey"]
    assert occurrences[0]["status"] == "PENDING"

    assert client.portal is not None
    generated = client.portal.call(generate_due_task_instances, client.app, datetime.now(timezone.utc))
    assert generated == 0
    occurrences = [
        task for task in client.get("/api/v1/tasks").json()["items"]
        if task["definitionId"] == definition["id"]
    ]
    assert len(occurrences) == 1


def test_missing_matching_file_becomes_overdue(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    start = datetime.now(timezone.utc) - timedelta(minutes=2)
    created = client.post(
        "/api/v1/task-definitions",
        json=_definition_payload(
            client,
            start,
            dueOffsetMinutes=1,
            completionMode="MATCHING_UPLOAD",
            filenameGlob="expected-*.csv",
        ),
        headers=admin_headers,
    )

    assert created.status_code == 201, created.text
    task = next(
        task for task in client.get("/api/v1/tasks").json()["items"]
        if task["definitionId"] == created.json()["id"]
    )
    assert task["status"] == "OVERDUE"


def test_scheduled_folder_check_completes_matching_external_delivery(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    start = datetime.now(timezone.utc) - timedelta(seconds=1)
    created = client.post(
        "/api/v1/task-definitions",
        json=_definition_payload(
            client,
            start,
            completionMode="MATCHING_UPLOAD",
            filenameGlob="external-*.csv",
        ),
        headers=admin_headers,
    )
    assert created.status_code == 201, created.text

    external_file: Path = client.app.state.gateway._mock_path("/shared/external-delivery.csv")
    external_file.write_text("account,amount\na,10\n", encoding="utf-8")
    future_timestamp = datetime.now(timezone.utc).timestamp() + 1
    os.utime(external_file, (future_timestamp, future_timestamp))

    assert client.portal is not None
    completed = client.portal.call(check_matching_task_files, client.app)
    assert completed == 1
    task = next(
        task for task in client.get("/api/v1/tasks").json()["items"]
        if task["definitionId"] == created.json()["id"]
    )
    assert task["status"] == "COMPLETED"
    audit = client.get("/api/v1/audit-events").json()["items"]
    event = next(item for item in audit if item["action"] == "TASK_AUTO_COMPLETE" and item["resourceId"] == task["id"])
    assert event["detail"] == {"fileName": "external-delivery.csv", "detection": "SCHEDULED_FOLDER_CHECK"}


def test_schedule_calculation_handles_last_day_and_dst_gap() -> None:
    monthly = first_schedule_occurrence(
        datetime(2028, 2, 1, 9, tzinfo=timezone.utc),
        "MONTHLY",
        "UTC",
        [],
        "LAST_DAY",
    )
    assert monthly == datetime(2028, 2, 29, 9, tzinfo=timezone.utc)

    # 02:30 does not exist in New York on this date. The rule chooses 03:00,
    # the first valid local occurrence after the skipped wall-clock time.
    zone = ZoneInfo("America/New_York")
    resolved = _localize_schedule_time(datetime(2026, 3, 8, 2, 30), zone)
    assert resolved.astimezone(zone).hour == 3
    assert resolved.astimezone(zone).minute == 0

    # Chromium may expose this IANA compatibility name rather than
    # Asia/Kolkata. The backend image must accept browser-reported aliases.
    browser_zone = ZoneInfo("Asia/Calcutta")
    daily = first_schedule_occurrence(
        datetime(2026, 9, 12, 2, 30, tzinfo=timezone.utc),
        "DAILY",
        browser_zone.key,
        [],
        None,
    )
    assert daily == datetime(2026, 9, 12, 2, 30, tzinfo=timezone.utc)
