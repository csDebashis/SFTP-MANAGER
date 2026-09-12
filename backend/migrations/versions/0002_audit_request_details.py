"""Persist source IP and client details for audit events."""

import sqlalchemy as sa
from alembic import op


revision = "0002_audit_request_details"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("audit_events")}
    if "source_ip" not in columns:
        op.add_column("audit_events", sa.Column("source_ip", sa.String(length=64), nullable=False, server_default="unknown"))
    if "client_details" not in columns:
        op.add_column("audit_events", sa.Column("client_details", sa.String(length=512), nullable=False, server_default="unknown"))


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("audit_events")}
    if "client_details" in columns:
        op.drop_column("audit_events", "client_details")
    if "source_ip" in columns:
        op.drop_column("audit_events", "source_ip")
