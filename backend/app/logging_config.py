"""Structured operational logging for the SFTP Manager backend.

Audit events describe security-relevant business activity and live in SQLite.
This module deliberately handles a different concern: diagnostic application
logs for operators.  Only an allow-list of fields is serialized so request
bodies, cookies, credentials, remote banners, and file contents cannot be
accidentally copied into the operational log.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any


LOGGER_NAME = "sftp_manager"
LOG_FILENAME = "application.log"
VALID_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
SAFE_CONTEXT_FIELDS = (
    "event",
    "request_id",
    "method",
    "route",
    "status_code",
    "duration_ms",
    "error_type",
)


class JsonLogFormatter(logging.Formatter):
    """Render one compact, UTC JSON object per log record."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "severity": record.levelname,
            "service": "sftp-manager-backend",
            "logger": record.name,
            "message": record.getMessage(),
        }
        for field in SAFE_CONTEXT_FIELDS:
            value = getattr(record, field, None)
            if value is not None:
                payload[field] = value
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _positive_int_env(name: str, default: int) -> int:
    """Read a positive integer environment setting or fail during startup."""

    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a positive integer") from exc
    if value < 1:
        raise RuntimeError(f"{name} must be a positive integer")
    return value


def configure_logging(
    log_directory: str | Path | None = None,
    log_level: str | None = None,
) -> logging.Logger:
    """Configure console and rotating filesystem handlers.

    Reconfiguration is intentional: the application factory is instantiated
    repeatedly in tests, and retaining old handlers would duplicate records or
    keep file descriptors pointed at a previous test directory.
    """

    level_name = (log_level or os.getenv("LOG_LEVEL", "INFO")).strip().upper()
    if level_name not in VALID_LEVELS:
        choices = ", ".join(sorted(VALID_LEVELS))
        raise RuntimeError(f"LOG_LEVEL must be one of: {choices}")

    directory = Path(log_directory or os.getenv("APP_LOG_DIR", "./logs")).expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    if not directory.is_dir():
        raise RuntimeError(f"Application log path is not a directory: {directory}")

    formatter = JsonLogFormatter()
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    file_handler = RotatingFileHandler(
        directory / LOG_FILENAME,
        maxBytes=_positive_int_env("LOG_MAX_BYTES", 10 * 1024 * 1024),
        backupCount=_positive_int_env("LOG_BACKUP_COUNT", 5),
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)

    logger = logging.getLogger(LOGGER_NAME)
    for existing in logger.handlers:
        existing.close()
    logger.handlers.clear()
    logger.addHandler(console_handler)
    logger.addHandler(file_handler)
    logger.setLevel(getattr(logging, level_name))
    logger.propagate = False
    return logger
