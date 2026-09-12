"""Contract tests for the current, intentionally non-migrating schema."""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest
import sqlalchemy as sa

from app.db import Database, SchemaBaselineError
from app.models import Base, CURRENT_SCHEMA_BASELINE


def initialize(database_path: Path) -> None:
    """Initialize and close a database using the production lifecycle."""

    async def run() -> None:
        database = Database(f"sqlite+aiosqlite:///{database_path}")
        try:
            await database.initialize()
        finally:
            await database.close()

    asyncio.run(run())


def test_empty_database_is_initialized_at_current_baseline(tmp_path: Path) -> None:
    database_path = tmp_path / "fresh.db"

    initialize(database_path)

    engine = sa.create_engine(f"sqlite:///{database_path}")
    inspector = sa.inspect(engine)
    assert set(inspector.get_table_names()) == set(Base.metadata.tables)
    with engine.connect() as connection:
        assert connection.scalar(sa.text("SELECT version FROM schema_baseline WHERE id = 1")) == CURRENT_SCHEMA_BASELINE
    engine.dispose()


def test_current_baseline_can_be_reopened_without_recreating_data(tmp_path: Path) -> None:
    database_path = tmp_path / "existing.db"
    initialize(database_path)
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "INSERT INTO groups (id, name, description, created_at, version) VALUES (?, ?, ?, ?, ?)",
            ("group-1", "Baseline group", "preserved", "2026-09-12T00:00:00Z", 1),
        )

    initialize(database_path)

    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT name FROM groups WHERE id = ?", ("group-1",)).fetchone() == ("Baseline group",)


def test_unversioned_or_partial_database_is_rejected(tmp_path: Path) -> None:
    database_path = tmp_path / "incompatible.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TABLE users (id VARCHAR(36) PRIMARY KEY)")

    with pytest.raises(SchemaBaselineError, match="does not match baseline"):
        initialize(database_path)


def test_wrong_baseline_marker_is_rejected(tmp_path: Path) -> None:
    database_path = tmp_path / "wrong-version.db"
    initialize(database_path)
    with sqlite3.connect(database_path) as connection:
        connection.execute("UPDATE schema_baseline SET version = 'older' WHERE id = 1")

    with pytest.raises(SchemaBaselineError, match="is incompatible"):
        initialize(database_path)


def test_changed_table_shape_is_rejected(tmp_path: Path) -> None:
    database_path = tmp_path / "changed-shape.db"
    initialize(database_path)
    with sqlite3.connect(database_path) as connection:
        connection.execute("ALTER TABLE groups ADD COLUMN legacy_value TEXT")

    with pytest.raises(SchemaBaselineError, match=r"unexpected columns=\['legacy_value'\]"):
        initialize(database_path)
