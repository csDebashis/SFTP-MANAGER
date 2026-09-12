"""Schema migration checks for fresh and previously deployed SQLite files."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.config import Config


def _config(database_path: Path) -> Config:
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite+aiosqlite:///{database_path}")
    return config


def test_head_creates_current_schema_on_a_fresh_database(tmp_path: Path) -> None:
    database_path = tmp_path / "fresh.db"

    command.upgrade(_config(database_path), "head")

    engine = sa.create_engine(f"sqlite:///{database_path}")
    inspector = sa.inspect(engine)
    assert inspector.has_table("task_definitions")
    assert {column["name"] for column in inspector.get_columns("tasks")} >= {
        "definition_id",
        "occurrence_key",
        "scheduled_at",
    }
    engine.dispose()


def test_task_migration_preserves_a_previous_schema(tmp_path: Path) -> None:
    """Upgrade the shape an installed v1.1 database exposes to migration 0004."""

    database_path = tmp_path / "upgrade.db"
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """
            CREATE TABLE users (id VARCHAR(36) NOT NULL PRIMARY KEY);
            CREATE TABLE sftp_servers (id VARCHAR(36) NOT NULL PRIMARY KEY);
            CREATE TABLE tasks (id VARCHAR(36) NOT NULL PRIMARY KEY);
            CREATE TABLE alembic_version (
                version_num VARCHAR(32) NOT NULL PRIMARY KEY
            );
            INSERT INTO alembic_version (version_num)
            VALUES ('0003_resumable_file_uploads');
            """
        )

    command.upgrade(_config(database_path), "head")

    engine = sa.create_engine(f"sqlite:///{database_path}")
    inspector = sa.inspect(engine)
    assert inspector.has_table("task_definitions")
    task_columns = {column["name"] for column in inspector.get_columns("tasks")}
    assert {"definition_id", "occurrence_key", "scheduled_at"} <= task_columns
    indexes = {index["name"]: index for index in inspector.get_indexes("tasks")}
    assert indexes["uq_tasks_occurrence_key"]["unique"] == 1
    with engine.connect() as connection:
        assert connection.scalar(sa.text("SELECT version_num FROM alembic_version")) == "0004_task_scheduling"
    engine.dispose()

