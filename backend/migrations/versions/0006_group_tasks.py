"""Allow one shared scheduled work item to be owned by a group."""

import sqlalchemy as sa
from alembic import op


revision = "0006_group_tasks"
down_revision = "0005_task_file_checks"
branch_labels = None
depends_on = None


def _columns(table: str) -> dict[str, dict[str, object]]:
    return {column["name"]: column for column in sa.inspect(op.get_bind()).get_columns(table)}


def _indexes(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def _foreign_key_names(table: str) -> set[str]:
    return {key["name"] for key in sa.inspect(op.get_bind()).get_foreign_keys(table) if key.get("name")}


def _upgrade_assignment_table(table: str) -> None:
    columns = _columns(table)
    needs_group_column = "assignee_group_id" not in columns
    needs_nullable_user = "assignee_id" in columns and not bool(columns["assignee_id"]["nullable"])
    if needs_group_column or needs_nullable_user:
        with op.batch_alter_table(table) as batch:
            if needs_nullable_user:
                batch.alter_column("assignee_id", existing_type=sa.String(length=36), nullable=True)
            if needs_group_column:
                batch.add_column(sa.Column("assignee_group_id", sa.String(length=36), nullable=True))
                batch.create_foreign_key(
                    f"fk_{table}_assignee_group_id_groups",
                    "groups",
                    ["assignee_group_id"],
                    ["id"],
                    ondelete="CASCADE",
                )
    index_name = f"ix_{table}_assignee_group_id"
    if index_name not in _indexes(table):
        op.create_index(index_name, table, ["assignee_group_id"])


def upgrade() -> None:
    _upgrade_assignment_table("task_definitions")
    _upgrade_assignment_table("tasks")
    if "due_at" in _columns("tasks") and "ix_task_group_due" not in _indexes("tasks"):
        op.create_index("ix_task_group_due", "tasks", ["assignee_group_id", "due_at"])


def downgrade() -> None:
    # Group-owned rows cannot be represented by the former user-only schema.
    op.execute("DELETE FROM tasks WHERE assignee_group_id IS NOT NULL")
    op.execute("DELETE FROM task_definitions WHERE assignee_group_id IS NOT NULL")
    for table in ("tasks", "task_definitions"):
        if table == "tasks" and "ix_task_group_due" in _indexes(table):
            op.drop_index("ix_task_group_due", table_name=table)
        index_name = f"ix_{table}_assignee_group_id"
        if index_name in _indexes(table):
            op.drop_index(index_name, table_name=table)
        with op.batch_alter_table(table) as batch:
            if "assignee_group_id" in _columns(table):
                foreign_key = f"fk_{table}_assignee_group_id_groups"
                if foreign_key in _foreign_key_names(table):
                    batch.drop_constraint(foreign_key, type_="foreignkey")
                batch.drop_column("assignee_group_id")
            if "assignee_id" in _columns(table):
                batch.alter_column("assignee_id", existing_type=sa.String(length=36), nullable=False)
