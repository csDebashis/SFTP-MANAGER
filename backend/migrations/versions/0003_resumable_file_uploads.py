"""Add durable resumable file-upload sessions."""

import sqlalchemy as sa
from alembic import op


revision = "0003_resumable_file_uploads"
down_revision = "0002_audit_request_details"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("file_uploads"):
        return
    op.create_table(
        "file_uploads",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("server_id", sa.String(length=36), nullable=False),
        sa.Column("folder_path", sa.String(length=1024), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("total_size", sa.Integer(), nullable=False),
        sa.Column("received_size", sa.Integer(), nullable=False),
        sa.Column("replace", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["server_id"], ["sftp_servers.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_file_uploads_server_id", "file_uploads", ["server_id"])
    op.create_index("ix_file_uploads_status", "file_uploads", ["status"])
    op.create_index("ix_file_uploads_user_id", "file_uploads", ["user_id"])
    op.create_index("ix_file_upload_owner", "file_uploads", ["user_id", "updated_at"])


def downgrade() -> None:
    if not sa.inspect(op.get_bind()).has_table("file_uploads"):
        return
    op.drop_index("ix_file_upload_owner", table_name="file_uploads")
    op.drop_index("ix_file_uploads_user_id", table_name="file_uploads")
    op.drop_index("ix_file_uploads_status", table_name="file_uploads")
    op.drop_index("ix_file_uploads_server_id", table_name="file_uploads")
    op.drop_table("file_uploads")
