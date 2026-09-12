"""Tests for redacted, rotating operational application logs."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.logging_config import LOG_FILENAME, configure_logging
from app.main import create_app


def _records(path: Path) -> list[dict[str, object]]:
    """Read JSON-lines records from a completed application-log write."""

    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _flush(logger: logging.Logger) -> None:
    """Make handler output deterministic before the test reads the file."""

    for handler in logger.handlers:
        handler.flush()


def test_filesystem_logger_writes_each_configured_severity(tmp_path: Path) -> None:
    logger = configure_logging(tmp_path, "DEBUG")

    for level in (logging.DEBUG, logging.INFO, logging.WARNING, logging.ERROR, logging.CRITICAL):
        logger.log(level, f"severity-{logging.getLevelName(level).lower()}", extra={"event": "test.severity"})
    _flush(logger)

    records = _records(tmp_path / LOG_FILENAME)
    assert [record["severity"] for record in records] == ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
    assert all(record["service"] == "sftp-manager-backend" for record in records)
    assert all(record["event"] == "test.severity" for record in records)


def test_logger_rotates_and_drops_unapproved_context(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LOG_MAX_BYTES", "300")
    monkeypatch.setenv("LOG_BACKUP_COUNT", "2")
    logger = configure_logging(tmp_path, "INFO")

    try:
        raise RuntimeError("raw-exception-must-not-appear")
    except RuntimeError:
        logger.error(
            "Safe diagnostic message",
            exc_info=True,
            extra={
                "event": "test.redaction",
                "source_ip": "192.0.2.99",
                "user_agent": "secret-client-detail",
                "credential": "secret-credential-value",
            },
        )
    for index in range(10):
        logger.info("Rotation record", extra={"event": f"test.rotation.{index}"})
    _flush(logger)

    paths = sorted(tmp_path.glob(f"{LOG_FILENAME}*"))
    combined = "\n".join(path.read_text(encoding="utf-8") for path in paths)
    assert tmp_path.joinpath(f"{LOG_FILENAME}.1").is_file()
    assert len(paths) <= 3
    assert "raw-exception-must-not-appear" not in combined
    assert "192.0.2.99" not in combined
    assert "secret-client-detail" not in combined
    assert "secret-credential-value" not in combined


def test_http_log_uses_route_template_and_omits_query_data(tmp_path: Path) -> None:
    log_directory = tmp_path / "logs"
    app = create_app(
        f"sqlite+aiosqlite:///{tmp_path / 'logging.db'}",
        tmp_path / "mock-sftp",
        seed_demo=False,
        log_directory=log_directory,
    )

    with TestClient(app) as client:
        success = client.get(
            "/api/v1/health/live?credential=must-not-appear",
            headers={"X-Request-ID": "logging-test-request"},
        )
        unauthorized = client.get("/api/v1/users")

    _flush(app.state.logger)
    log_text = (log_directory / LOG_FILENAME).read_text(encoding="utf-8")
    records = _records(log_directory / LOG_FILENAME)
    completed = [record for record in records if record.get("event") == "http.request.completed"]

    assert success.status_code == 200
    assert unauthorized.status_code == 401
    assert any(
        record.get("request_id") == "logging-test-request"
        and record.get("route") == "/api/v1/health/live"
        and record.get("severity") == "INFO"
        for record in completed
    )
    assert any(
        record.get("route") == "/api/v1/users"
        and record.get("status_code") == 401
        and record.get("severity") == "WARNING"
        for record in completed
    )
    assert "must-not-appear" not in log_text
    assert "credential=" not in log_text
