"""Add durable recurring task definitions and occurrence metadata."""

import sqlalchemy as sa
from alembic import op


revision = "0004_task_scheduling"
down_revision = "0003_resumable_file_uploads"
branch_labels = None
depends_on = None


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("task_definitions"):
        op.create_table(
            "task_definitions",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("title", sa.String(length=200), nullable=False),
            sa.Column("instructions", sa.Text(), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            sa.Column("server_id", sa.String(length=36), nullable=False),
            sa.Column("target_path", sa.String(length=1024), nullable=False),
            sa.Column("assignee_id", sa.String(length=36), nullable=False),
            sa.Column("created_by", sa.String(length=36), nullable=False),
            sa.Column("schedule_type", sa.String(length=16), nullable=False),
            sa.Column("start_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("timezone", sa.String(length=64), nullable=False),
            sa.Column("weekdays", sa.JSON(), nullable=False),
            sa.Column("month_day", sa.String(length=16), nullable=True),
            sa.Column("due_offset_minutes", sa.Integer(), nullable=False),
            sa.Column("completion_mode", sa.String(length=24), nullable=False),
            sa.Column("filename_glob", sa.String(length=255), nullable=True),
            sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_generated_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(["assignee_id"], ["users.id"], ondelete="RESTRICT"),
            sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="RESTRICT"),
            sa.ForeignKeyConstraint(["server_id"], ["sftp_servers.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_task_definitions_assignee_id", "task_definitions", ["assignee_id"])
        op.create_index("ix_task_definitions_enabled", "task_definitions", ["enabled"])
        op.create_index("ix_task_definitions_next_run_at", "task_definitions", ["next_run_at"])
        op.create_index("ix_task_definitions_server_id", "task_definitions", ["server_id"])
        op.create_index("ix_task_definition_next_run", "task_definitions", ["enabled", "next_run_at"])

    task_columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("tasks")}
    if "definition_id" not in task_columns:
        op.add_column("tasks", sa.Column("definition_id", sa.String(length=36), nullable=True))
    if "occurrence_key" not in task_columns:
        op.add_column("tasks", sa.Column("occurrence_key", sa.String(length=128), nullable=True))
    if "scheduled_at" not in task_columns:
        op.add_column("tasks", sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True))

    task_indexes = _index_names("tasks")
    if "ix_tasks_definition_id" not in task_indexes:
        op.create_index("ix_tasks_definition_id", "tasks", ["definition_id"])
    if "uq_tasks_occurrence_key" not in task_indexes:
        op.create_index("uq_tasks_occurrence_key", "tasks", ["occurrence_key"], unique=True)


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("tasks"):
        task_indexes = _index_names("tasks")
        if "uq_tasks_occurrence_key" in task_indexes:
            op.drop_index("uq_tasks_occurrence_key", table_name="tasks")
        if "ix_tasks_definition_id" in task_indexes:
            op.drop_index("ix_tasks_definition_id", table_name="tasks")
        task_columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("tasks")}
        for column in ("scheduled_at", "occurrence_key", "definition_id"):
            if column in task_columns:
                op.drop_column("tasks", column)
    if sa.inspect(op.get_bind()).has_table("task_definitions"):
        op.drop_table("task_definitions")
