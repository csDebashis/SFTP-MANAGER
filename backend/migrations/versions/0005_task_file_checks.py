"""Add configurable external-file checks to task schedules and instances."""

import sqlalchemy as sa
from alembic import op


revision = "0005_task_file_checks"
down_revision = "0004_task_scheduling"
branch_labels = None
depends_on = None


def _column_names(table: str) -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    definition_columns = _column_names("task_definitions")
    if "file_check_interval_minutes" not in definition_columns:
        op.add_column(
            "task_definitions",
            sa.Column("file_check_interval_minutes", sa.Integer(), nullable=False, server_default="5"),
        )
    if "last_checked_at" not in definition_columns:
        op.add_column("task_definitions", sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True))

    task_columns = _column_names("tasks")
    if "file_check_interval_minutes" not in task_columns:
        op.add_column(
            "tasks",
            sa.Column("file_check_interval_minutes", sa.Integer(), nullable=False, server_default="5"),
        )
    if "last_checked_at" not in task_columns:
        op.add_column("tasks", sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True))
    if "next_check_at" not in task_columns:
        op.add_column("tasks", sa.Column("next_check_at", sa.DateTime(timezone=True), nullable=True))

    # Existing active matching tasks should enter the new due-check queue once.
    # The guarded branch also supports the deliberately minimal legacy schema
    # used by the migration contract test.
    migrated_task_columns = _column_names("tasks")
    if {"completion_mode", "status", "next_check_at"} <= migrated_task_columns:
        op.execute(
            """
            UPDATE tasks
               SET next_check_at = CURRENT_TIMESTAMP
             WHERE completion_mode = 'MATCHING_UPLOAD'
               AND status IN ('PENDING', 'IN_PROGRESS', 'OVERDUE')
               AND next_check_at IS NULL
            """
        )
    if "ix_tasks_next_check_at" not in _index_names("tasks"):
        op.create_index("ix_tasks_next_check_at", "tasks", ["next_check_at"])


def downgrade() -> None:
    if "ix_tasks_next_check_at" in _index_names("tasks"):
        op.drop_index("ix_tasks_next_check_at", table_name="tasks")
    for column in ("next_check_at", "last_checked_at", "file_check_interval_minutes"):
        if column in _column_names("tasks"):
            op.drop_column("tasks", column)
    for column in ("last_checked_at", "file_check_interval_minutes"):
        if column in _column_names("task_definitions"):
            op.drop_column("task_definitions", column)
