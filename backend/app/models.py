"""Durable SQLAlchemy entities for identity, access, SFTP, tasks, and audit."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return str(uuid4())


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(20), default="USER", index=True)
    state: Mapped[str] = mapped_column(String(24), default="PENDING_APPROVAL", index=True)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    version: Mapped[int] = mapped_column(Integer, default=1)


class Session(Base):
    __tablename__ = "sessions"

    id_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    csrf_hash: Mapped[str] = mapped_column(String(64))
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"

    id_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    source_ip: Mapped[str] = mapped_column(String(64))
    failure_count: Mapped[int] = mapped_column(Integer, default=0)
    window_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)


class Group(Base):
    __tablename__ = "groups"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    description: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    version: Mapped[int] = mapped_column(Integer, default=1)


class GroupMember(Base):
    __tablename__ = "group_members"
    __table_args__ = (UniqueConstraint("group_id", "user_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    group_id: Mapped[str] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)


class SftpServer(Base):
    __tablename__ = "sftp_servers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    description: Mapped[str] = mapped_column(String(500), default="")
    host: Mapped[str] = mapped_column(String(255))
    port: Mapped[int] = mapped_column(Integer, default=22)
    username: Mapped[str] = mapped_column(String(255), default="")
    auth_type: Mapped[str] = mapped_column(String(24), default="PASSWORD")
    encrypted_credential: Mapped[str | None] = mapped_column(Text, nullable=True)
    root_path: Mapped[str] = mapped_column(String(1024), default="/")
    host_key_fingerprint: Mapped[str] = mapped_column(String(255), default="")
    adapter_type: Mapped[str] = mapped_column(String(16), default="REAL")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    last_test: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    version: Mapped[int] = mapped_column(Integer, default=1)


class FolderGrant(Base):
    __tablename__ = "folder_grants"
    __table_args__ = (
        UniqueConstraint("principal_type", "principal_id", "server_id", "path", name="uq_grant_target"),
        Index("ix_grant_lookup", "server_id", "principal_type", "principal_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    principal_type: Mapped[str] = mapped_column(String(16))
    principal_id: Mapped[str] = mapped_column(String(36), index=True)
    server_id: Mapped[str] = mapped_column(ForeignKey("sftp_servers.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(1024))
    permissions: Mapped[list[str]] = mapped_column(JSON)
    recursive: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    version: Mapped[int] = mapped_column(Integer, default=1)


class FileUpload(Base):
    """Durable state for a resumable, SFTP-acknowledged file upload."""

    __tablename__ = "file_uploads"
    __table_args__ = (Index("ix_file_upload_owner", "user_id", "updated_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    server_id: Mapped[str] = mapped_column(ForeignKey("sftp_servers.id", ondelete="CASCADE"), index=True)
    folder_path: Mapped[str] = mapped_column(String(1024))
    filename: Mapped[str] = mapped_column(String(255))
    total_size: Mapped[int] = mapped_column(Integer)
    received_size: Mapped[int] = mapped_column(Integer, default=0)
    replace: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="ACTIVE", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class TaskDefinition(Base):
    """Reusable schedule which produces immutable task occurrence snapshots."""

    __tablename__ = "task_definitions"
    __table_args__ = (Index("ix_task_definition_next_run", "enabled", "next_run_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(200))
    instructions: Mapped[str] = mapped_column(Text, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    server_id: Mapped[str] = mapped_column(ForeignKey("sftp_servers.id", ondelete="CASCADE"), index=True)
    target_path: Mapped[str] = mapped_column(String(1024))
    assignee_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    schedule_type: Mapped[str] = mapped_column(String(16), default="ONCE")
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    weekdays: Mapped[list[int]] = mapped_column(JSON, default=list)
    month_day: Mapped[str | None] = mapped_column(String(16), nullable=True)
    due_offset_minutes: Mapped[int] = mapped_column(Integer, default=0)
    completion_mode: Mapped[str] = mapped_column(String(24), default="MANUAL")
    filename_glob: Mapped[str | None] = mapped_column(String(255), nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    last_generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    version: Mapped[int] = mapped_column(Integer, default=1)


class Task(Base):
    """One actionable occurrence generated from a task definition."""

    __tablename__ = "tasks"
    __table_args__ = (
        Index("ix_task_assignee_due", "assignee_id", "due_at"),
        UniqueConstraint("occurrence_key"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    definition_id: Mapped[str | None] = mapped_column(ForeignKey("task_definitions.id", ondelete="CASCADE"), nullable=True, index=True)
    occurrence_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    title: Mapped[str] = mapped_column(String(200))
    instructions: Mapped[str] = mapped_column(Text, default="")
    server_id: Mapped[str] = mapped_column(ForeignKey("sftp_servers.id", ondelete="RESTRICT"), index=True)
    target_path: Mapped[str] = mapped_column(String(1024))
    assignee_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[str] = mapped_column(String(20), default="PENDING", index=True)
    completion_mode: Mapped[str] = mapped_column(String(24), default="MANUAL")
    filename_glob: Mapped[str | None] = mapped_column(String(255), nullable=True)
    dismissal_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    version: Mapped[int] = mapped_column(Integer, default=1)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_timestamp", "timestamp"),
        Index("ix_audit_actor", "actor_id"),
        Index("ix_audit_server_path", "server_id", "path"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    request_id: Mapped[str] = mapped_column(String(64), index=True)
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    actor_display: Mapped[str] = mapped_column(String(320), default="anonymous")
    action: Mapped[str] = mapped_column(String(80), index=True)
    resource_type: Mapped[str] = mapped_column(String(50))
    resource_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    server_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    outcome: Mapped[str] = mapped_column(String(16), default="SUCCESS", index=True)
    source_ip: Mapped[str] = mapped_column(String(64), default="unknown")
    client_details: Mapped[str] = mapped_column(String(512), default="unknown")
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
