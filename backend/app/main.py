"""FastAPI application and HTTP use-case layer for SFTP Manager.

Routes in this module validate wire data and delegate remote file work to the
SFTP gateway. SQLite entities are always related by immutable UUIDs. Security
audit events and operational application logs are intentionally separate.
"""

import asyncio
import fnmatch
import hashlib
import logging
import os
import posixpath
import secrets
from time import perf_counter
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Literal
from uuid import uuid4

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .db import Database
from .logging_config import configure_logging
from .models import AuditEvent, FileUpload, FolderGrant, Group, GroupMember, LoginAttempt, Session, SftpServer, Task, User, utc_now
from .security import create_session_tokens, encrypt_credential, hash_password, token_hash, verify_password
from .sftp.gateway import SftpGateway, canonical_path, seed_mock_files, valid_name


ALL_PERMISSIONS = {"LIST", "DOWNLOAD", "UPLOAD", "CREATE_FOLDER", "RENAME", "MOVE", "DELETE", "MANAGE_TASKS"}
WRITE_PERMISSIONS = {"UPLOAD", "CREATE_FOLDER", "RENAME", "MOVE", "DELETE", "MANAGE_TASKS"}
ROLES = {"ADMIN", "MANAGER", "USER", "AUDITOR"}
USER_STATES = {"PENDING_APPROVAL", "ACTIVE", "SUSPENDED", "REJECTED"}
VALIDATION_FIELD_LABELS = {
    "path": "Folder path",
    "rootPath": "Remote root",
    "targetPath": "Target path",
}


def as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def readable_validation_error(error: dict[str, Any]) -> str:
    location = [str(part) for part in error.get("loc", ()) if part not in {"body", "query"}]
    field = location[-1] if location else "value"
    label = VALIDATION_FIELD_LABELS.get(field, field.replace("_", " ").capitalize())
    message = str(error.get("msg") or "Invalid value")
    if message.lower().startswith("value error, "):
        message = message[len("value error, "):]
    if message == "invalid absolute POSIX path":
        return f'{label} must start with "/" and use an absolute POSIX path.'
    return f"{label}: {message}"


def user_json(user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "email": user.email,
        "displayName": user.display_name,
        "role": user.role,
        "state": user.state,
        "timezone": user.timezone,
        "createdAt": as_utc(user.created_at).isoformat(),
        "version": user.version,
    }


def server_json(server: SftpServer) -> dict[str, Any]:
    return {
        "id": server.id,
        "name": server.name,
        "description": server.description,
        "host": server.host,
        "port": server.port,
        "username": server.username,
        "authType": server.auth_type,
        "rootPath": server.root_path,
        "hostKeyFingerprint": server.host_key_fingerprint,
        "adapterType": server.adapter_type,
        "enabled": server.enabled,
        "credentialConfigured": bool(server.encrypted_credential) or server.adapter_type == "MOCK",
        "lastTest": server.last_test,
        "version": server.version,
    }


def grant_json(
    grant: FolderGrant,
    *,
    principal_name: str | None = None,
    server_name: str | None = None,
) -> dict[str, Any]:
    return {
        "id": grant.id,
        "principalType": grant.principal_type,
        "principalId": grant.principal_id,
        "principalName": principal_name,
        "serverId": grant.server_id,
        "serverName": server_name,
        "path": grant.path,
        "permissions": grant.permissions,
        "recursive": grant.recursive,
        "version": grant.version,
    }


def task_json(task: Task) -> dict[str, Any]:
    effective_status = task.status
    if task.status in {"PENDING", "IN_PROGRESS"} and as_utc(task.due_at) < utc_now():
        effective_status = "OVERDUE"
    return {
        "id": task.id,
        "title": task.title,
        "instructions": task.instructions,
        "serverId": task.server_id,
        "targetPath": task.target_path,
        "assigneeId": task.assignee_id,
        "createdBy": task.created_by,
        "dueAt": as_utc(task.due_at).isoformat(),
        "status": effective_status,
        "completionMode": task.completion_mode,
        "filenameGlob": task.filename_glob,
        "dismissalReason": task.dismissal_reason,
        "version": task.version,
    }


def upload_json(upload: FileUpload, *, chunk_size: int) -> dict[str, Any]:
    target = canonical_path(posixpath.join(upload.folder_path, upload.filename))
    return {
        "uploadId": upload.id,
        "serverId": upload.server_id,
        "path": upload.folder_path,
        "fileName": upload.filename,
        "totalBytes": upload.total_size,
        "receivedBytes": upload.received_size,
        "percent": 100 if upload.total_size == 0 else min(100, round(upload.received_size * 100 / upload.total_size)),
        "chunkSize": chunk_size,
        "status": upload.status,
        "targetPath": target if upload.status == "COMPLETED" else None,
    }


def audit_json(
    event: AuditEvent,
    server_name: str | None = None,
    *,
    include_request_metadata: bool = False,
) -> dict[str, Any]:
    item_name = posixpath.basename(event.path) if event.path and event.path != "/" and event.resource_type in {"file", "item"} else None
    folder_path = None
    if event.path:
        folder_path = canonical_path(posixpath.dirname(event.path)) if item_name else event.path
    result = {
        "id": event.id,
        "timestamp": as_utc(event.timestamp).isoformat(),
        "requestId": event.request_id,
        "actorId": event.actor_id,
        "actorDisplay": event.actor_display,
        "action": event.action,
        "resourceType": event.resource_type,
        "resourceId": event.resource_id,
        "serverId": event.server_id,
        "serverName": server_name or event.detail.get("serverName"),
        "path": event.path,
        "itemName": item_name,
        "folderPath": folder_path,
        "outcome": event.outcome,
        "detail": event.detail,
    }
    if include_request_metadata:
        result["sourceIp"] = event.source_ip
        result["clientDetails"] = event.client_details
    return result


class SignupInput(BaseModel):
    display_name: str = Field(alias="displayName", min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=12, max_length=256)


class LoginInput(BaseModel):
    email: EmailStr
    password: str


class PasswordChangeInput(BaseModel):
    current_password: str = Field(alias="currentPassword", max_length=256)
    new_password: str = Field(alias="newPassword", min_length=12, max_length=256)


class UserUpdate(BaseModel):
    role: str | None = None
    state: str | None = None
    email: EmailStr | None = None
    display_name: str | None = Field(default=None, alias="displayName", min_length=2, max_length=120)

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if len(value) < 2:
            raise ValueError("Display name must contain at least 2 non-whitespace characters")
        return value


class GroupInput(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    description: str = Field(default="", max_length=500)
    member_ids: list[str] = Field(default_factory=list, alias="memberIds")


class ServerInput(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=500)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="", max_length=255)
    auth_type: Literal["PASSWORD", "PRIVATE_KEY"] = Field(default="PASSWORD", alias="authType")
    password: str | None = None
    private_key: str | None = Field(default=None, alias="privateKey")
    passphrase: str | None = None
    root_path: str = Field(default="/", alias="rootPath")
    adapter_type: Literal["REAL", "MOCK"] = Field(default="REAL", alias="adapterType")
    enabled: bool = True

    @field_validator("root_path")
    @classmethod
    def validate_root(cls, value: str) -> str:
        return canonical_path(value)


class CredentialInput(BaseModel):
    auth_type: Literal["PASSWORD", "PRIVATE_KEY"] = Field(alias="authType")
    password: str | None = None
    private_key: str | None = Field(default=None, alias="privateKey")
    passphrase: str | None = None


class GrantInput(BaseModel):
    principal_type: Literal["USER", "GROUP"] = Field(alias="principalType")
    principal_id: str = Field(alias="principalId")
    server_id: str = Field(alias="serverId")
    path: str
    permissions: list[str]
    recursive: bool = True

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        return canonical_path(value)

    @field_validator("permissions")
    @classmethod
    def validate_permissions(cls, value: list[str]) -> list[str]:
        result = sorted(set(value))
        if not result or not set(result).issubset(ALL_PERMISSIONS):
            raise ValueError("permissions must be a non-empty supported set")
        return result


class FolderInput(BaseModel):
    server_id: str = Field(alias="serverId")
    parent: str
    name: str


class RenameInput(BaseModel):
    server_id: str = Field(alias="serverId")
    path: str
    name: str


class MoveInput(BaseModel):
    server_id: str = Field(alias="serverId")
    source: str
    destination: str


class UploadStartInput(BaseModel):
    server_id: str = Field(alias="serverId")
    path: str
    file_name: str = Field(alias="fileName")
    size: int = Field(ge=0)
    replace: bool = False

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        return canonical_path(value)

    @field_validator("file_name")
    @classmethod
    def validate_file_name(cls, value: str) -> str:
        return valid_name(value)


class TaskInput(BaseModel):
    title: str = Field(min_length=2, max_length=200)
    instructions: str = Field(default="", max_length=5000)
    server_id: str = Field(alias="serverId")
    target_path: str = Field(alias="targetPath")
    assignee_id: str = Field(alias="assigneeId")
    due_at: datetime = Field(alias="dueAt")
    completion_mode: Literal["MANUAL", "MATCHING_UPLOAD"] = Field(default="MANUAL", alias="completionMode")
    filename_glob: str | None = Field(default=None, alias="filenameGlob", max_length=255)

    @field_validator("target_path")
    @classmethod
    def validate_target(cls, value: str) -> str:
        return canonical_path(value)


class DismissInput(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class AuthContext:
    def __init__(self, user: User, session: Session):
        self.user = user
        self.session = session


async def add_audit(
    db: AsyncSession,
    request: Request,
    action: str,
    resource_type: str,
    *,
    actor: User | None = None,
    resource_id: str | None = None,
    server_id: str | None = None,
    path: str | None = None,
    outcome: str = "SUCCESS",
    detail: dict[str, Any] | None = None,
) -> None:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    source_ip = (forwarded_for.split(",", 1)[0].strip() if forwarded_for else (request.client.host if request.client else "unknown"))[:64] or "unknown"
    client_details = request.headers.get("user-agent", "unknown").strip()[:512] or "unknown"
    db.add(
        AuditEvent(
            request_id=getattr(request.state, "request_id", "system"),
            actor_id=actor.id if actor else None,
            actor_display=actor.email if actor else "anonymous",
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            server_id=server_id,
            path=path,
            outcome=outcome,
            source_ip=source_ip,
            client_details=client_details,
            detail=detail or {},
        )
    )


async def seed_demo_data(app: FastAPI) -> None:
    if not app.state.seed_demo:
        return
    async with app.state.database.sessions() as db:
        existing = await db.scalar(select(User.id).where(User.email == "admin@gmail.com"))
        if existing:
            return
        admin = User(
            email="admin@gmail.com",
            display_name="Mock Administrator",
            password_hash=hash_password(os.getenv("MOCK_ADMIN_PASSWORD", "Admin123!Secure")),
            role="ADMIN",
            state="ACTIVE",
        )
        mock_user = User(
            email="user@gmail.com",
            display_name="Mock User",
            password_hash=hash_password(os.getenv("MOCK_USER_PASSWORD", "User123!Secure")),
            role="USER",
            state="ACTIVE",
        )
        db.add_all([admin, mock_user])
        await db.flush()
        server = SftpServer(
            name="Mock SFTP",
            description="Local deterministic SFTP workspace for development and validation",
            host="mock.local",
            port=22,
            username="mock",
            adapter_type="MOCK",
            root_path="/",
            host_key_fingerprint="mock-local",
            enabled=True,
        )
        db.add(server)
        await db.flush()
        db.add(
            FolderGrant(
                principal_type="USER",
                principal_id=mock_user.id,
                server_id=server.id,
                path="/",
                permissions=sorted(ALL_PERMISSIONS - {"MANAGE_TASKS"}),
                recursive=True,
            )
        )
        db.add(
            Task(
                title="Upload month-end reconciliation",
                instructions="Upload the completed reconciliation CSV into the month-end folder.",
                server_id=server.id,
                target_path="/finance/month-end",
                assignee_id=mock_user.id,
                created_by=admin.id,
                due_at=utc_now() + timedelta(days=3),
                completion_mode="MATCHING_UPLOAD",
                filename_glob="reconciliation-*.csv",
            )
        )
        await db.commit()
    seed_mock_files(app.state.gateway.mock_root)


async def bootstrap_admin(app: FastAPI) -> None:
    """Create the first durable administrator when demo seeding is disabled."""
    if app.state.seed_demo:
        return
    async with app.state.database.sessions() as db:
        if await db.scalar(select(User.id).where(User.role == "ADMIN", User.state == "ACTIVE").limit(1)):
            return
        email = os.getenv("BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
        password_file = os.getenv("BOOTSTRAP_ADMIN_PASSWORD_FILE", "").strip()
        if not email or not password_file:
            if os.getenv("APP_ENV", "development") == "production":
                raise RuntimeError("BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD_FILE are required for first startup")
            return
        password_path = Path(password_file)
        if not password_path.is_file():
            raise RuntimeError("BOOTSTRAP_ADMIN_PASSWORD_FILE does not exist")
        password = password_path.read_text(encoding="utf-8").strip()
        if len(password) < 12:
            raise RuntimeError("bootstrap administrator password must be at least 12 characters")
        admin = User(email=email, display_name="Administrator", password_hash=hash_password(password), role="ADMIN", state="ACTIVE")
        db.add(admin)
        await db.flush()
        db.add(AuditEvent(request_id="bootstrap", actor_id=admin.id, actor_display=admin.email, action="USER_BOOTSTRAP", resource_type="user", resource_id=admin.id, outcome="SUCCESS", detail={}))
        await db.commit()


async def mark_overdue(app: FastAPI) -> None:
    async with app.state.database.sessions() as db:
        tasks = (await db.scalars(select(Task).where(Task.status.in_(["PENDING", "IN_PROGRESS"]), Task.due_at < utc_now()))).all()
        for task in tasks:
            task.status = "OVERDUE"
            task.version += 1
        if tasks:
            await db.commit()


def create_app(
    database_url: str | None = None,
    mock_root: str | Path | None = None,
    seed_demo: bool | None = None,
    log_directory: str | Path | None = None,
) -> FastAPI:
    """Build an isolated application instance and its process-local services."""

    database_url = database_url or os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./sftp-manager.db")
    mock_root_path = Path(mock_root or os.getenv("MOCK_SFTP_ROOT", "./mock-sftp"))
    if seed_demo is None:
        seed_demo = os.getenv("SEED_DEMO_USERS", "true").lower() == "true"
    logger = configure_logging(log_directory)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logger.info("Application startup beginning", extra={"event": "application.startup.begin"})
        await app.state.database.initialize()
        await seed_demo_data(app)
        await bootstrap_admin(app)
        scheduler = AsyncIOScheduler(timezone="UTC")
        scheduler.add_job(mark_overdue, "interval", minutes=1, args=[app], id="overdue", replace_existing=True)
        scheduler.start()
        app.state.scheduler = scheduler
        if app.state.seed_demo:
            logger.warning("Demo-user seeding is enabled", extra={"event": "application.demo_mode.enabled"})
        logger.info("Application startup complete", extra={"event": "application.startup.complete"})
        yield
        logger.info("Application shutdown beginning", extra={"event": "application.shutdown.begin"})
        scheduler.shutdown(wait=False)
        await app.state.database.close()
        logger.info("Application shutdown complete", extra={"event": "application.shutdown.complete"})

    app = FastAPI(title="SFTP Manager API", version="0.1.0", lifespan=lifespan)
    app.state.database = Database(database_url)
    app.state.gateway = SftpGateway(mock_root_path)
    app.state.logger = logger
    app.state.seed_demo = seed_demo
    app.state.upload_locks = {}
    app.state.upload_target_locks = {}

    @app.exception_handler(RequestValidationError)
    async def request_validation_exception_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
        messages = [readable_validation_error(error) for error in exc.errors()]
        return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, content={"detail": "; ".join(messages)})

    origins = [value.strip() for value in os.getenv("TRUSTED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if value.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
        request.state.request_id = (request.headers.get("X-Request-ID") or uuid4().hex)[:64]
        started_at = perf_counter()
        logger.debug(
            "HTTP request started",
            extra={
                "event": "http.request.started",
                "request_id": request.state.request_id,
                "method": request.method,
            },
        )
        try:
            response = await call_next(request)
        except Exception as exc:
            # Deliberately omit the exception message and traceback: third-party
            # SFTP errors can contain server banners or credential-adjacent data.
            logger.error(
                "Unhandled HTTP request failure",
                extra={
                    "event": "http.request.failed",
                    "request_id": request.state.request_id,
                    "method": request.method,
                    "route": getattr(request.scope.get("route"), "path", "unmatched"),
                    "duration_ms": round((perf_counter() - started_at) * 1000, 2),
                    "error_type": type(exc).__name__,
                },
            )
            raise
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        status_code = response.status_code
        severity = logging.ERROR if status_code >= 500 else logging.WARNING if status_code >= 400 else logging.INFO
        logger.log(
            severity,
            "HTTP request completed",
            extra={
                "event": "http.request.completed",
                "request_id": request.state.request_id,
                "method": request.method,
                "route": getattr(request.scope.get("route"), "path", "unmatched"),
                "status_code": status_code,
                "duration_ms": round((perf_counter() - started_at) * 1000, 2),
            },
        )
        return response

    async def get_db(request: Request):  # type: ignore[no-untyped-def]
        async for db in request.app.state.database.session():
            yield db

    Db = Annotated[AsyncSession, Depends(get_db)]

    async def current_auth(request: Request, db: Db) -> AuthContext:
        raw = request.cookies.get("sftp_session")
        if not raw:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authentication required")
        session = await db.get(Session, token_hash(raw))
        now = utc_now()
        idle_minutes = max(1, int(os.getenv("SESSION_IDLE_MINUTES", "30")))
        if not session or as_utc(session.expires_at) <= now or as_utc(session.last_used_at) <= now - timedelta(minutes=idle_minutes):
            if session:
                await db.delete(session)
                await db.commit()
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
        user = await db.get(User, session.user_id)
        if not user or user.state not in {"ACTIVE", "PENDING_APPROVAL"}:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authentication required")
        session.last_used_at = now
        await db.commit()
        return AuthContext(user, session)

    Auth = Annotated[AuthContext, Depends(current_auth)]

    async def csrf_auth(
        auth: Auth,
        x_csrf_token: Annotated[str | None, Header(alias="X-CSRF-Token")] = None,
    ) -> AuthContext:
        if not x_csrf_token or not secrets.compare_digest(token_hash(x_csrf_token), auth.session.csrf_hash):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid CSRF token")
        return auth

    CsrfAuth = Annotated[AuthContext, Depends(csrf_auth)]

    def require_active(auth: AuthContext) -> None:
        if auth.user.state != "ACTIVE":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Account is awaiting approval")

    def require_admin(auth: AuthContext) -> None:
        require_active(auth)
        if auth.user.role != "ADMIN":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Administrator access required")

    async def get_server(db: AsyncSession, server_id: str) -> SftpServer:
        server = await db.get(SftpServer, server_id)
        if not server or not server.enabled:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "SFTP server not found")
        return server

    async def effective_permissions(db: AsyncSession, user: User, server_id: str, path: str) -> set[str]:
        if user.role == "ADMIN":
            return set(ALL_PERMISSIONS)
        path = canonical_path(path)
        group_ids = list(await db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user.id)))
        conditions = [
            (FolderGrant.principal_type == "USER") & (FolderGrant.principal_id == user.id),
        ]
        if group_ids:
            conditions.append((FolderGrant.principal_type == "GROUP") & FolderGrant.principal_id.in_(group_ids))
        grants = (await db.scalars(select(FolderGrant).where(FolderGrant.server_id == server_id, or_(*conditions)))).all()
        permissions: set[str] = set()
        for grant in grants:
            applies = path == grant.path or (grant.recursive and (grant.path == "/" or path.startswith(f"{grant.path.rstrip('/')}/")))
            if applies:
                permissions.update(grant.permissions)
        if user.role == "AUDITOR":
            permissions.difference_update(WRITE_PERMISSIONS)
        return permissions

    async def require_permission(
        db: AsyncSession,
        request: Request,
        auth: AuthContext,
        server_id: str,
        path: str,
        permission: str,
    ) -> SftpServer:
        require_active(auth)
        path = canonical_path(path)
        server = await get_server(db, server_id)
        if permission not in await effective_permissions(db, auth.user, server_id, path):
            await add_audit(db, request, "AUTHORIZATION_DENIED", "folder", actor=auth.user, server_id=server_id, path=path, outcome="DENIED", detail={"permission": permission})
            await db.commit()
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Folder access denied")
        return server

    @app.get("/api/v1/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/health/ready")
    async def ready(db: Db) -> dict[str, str]:
        await db.scalar(select(User.id).limit(1))
        return {"status": "ready"}

    @app.post("/api/v1/auth/signup", status_code=201)
    async def signup(payload: SignupInput, request: Request, db: Db) -> dict[str, str]:
        email = str(payload.email).strip().lower()
        if await db.scalar(select(User.id).where(User.email == email)):
            return {"message": "If eligible, your request is awaiting approval."}
        user = User(email=email, display_name=payload.display_name.strip(), password_hash=hash_password(payload.password))
        db.add(user)
        await db.flush()
        await add_audit(db, request, "USER_SIGNUP", "user", actor=user, resource_id=user.id)
        await db.commit()
        return {"message": "Your account request is awaiting administrator approval."}

    @app.post("/api/v1/auth/login")
    async def login(payload: LoginInput, request: Request, response: Response, db: Db) -> dict[str, Any]:
        email = str(payload.email).strip().lower()
        source_ip = request.client.host if request.client else "unknown"
        attempt_id = token_hash(f"{email}|{source_ip}")
        attempt = await db.get(LoginAttempt, attempt_id)
        now = utc_now()
        user = await db.scalar(select(User).where(User.email == email))
        if attempt and attempt.locked_until and as_utc(attempt.locked_until) > now:
            await add_audit(db, request, "LOGIN_RATE_LIMIT", "session", actor=user, outcome="DENIED")
            await db.commit()
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many sign-in attempts. Try again later.")
        if not user or not verify_password(user.password_hash, payload.password) or user.state in {"SUSPENDED", "REJECTED"}:
            if not attempt:
                attempt = LoginAttempt(id_hash=attempt_id, email=email, source_ip=source_ip, failure_count=0, window_started_at=now)
                db.add(attempt)
            elif as_utc(attempt.window_started_at) <= now - timedelta(minutes=15):
                attempt.failure_count = 0
                attempt.window_started_at = now
                attempt.locked_until = None
            attempt.failure_count += 1
            if attempt.failure_count >= 5:
                attempt.locked_until = now + timedelta(minutes=15)
            await add_audit(db, request, "LOGIN", "session", actor=user, outcome="FAILURE")
            await db.commit()
            if attempt.locked_until:
                raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many sign-in attempts. Try again later.")
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
        if attempt:
            await db.delete(attempt)
        raw_session, csrf, expires = create_session_tokens()
        db.add(Session(id_hash=token_hash(raw_session), user_id=user.id, csrf_hash=token_hash(csrf), expires_at=expires))
        await add_audit(db, request, "LOGIN", "session", actor=user)
        await db.commit()
        secure_cookie = os.getenv("COOKIE_SECURE", "false").lower() == "true"
        response.set_cookie("sftp_session", raw_session, httponly=True, secure=secure_cookie, samesite="lax", max_age=28800, path="/")
        response.set_cookie("sftp_csrf", csrf, httponly=False, secure=secure_cookie, samesite="lax", max_age=28800, path="/")
        return {"user": user_json(user), "csrfToken": csrf}

    @app.post("/api/v1/auth/logout")
    async def logout(request: Request, response: Response, auth: CsrfAuth, db: Db) -> dict[str, str]:
        await db.delete(auth.session)
        await add_audit(db, request, "LOGOUT", "session", actor=auth.user)
        await db.commit()
        response.delete_cookie("sftp_session", path="/")
        response.delete_cookie("sftp_csrf", path="/")
        return {"message": "Signed out"}

    @app.get("/api/v1/auth/me")
    async def me(auth: Auth) -> dict[str, Any]:
        return {"user": user_json(auth.user)}

    @app.post("/api/v1/auth/password/change")
    async def change_password(payload: PasswordChangeInput, request: Request, response: Response, auth: CsrfAuth, db: Db) -> dict[str, str]:
        require_active(auth)
        if not verify_password(auth.user.password_hash, payload.current_password):
            await add_audit(db, request, "PASSWORD_CHANGE", "user", actor=auth.user, resource_id=auth.user.id, outcome="FAILURE")
            await db.commit()
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
        if verify_password(auth.user.password_hash, payload.new_password):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "New password must be different")
        auth.user.password_hash = hash_password(payload.new_password)
        auth.user.version += 1
        await db.execute(delete(Session).where(Session.user_id == auth.user.id))
        await add_audit(db, request, "PASSWORD_CHANGE", "user", actor=auth.user, resource_id=auth.user.id)
        await db.commit()
        response.delete_cookie("sftp_session", path="/")
        response.delete_cookie("sftp_csrf", path="/")
        return {"message": "Password changed. Sign in again."}

    @app.get("/api/v1/users")
    async def list_users(auth: Auth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        users = (await db.scalars(select(User).order_by(User.created_at.desc()))).all()
        return {"items": [user_json(user) for user in users]}

    @app.patch("/api/v1/users/{user_id}")
    async def update_user(user_id: str, payload: UserUpdate, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        is_admin = auth.user.role == "ADMIN"
        if not is_admin and auth.user.id != user_id:
            raise HTTPException(403, "You may update only your own profile")
        user = await db.get(User, user_id)
        if not user:
            raise HTTPException(404, "User not found")
        if is_admin:
            require_admin(auth)
        else:
            require_active(auth)
            if payload.model_fields_set.intersection({"role", "state"}):
                raise HTTPException(403, "Only an administrator may change roles or account state")
        role = payload.role.upper() if payload.role else user.role
        state_value = payload.state.upper() if payload.state else user.state
        if role not in ROLES:
            raise HTTPException(422, "Unsupported role")
        if state_value not in USER_STATES:
            raise HTTPException(422, "Unsupported state")
        if user.role == "ADMIN" and user.state == "ACTIVE" and (role != "ADMIN" or state_value != "ACTIVE"):
            active_admins = await db.scalar(select(User.id).where(User.role == "ADMIN", User.state == "ACTIVE", User.id != user.id).limit(1))
            if not active_admins:
                raise HTTPException(409, "The last active administrator cannot be demoted or disabled")
        new_email = str(payload.email).strip().lower() if payload.email is not None else user.email
        if new_email != user.email:
            email_owner = await db.scalar(select(User.id).where(User.email == new_email, User.id != user.id).limit(1))
            if email_owner:
                raise HTTPException(409, "Email address is already in use")
        old_email = user.email
        role_changed = role != user.role
        state_changed = state_value != user.state
        privileges_changed = role_changed or state_changed
        changed_fields: list[str] = []
        if new_email != user.email:
            user.email = new_email
            changed_fields.append("email")
        if role_changed:
            changed_fields.append("role")
        if state_changed:
            changed_fields.append("state")
        user.role, user.state = role, state_value
        if payload.display_name is not None and payload.display_name != user.display_name:
            user.display_name = payload.display_name
            changed_fields.append("displayName")
        user.version += 1
        if privileges_changed:
            await db.execute(delete(Session).where(Session.user_id == user.id))
        if new_email != old_email:
            await db.execute(delete(LoginAttempt).where(LoginAttempt.email.in_([old_email, new_email])))
        await add_audit(
            db,
            request,
            "USER_UPDATE",
            "user",
            actor=auth.user,
            resource_id=user.id,
            detail={"userId": user.id, "changedFields": changed_fields, "role": user.role, "state": user.state},
        )
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(409, "Email address is already in use") from None
        return user_json(user)

    @app.post("/api/v1/users/{user_id}/approve")
    async def approve_user(user_id: str, payload: UserUpdate, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        user = await db.get(User, user_id)
        if not user:
            raise HTTPException(404, "User not found")
        role = (payload.role or "USER").upper()
        if role not in ROLES:
            raise HTTPException(422, "Unsupported role")
        user.role, user.state, user.version = role, "ACTIVE", user.version + 1
        await add_audit(db, request, "USER_APPROVE", "user", actor=auth.user, resource_id=user.id, detail={"role": role})
        await db.commit()
        return user_json(user)

    @app.post("/api/v1/users/{user_id}/reject")
    async def reject_user(user_id: str, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        user = await db.get(User, user_id)
        if not user:
            raise HTTPException(404, "User not found")
        if user.role == "ADMIN" and user.state == "ACTIVE":
            raise HTTPException(409, "An active administrator cannot be rejected")
        user.state, user.version = "REJECTED", user.version + 1
        await db.execute(delete(Session).where(Session.user_id == user.id))
        await add_audit(db, request, "USER_REJECT", "user", actor=auth.user, resource_id=user.id)
        await db.commit()
        return user_json(user)

    @app.post("/api/v1/users/{user_id}/revoke-sessions")
    async def revoke_user_sessions(user_id: str, request: Request, auth: CsrfAuth, db: Db) -> dict[str, str]:
        require_admin(auth)
        user = await db.get(User, user_id)
        if not user:
            raise HTTPException(404, "User not found")
        await db.execute(delete(Session).where(Session.user_id == user.id))
        await add_audit(db, request, "SESSION_REVOKE_ALL", "user", actor=auth.user, resource_id=user.id)
        await db.commit()
        return {"message": "Sessions revoked"}

    @app.get("/api/v1/groups")
    async def list_groups(auth: Auth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        groups = (await db.scalars(select(Group).order_by(Group.name))).all()
        result = []
        for group in groups:
            members = list(await db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == group.id)))
            result.append({"id": group.id, "name": group.name, "description": group.description, "memberIds": members, "version": group.version})
        return {"items": result}

    @app.post("/api/v1/groups", status_code=201)
    async def create_group(payload: GroupInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        group = Group(name=payload.name.strip(), description=payload.description.strip())
        db.add(group)
        try:
            await db.flush()
            db.add_all([GroupMember(group_id=group.id, user_id=user_id) for user_id in set(payload.member_ids)])
            await add_audit(
                db,
                request,
                "GROUP_CREATE",
                "group",
                actor=auth.user,
                resource_id=group.id,
                detail={"groupName": group.name, "memberIds": sorted(set(payload.member_ids))},
            )
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(409, "Group already exists")
        return {"id": group.id, "name": group.name, "description": group.description, "memberIds": payload.member_ids, "version": group.version}

    @app.patch("/api/v1/groups/{group_id}")
    async def update_group(group_id: str, payload: GroupInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        group = await db.get(Group, group_id)
        if not group:
            raise HTTPException(404, "Group not found")
        group.name, group.description, group.version = payload.name.strip(), payload.description.strip(), group.version + 1
        await db.execute(delete(GroupMember).where(GroupMember.group_id == group.id))
        db.add_all([GroupMember(group_id=group.id, user_id=user_id) for user_id in set(payload.member_ids)])
        await add_audit(
            db,
            request,
            "GROUP_UPDATE",
            "group",
            actor=auth.user,
            resource_id=group.id,
            detail={"groupName": group.name, "memberIds": sorted(set(payload.member_ids))},
        )
        await db.commit()
        return {"id": group.id, "name": group.name, "description": group.description, "memberIds": payload.member_ids, "version": group.version}

    @app.delete("/api/v1/groups/{group_id}", status_code=204)
    async def remove_group(group_id: str, request: Request, auth: CsrfAuth, db: Db) -> Response:
        require_admin(auth)
        group = await db.get(Group, group_id)
        if not group:
            raise HTTPException(404, "Group not found")
        await db.execute(delete(FolderGrant).where(FolderGrant.principal_type == "GROUP", FolderGrant.principal_id == group_id))
        await db.delete(group)
        await add_audit(db, request, "GROUP_DELETE", "group", actor=auth.user, resource_id=group_id, detail={"groupName": group.name})
        await db.commit()
        return Response(status_code=204)

    @app.get("/api/v1/sftp-servers")
    async def list_servers(auth: Auth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        servers = (await db.scalars(select(SftpServer).order_by(SftpServer.name))).all()
        return {"items": [server_json(item) for item in servers]}

    @app.post("/api/v1/sftp-servers", status_code=201)
    async def create_server(payload: ServerInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        if await db.scalar(select(SftpServer.id).where(SftpServer.name == payload.name.strip()).limit(1)):
            raise HTTPException(409, "A server with this name already exists")
        credential = None
        if payload.adapter_type == "REAL":
            secret_data = {"password": payload.password} if payload.auth_type == "PASSWORD" else {"privateKey": payload.private_key, "passphrase": payload.passphrase}
            if not (payload.password if payload.auth_type == "PASSWORD" else payload.private_key):
                raise HTTPException(422, "Credential is required")
            credential = encrypt_credential(secret_data)
        server = SftpServer(
            name=payload.name.strip(), description=payload.description.strip(), host=payload.host.strip(), port=payload.port,
            username=payload.username.strip(), auth_type=payload.auth_type, encrypted_credential=credential,
            root_path=payload.root_path, host_key_fingerprint="",
            adapter_type=payload.adapter_type, enabled=payload.enabled,
        )
        result = await request.app.state.gateway.test(server, discover_host_key=True)
        if not result["success"] or not result.get("fingerprint"):
            await add_audit(
                db,
                request,
                "SERVER_CREATE_CONNECTION_FAILED",
                "sftp_server",
                actor=auth.user,
                outcome="FAILURE",
                detail={"host": payload.host.strip(), "port": payload.port, "errorCode": result.get("message", "SFTP_UNAVAILABLE")},
            )
            await db.commit()
            raise HTTPException(502, f"Unable to connect to the SFTP server ({result.get('message', 'SFTP_UNAVAILABLE')})")
        server.host_key_fingerprint = str(result["fingerprint"])
        server.last_test = {**result, "testedAt": utc_now().isoformat()}
        db.add(server)
        try:
            await db.flush()
            await add_audit(db, request, "SERVER_CREATE", "sftp_server", actor=auth.user, resource_id=server.id)
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(409, "A server with this name already exists")
        return server_json(server)

    @app.post("/api/v1/sftp-servers/test")
    async def test_unsaved_server(payload: ServerInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        credential = None
        if payload.adapter_type == "REAL":
            supplied = payload.password if payload.auth_type == "PASSWORD" else payload.private_key
            if not supplied:
                raise HTTPException(422, "Credential is required for a connection test")
            credential = encrypt_credential({"password": payload.password} if payload.auth_type == "PASSWORD" else {"privateKey": payload.private_key, "passphrase": payload.passphrase})
        transient = SftpServer(
            name=payload.name.strip(), description=payload.description.strip(), host=payload.host.strip(), port=payload.port,
            username=payload.username.strip(), auth_type=payload.auth_type, encrypted_credential=credential,
            root_path=payload.root_path, host_key_fingerprint="", adapter_type=payload.adapter_type,
            enabled=True,
        )
        result = await request.app.state.gateway.test(transient, discover_host_key=True)
        await add_audit(db, request, "SERVER_TEST_UNSAVED", "sftp_server", actor=auth.user, outcome="SUCCESS" if result["success"] else "FAILURE", detail={"host": payload.host.strip(), "port": payload.port})
        await db.commit()
        return result

    @app.post("/api/v1/sftp-servers/{server_id}/test")
    async def test_server(server_id: str, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        server = await db.get(SftpServer, server_id)
        if not server:
            raise HTTPException(404, "Server not found")
        result = await request.app.state.gateway.test(server)
        server.last_test = {**result, "testedAt": utc_now().isoformat()}
        server.version += 1
        await add_audit(db, request, "SERVER_TEST", "sftp_server", actor=auth.user, resource_id=server.id, outcome="SUCCESS" if result["success"] else "FAILURE")
        await db.commit()
        return result

    @app.patch("/api/v1/sftp-servers/{server_id}")
    async def update_server(server_id: str, payload: ServerInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        server = await db.get(SftpServer, server_id)
        if not server:
            raise HTTPException(404, "Server not found")
        supplied_credential = payload.password if payload.auth_type == "PASSWORD" else payload.private_key
        encrypted_credential = server.encrypted_credential
        if supplied_credential:
            data = {"password": payload.password} if payload.auth_type == "PASSWORD" else {"privateKey": payload.private_key, "passphrase": payload.passphrase}
            encrypted_credential = encrypt_credential(data)
        elif payload.adapter_type == "REAL" and (not encrypted_credential or payload.auth_type != server.auth_type):
            raise HTTPException(422, "Credential is required")

        connection_changed = any((
            payload.host.strip() != server.host,
            payload.port != server.port,
            payload.username.strip() != server.username,
            payload.auth_type != server.auth_type,
            payload.adapter_type != server.adapter_type,
            bool(supplied_credential),
        ))
        fingerprint = server.host_key_fingerprint
        last_test = server.last_test
        if connection_changed:
            transient = SftpServer(
                name=payload.name.strip(), description=payload.description.strip(), host=payload.host.strip(), port=payload.port,
                username=payload.username.strip(), auth_type=payload.auth_type, encrypted_credential=encrypted_credential,
                root_path=payload.root_path, host_key_fingerprint="", adapter_type=payload.adapter_type,
                enabled=payload.enabled,
            )
            result = await request.app.state.gateway.test(transient, discover_host_key=True)
            if not result["success"] or not result.get("fingerprint"):
                await add_audit(
                    db,
                    request,
                    "SERVER_UPDATE_CONNECTION_FAILED",
                    "sftp_server",
                    actor=auth.user,
                    resource_id=server.id,
                    outcome="FAILURE",
                    detail={"host": payload.host.strip(), "port": payload.port, "errorCode": result.get("message", "SFTP_UNAVAILABLE")},
                )
                await db.commit()
                raise HTTPException(502, f"Unable to connect to the SFTP server ({result.get('message', 'SFTP_UNAVAILABLE')})")
            fingerprint = str(result["fingerprint"])
            last_test = {**result, "testedAt": utc_now().isoformat()}

        server.name, server.description, server.host, server.port = payload.name.strip(), payload.description.strip(), payload.host.strip(), payload.port
        server.username, server.auth_type, server.root_path = payload.username.strip(), payload.auth_type, payload.root_path
        server.host_key_fingerprint, server.adapter_type, server.enabled = fingerprint, payload.adapter_type, payload.enabled
        server.encrypted_credential, server.last_test, server.version = encrypted_credential, last_test, server.version + 1
        await add_audit(db, request, "SERVER_UPDATE", "sftp_server", actor=auth.user, resource_id=server.id)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(409, "A server with this name already exists")
        return server_json(server)

    @app.post("/api/v1/sftp-servers/{server_id}/rotate-credential")
    async def rotate_server_credential(server_id: str, payload: CredentialInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        server = await db.get(SftpServer, server_id)
        if not server:
            raise HTTPException(404, "Server not found")
        supplied = payload.password if payload.auth_type == "PASSWORD" else payload.private_key
        if not supplied:
            raise HTTPException(422, "Credential is required")
        server.auth_type = payload.auth_type
        server.encrypted_credential = encrypt_credential({"password": payload.password} if payload.auth_type == "PASSWORD" else {"privateKey": payload.private_key, "passphrase": payload.passphrase})
        server.version += 1
        await add_audit(db, request, "SERVER_CREDENTIAL_ROTATE", "sftp_server", actor=auth.user, resource_id=server.id)
        await db.commit()
        return server_json(server)

    @app.delete("/api/v1/sftp-servers/{server_id}", status_code=204)
    async def delete_server(server_id: str, request: Request, auth: CsrfAuth, db: Db) -> Response:
        require_admin(auth)
        server = await db.get(SftpServer, server_id)
        if not server:
            raise HTTPException(404, "Server not found")

        grant_ids = list((await db.scalars(select(FolderGrant.id).where(FolderGrant.server_id == server_id))).all())
        task_ids = list((await db.scalars(select(Task.id).where(Task.server_id == server_id))).all())
        upload_ids = list((await db.scalars(select(FileUpload.id).where(FileUpload.server_id == server_id))).all())
        server_name = server.name

        # Keep the complete dependency cascade and its audit record in one SQLite
        # transaction. Audit history intentionally remains after the server row is gone.
        await db.execute(delete(FileUpload).where(FileUpload.server_id == server_id))
        await db.execute(delete(Task).where(Task.server_id == server_id))
        await db.execute(delete(FolderGrant).where(FolderGrant.server_id == server_id))
        await db.delete(server)
        await add_audit(
            db,
            request,
            "SERVER_DELETE",
            "sftp_server",
            actor=auth.user,
            resource_id=server_id,
            server_id=server_id,
            detail={
                "serverName": server_name,
                "deletedGrantCount": len(grant_ids),
                "deletedTaskCount": len(task_ids),
                "deletedUploadSessionCount": len(upload_ids),
            },
        )
        await db.commit()
        return Response(status_code=204)

    @app.get("/api/v1/access-grants")
    async def list_grants(auth: Auth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        grants = (await db.scalars(select(FolderGrant).order_by(FolderGrant.created_at.desc()))).all()
        users = {item.id: item.email for item in (await db.scalars(select(User))).all()}
        groups = {item.id: item.name for item in (await db.scalars(select(Group))).all()}
        servers = {item.id: item.name for item in (await db.scalars(select(SftpServer))).all()}
        return {
            "items": [
                grant_json(
                    item,
                    principal_name=(groups if item.principal_type == "GROUP" else users).get(item.principal_id),
                    server_name=servers.get(item.server_id),
                )
                for item in grants
            ]
        }

    @app.post("/api/v1/access-grants", status_code=201)
    async def create_grant(payload: GrantInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        server = await get_server(db, payload.server_id)
        principal = await db.get(User if payload.principal_type == "USER" else Group, payload.principal_id)
        if not principal:
            raise HTTPException(422, "Principal not found")
        grant = FolderGrant(principal_type=payload.principal_type, principal_id=payload.principal_id, server_id=payload.server_id, path=payload.path, permissions=payload.permissions, recursive=payload.recursive)
        principal_name = principal.email if payload.principal_type == "USER" else principal.name
        db.add(grant)
        try:
            await db.flush()
            await add_audit(
                db,
                request,
                "GRANT_CREATE",
                "folder_grant",
                actor=auth.user,
                resource_id=grant.id,
                server_id=grant.server_id,
                path=grant.path,
                detail={"principalType": payload.principal_type, "principalName": principal_name, "permissions": payload.permissions, "recursive": payload.recursive},
            )
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(409, "A grant already exists for this target")
        return grant_json(grant, principal_name=principal_name, server_name=server.name)

    @app.patch("/api/v1/access-grants/{grant_id}")
    async def update_grant(grant_id: str, payload: GrantInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_admin(auth)
        grant = await db.get(FolderGrant, grant_id)
        if not grant:
            raise HTTPException(404, "Grant not found")
        server = await get_server(db, payload.server_id)
        principal = await db.get(User if payload.principal_type == "USER" else Group, payload.principal_id)
        if not principal:
            raise HTTPException(422, "Principal not found")
        principal_name = principal.email if payload.principal_type == "USER" else principal.name
        grant.principal_type, grant.principal_id, grant.server_id = payload.principal_type, payload.principal_id, payload.server_id
        grant.path, grant.permissions, grant.recursive, grant.version = payload.path, payload.permissions, payload.recursive, grant.version + 1
        try:
            await db.flush()
            await add_audit(
                db,
                request,
                "GRANT_UPDATE",
                "folder_grant",
                actor=auth.user,
                resource_id=grant.id,
                server_id=grant.server_id,
                path=grant.path,
                detail={"principalType": payload.principal_type, "principalName": principal_name, "permissions": payload.permissions, "recursive": payload.recursive},
            )
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(409, "A grant already exists for this target")
        return grant_json(grant, principal_name=principal_name, server_name=server.name)

    @app.delete("/api/v1/access-grants/{grant_id}", status_code=204)
    async def delete_grant(grant_id: str, request: Request, auth: CsrfAuth, db: Db) -> Response:
        require_admin(auth)
        grant = await db.get(FolderGrant, grant_id)
        if not grant:
            raise HTTPException(404, "Grant not found")
        principal = await db.get(User if grant.principal_type == "USER" else Group, grant.principal_id)
        principal_name = (principal.email if grant.principal_type == "USER" else principal.name) if principal else "Unknown principal"
        await db.delete(grant)
        await add_audit(
            db,
            request,
            "GRANT_DELETE",
            "folder_grant",
            actor=auth.user,
            resource_id=grant.id,
            server_id=grant.server_id,
            path=grant.path,
            detail={"principalType": grant.principal_type, "principalName": principal_name, "permissions": grant.permissions, "recursive": grant.recursive},
        )
        await db.commit()
        return Response(status_code=204)

    @app.get("/api/v1/users/{user_id}/effective-access")
    async def explain_effective_access(user_id: str, serverId: str, path: str, auth: Auth, db: Db) -> dict[str, Any]:
        require_active(auth)
        if auth.user.role != "ADMIN" and auth.user.id != user_id:
            raise HTTPException(403, "Effective access is available only for your own account")
        user = await db.get(User, user_id)
        if not user:
            raise HTTPException(404, "User not found")
        normalized = canonical_path(path)
        if user.role == "ADMIN":
            return {"userId": user.id, "serverId": serverId, "path": normalized, "permissions": sorted(ALL_PERMISSIONS), "sources": [{"type": "ROLE", "id": "ADMIN"}]}
        group_ids = list(await db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user.id)))
        conditions = [(FolderGrant.principal_type == "USER") & (FolderGrant.principal_id == user.id)]
        if group_ids:
            conditions.append((FolderGrant.principal_type == "GROUP") & FolderGrant.principal_id.in_(group_ids))
        grants = (await db.scalars(select(FolderGrant).where(FolderGrant.server_id == serverId, or_(*conditions)))).all()
        matching = [grant for grant in grants if normalized == grant.path or grant.recursive and (grant.path == "/" or normalized.startswith(f"{grant.path.rstrip('/')}/"))]
        permissions = await effective_permissions(db, user, serverId, normalized)
        return {"userId": user.id, "serverId": serverId, "path": normalized, "permissions": sorted(permissions), "sources": [{"id": grant.id, "principalType": grant.principal_type, "principalId": grant.principal_id, "path": grant.path, "recursive": grant.recursive, "permissions": grant.permissions} for grant in matching]}

    @app.get("/api/v1/files/roots")
    async def file_roots(auth: Auth, db: Db) -> dict[str, Any]:
        require_active(auth)
        servers = (await db.scalars(select(SftpServer).where(SftpServer.enabled.is_(True)).order_by(SftpServer.name))).all()
        items: list[dict[str, Any]] = []
        if auth.user.role == "ADMIN":
            items = [{"serverId": server.id, "serverName": server.name, "path": "/", "permissions": sorted(ALL_PERMISSIONS)} for server in servers]
        else:
            group_ids = list(await db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == auth.user.id)))
            conditions = [(FolderGrant.principal_type == "USER") & (FolderGrant.principal_id == auth.user.id)]
            if group_ids:
                conditions.append((FolderGrant.principal_type == "GROUP") & FolderGrant.principal_id.in_(group_ids))
            grants = (await db.scalars(select(FolderGrant).where(or_(*conditions)))).all()
            server_map = {server.id: server for server in servers}
            merged: dict[tuple[str, str], dict[str, Any]] = {}
            for grant in grants:
                if grant.server_id in server_map:
                    permissions = set(grant.permissions)
                    if auth.user.role == "AUDITOR":
                        permissions.difference_update(WRITE_PERMISSIONS)
                    key = (grant.server_id, grant.path)
                    if key not in merged:
                        merged[key] = {"serverId": grant.server_id, "serverName": server_map[grant.server_id].name, "path": grant.path, "permissions": []}
                    merged[key]["permissions"] = sorted(set(merged[key]["permissions"]) | permissions)
            items = list(merged.values())
        return {"items": items}

    @app.get("/api/v1/files/list")
    async def list_files(serverId: str, path: str, request: Request, auth: Auth, db: Db) -> dict[str, Any]:
        server = await require_permission(db, request, auth, serverId, path, "LIST")
        try:
            items = await request.app.state.gateway.list(server, path)
        except FileNotFoundError:
            raise HTTPException(404, "Folder not found")
        permissions = sorted(await effective_permissions(db, auth.user, serverId, path))
        return {"path": canonical_path(path), "permissions": permissions, "items": items}

    def upload_chunk_size() -> int:
        configured = int(os.getenv("UPLOAD_CHUNK_BYTES", str(4 * 1024 * 1024)))
        return max(64 * 1024, min(configured, 8 * 1024 * 1024))

    def max_upload_size() -> int:
        return max(1024 * 1024, int(os.getenv("MAX_UPLOAD_BYTES", str(2 * 1024 * 1024 * 1024))))

    async def owned_upload(db: AsyncSession, auth: AuthContext, upload_id: str) -> FileUpload:
        upload = await db.get(FileUpload, upload_id)
        if not upload or upload.user_id != auth.user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Upload not found")
        return upload

    def upload_lock(request: Request, upload_id: str) -> asyncio.Lock:
        locks: dict[str, asyncio.Lock] = request.app.state.upload_locks
        return locks.setdefault(upload_id, asyncio.Lock())

    def upload_target_lock(request: Request, server_id: str, target_path: str) -> asyncio.Lock:
        locks: dict[str, asyncio.Lock] = request.app.state.upload_target_locks
        return locks.setdefault(f"{server_id}:{canonical_path(target_path)}", asyncio.Lock())

    async def reconcile_upload_size(request: Request, db: AsyncSession, upload: FileUpload, server: SftpServer) -> None:
        if upload.status != "ACTIVE":
            return
        remote_size = await request.app.state.gateway.upload_size(
            server,
            canonical_path(posixpath.join(upload.folder_path, upload.filename)),
            upload.id,
        )
        if remote_size > upload.total_size:
            raise HTTPException(status.HTTP_409_CONFLICT, "Remote upload is larger than the selected file")
        if remote_size != upload.received_size:
            upload.received_size = remote_size
            upload.updated_at = utc_now()
            await db.commit()

    @app.post("/api/v1/files/uploads", status_code=status.HTTP_201_CREATED)
    async def start_file_upload(
        body: UploadStartInput,
        request: Request,
        auth: CsrfAuth,
        db: Db,
    ) -> dict[str, Any]:
        if body.size > max_upload_size():
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File exceeds the configured upload limit")
        server = await require_permission(db, request, auth, body.server_id, body.path, "UPLOAD")
        if body.replace:
            await require_permission(db, request, auth, body.server_id, body.path, "DELETE")
        action = "FILE_REPLACE" if body.replace else "FILE_UPLOAD"
        upload = FileUpload(
            id=str(uuid4()),
            user_id=auth.user.id,
            server_id=body.server_id,
            folder_path=body.path,
            filename=body.file_name,
            total_size=body.size,
            received_size=0,
            replace=body.replace,
            status="ACTIVE",
        )
        target_hint = canonical_path(posixpath.join(body.path, body.file_name))
        try:
            await request.app.state.gateway.begin_upload(
                server,
                body.path,
                body.file_name,
                upload.id,
                replace=body.replace,
            )
        except FileExistsError:
            await add_audit(
                db,
                request,
                action,
                "file",
                actor=auth.user,
                server_id=body.server_id,
                path=target_hint,
                outcome="FAILURE",
                detail={"safeErrorCode": "UPLOAD_CONFLICT"},
            )
            await db.commit()
            raise HTTPException(409, "A file with this name already exists")
        except Exception as exc:
            await add_audit(
                db,
                request,
                action,
                "file",
                actor=auth.user,
                server_id=body.server_id,
                path=target_hint,
                outcome="FAILURE",
                detail={"safeErrorCode": "SFTP_UPLOAD_START_FAILED"},
            )
            await db.commit()
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "SFTP upload could not be started. Check the connection and retry.") from exc
        db.add(upload)
        await db.commit()
        return upload_json(upload, chunk_size=upload_chunk_size())

    @app.get("/api/v1/files/uploads/{upload_id}")
    async def file_upload_status(upload_id: str, request: Request, auth: Auth, db: Db) -> dict[str, Any]:
        upload = await owned_upload(db, auth, upload_id)
        server = await require_permission(db, request, auth, upload.server_id, upload.folder_path, "UPLOAD")
        async with upload_lock(request, upload_id):
            await db.refresh(upload)
            await reconcile_upload_size(request, db, upload, server)
            return upload_json(upload, chunk_size=upload_chunk_size())

    @app.put("/api/v1/files/uploads/{upload_id}/content")
    async def write_file_upload_chunk(
        upload_id: str,
        request: Request,
        auth: CsrfAuth,
        db: Db,
        x_upload_offset: Annotated[int, Header(alias="X-Upload-Offset", ge=0)],
    ) -> dict[str, Any]:
        upload = await owned_upload(db, auth, upload_id)
        server = await require_permission(db, request, auth, upload.server_id, upload.folder_path, "UPLOAD")
        if upload.status != "ACTIVE":
            raise HTTPException(status.HTTP_409_CONFLICT, "Upload is no longer active")
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > upload_chunk_size():
                    raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Upload chunk exceeds the configured chunk size")
            except ValueError as exc:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid upload content length") from exc

        async with upload_lock(request, upload_id):
            await db.refresh(upload)
            if upload.status != "ACTIVE":
                raise HTTPException(status.HTTP_409_CONFLICT, "Upload is no longer active")
            await reconcile_upload_size(request, db, upload, server)
            if x_upload_offset != upload.received_size:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"Upload offset changed; resume from byte {upload.received_size}",
                    headers={"X-Upload-Offset": str(upload.received_size)},
                )
            request_bytes = 0

            async def bounded_chunks():  # type: ignore[no-untyped-def]
                nonlocal request_bytes
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    request_bytes += len(chunk)
                    if request_bytes > upload_chunk_size() or x_upload_offset + request_bytes > upload.total_size:
                        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Upload chunk exceeds the expected size")
                    yield chunk

            try:
                confirmed_size = await request.app.state.gateway.write_upload_chunk(
                    server,
                    canonical_path(posixpath.join(upload.folder_path, upload.filename)),
                    upload.id,
                    x_upload_offset,
                    bounded_chunks(),
                )
            except HTTPException:
                raise
            except Exception as exc:
                await add_audit(
                    db,
                    request,
                    "FILE_UPLOAD_INTERRUPTED",
                    "file",
                    actor=auth.user,
                    resource_id=upload.id,
                    server_id=upload.server_id,
                    path=canonical_path(posixpath.join(upload.folder_path, upload.filename)),
                    outcome="FAILURE",
                    detail={"safeErrorCode": "SFTP_UPLOAD_CHUNK_FAILED"},
                )
                await db.commit()
                raise HTTPException(status.HTTP_502_BAD_GATEWAY, "SFTP write was interrupted. Retry to resume the upload.") from exc
            if confirmed_size != x_upload_offset + request_bytes:
                raise HTTPException(status.HTTP_502_BAD_GATEWAY, "SFTP server did not confirm the complete upload chunk")
            upload.received_size = confirmed_size
            upload.updated_at = utc_now()
            await db.commit()
            return upload_json(upload, chunk_size=upload_chunk_size())

    @app.post("/api/v1/files/uploads/{upload_id}/complete")
    async def complete_file_upload(upload_id: str, request: Request, auth: CsrfAuth, db: Db) -> dict[str, str]:
        upload = await owned_upload(db, auth, upload_id)
        server = await require_permission(db, request, auth, upload.server_id, upload.folder_path, "UPLOAD")
        if upload.replace:
            await require_permission(db, request, auth, upload.server_id, upload.folder_path, "DELETE")
        action = "FILE_REPLACE" if upload.replace else "FILE_UPLOAD"
        target_hint = canonical_path(posixpath.join(upload.folder_path, upload.filename))
        async with upload_lock(request, upload_id), upload_target_lock(request, upload.server_id, target_hint):
            await db.refresh(upload)
            if upload.status == "COMPLETED":
                return {"path": canonical_path(posixpath.join(upload.folder_path, upload.filename))}
            await reconcile_upload_size(request, db, upload, server)
            if upload.received_size != upload.total_size:
                raise HTTPException(status.HTTP_409_CONFLICT, f"Upload is incomplete; {upload.received_size} of {upload.total_size} bytes are on SFTP")
            try:
                target = await request.app.state.gateway.complete_upload(
                    server,
                    canonical_path(posixpath.join(upload.folder_path, upload.filename)),
                    upload.id,
                    upload.total_size,
                    replace=upload.replace,
                )
            except FileExistsError:
                await add_audit(
                    db,
                    request,
                    action,
                    "file",
                    actor=auth.user,
                    resource_id=upload.id,
                    server_id=upload.server_id,
                    path=target_hint,
                    outcome="FAILURE",
                    detail={"safeErrorCode": "UPLOAD_CONFLICT"},
                )
                await db.commit()
                raise HTTPException(status.HTTP_409_CONFLICT, "A file with this name already exists")
            except Exception as exc:
                await add_audit(
                    db,
                    request,
                    action,
                    "file",
                    actor=auth.user,
                    resource_id=upload.id,
                    server_id=upload.server_id,
                    path=canonical_path(posixpath.join(upload.folder_path, upload.filename)),
                    outcome="FAILURE",
                    detail={"safeErrorCode": "SFTP_UPLOAD_FINALIZE_FAILED"},
                )
                await db.commit()
                raise HTTPException(status.HTTP_502_BAD_GATEWAY, "SFTP upload could not be finalized. Retry to continue.") from exc
            upload.status = "COMPLETED"
            upload.updated_at = utc_now()
            await add_audit(db, request, action, "file", actor=auth.user, resource_id=upload.id, server_id=upload.server_id, path=target)
        tasks = (await db.scalars(select(Task).where(Task.assignee_id == auth.user.id, Task.server_id == upload.server_id, Task.target_path == upload.folder_path, Task.completion_mode == "MATCHING_UPLOAD", Task.status.in_(["PENDING", "IN_PROGRESS", "OVERDUE"])))).all()
        for task in tasks:
            if task.filename_glob and fnmatch.fnmatchcase(upload.filename, task.filename_glob):
                task.status, task.version = "COMPLETED", task.version + 1
                await add_audit(db, request, "TASK_AUTO_COMPLETE", "task", actor=auth.user, resource_id=task.id, server_id=upload.server_id, path=target)
        await db.commit()
        return {"path": target}

    @app.delete("/api/v1/files/uploads/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def cancel_file_upload(upload_id: str, request: Request, auth: CsrfAuth, db: Db) -> Response:
        upload = await owned_upload(db, auth, upload_id)
        server = await get_server(db, upload.server_id)
        async with upload_lock(request, upload_id):
            if upload.status == "ACTIVE":
                try:
                    await request.app.state.gateway.abort_upload(
                        server,
                        canonical_path(posixpath.join(upload.folder_path, upload.filename)),
                        upload.id,
                    )
                except Exception:
                    pass
            await db.delete(upload)
            await db.commit()
        request.app.state.upload_locks.pop(upload_id, None)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get("/api/v1/files/download")
    async def download_file(serverId: str, path: str, request: Request, auth: Auth, db: Db):  # type: ignore[no-untyped-def]
        parent = canonical_path(posixpath.dirname(canonical_path(path)))
        server = await require_permission(db, request, auth, serverId, parent, "DOWNLOAD")
        name = valid_name(posixpath.basename(path))
        await add_audit(db, request, "FILE_DOWNLOAD", "file", actor=auth.user, server_id=serverId, path=canonical_path(path))
        await db.commit()
        return StreamingResponse(request.app.state.gateway.download(server, path), media_type="application/octet-stream", headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "private, no-store"})

    @app.post("/api/v1/files/folders", status_code=201)
    async def create_folder(payload: FolderInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, str]:
        server = await require_permission(db, request, auth, payload.server_id, payload.parent, "CREATE_FOLDER")
        try:
            path = await request.app.state.gateway.create_folder(server, payload.parent, payload.name)
        except FileExistsError:
            raise HTTPException(409, "Folder already exists")
        await add_audit(db, request, "FOLDER_CREATE", "folder", actor=auth.user, server_id=payload.server_id, path=path)
        await db.commit()
        return {"path": path}

    @app.post("/api/v1/files/rename")
    async def rename_item(payload: RenameInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, str]:
        parent = canonical_path(posixpath.dirname(canonical_path(payload.path)))
        server = await require_permission(db, request, auth, payload.server_id, parent, "RENAME")
        try:
            destination = await request.app.state.gateway.rename(server, payload.path, payload.name)
        except FileExistsError:
            raise HTTPException(409, "Destination already exists")
        await add_audit(db, request, "ITEM_RENAME", "item", actor=auth.user, server_id=payload.server_id, path=destination, detail={"source": payload.path})
        await db.commit()
        return {"path": destination}

    @app.post("/api/v1/files/move")
    async def move_item(payload: MoveInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, str]:
        source_parent = canonical_path(posixpath.dirname(canonical_path(payload.source)))
        destination_parent = canonical_path(posixpath.dirname(canonical_path(payload.destination)))
        server = await require_permission(db, request, auth, payload.server_id, source_parent, "MOVE")
        await require_permission(db, request, auth, payload.server_id, destination_parent, "UPLOAD")
        try:
            destination = await request.app.state.gateway.move(server, payload.source, payload.destination)
        except FileExistsError:
            raise HTTPException(409, "Destination already exists")
        await add_audit(db, request, "ITEM_MOVE", "item", actor=auth.user, server_id=payload.server_id, path=destination, detail={"source": payload.source})
        await db.commit()
        return {"path": destination}

    @app.delete("/api/v1/files/item", status_code=204)
    async def delete_item(serverId: str, path: str, request: Request, auth: CsrfAuth, db: Db) -> Response:
        parent = canonical_path(posixpath.dirname(canonical_path(path)))
        server = await require_permission(db, request, auth, serverId, parent, "DELETE")
        try:
            await request.app.state.gateway.delete(server, path)
        except FileNotFoundError:
            raise HTTPException(404, "Item not found")
        except OSError:
            raise HTTPException(409, "Folder must be empty before deletion")
        await add_audit(db, request, "ITEM_DELETE", "item", actor=auth.user, server_id=serverId, path=canonical_path(path))
        await db.commit()
        return Response(status_code=204)

    @app.get("/api/v1/tasks")
    async def list_tasks(auth: Auth, db: Db) -> dict[str, Any]:
        require_active(auth)
        query = select(Task).order_by(Task.due_at)
        if auth.user.role not in {"ADMIN", "AUDITOR"}:
            query = query.where(Task.assignee_id == auth.user.id)
        tasks = (await db.scalars(query)).all()
        return {"items": [task_json(task) for task in tasks]}

    @app.post("/api/v1/tasks", status_code=201)
    async def create_task(payload: TaskInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        require_active(auth)
        if auth.user.role != "ADMIN":
            if auth.user.role != "MANAGER" or "MANAGE_TASKS" not in await effective_permissions(db, auth.user, payload.server_id, payload.target_path):
                raise HTTPException(403, "Task management access required")
        await get_server(db, payload.server_id)
        if not await db.get(User, payload.assignee_id):
            raise HTTPException(422, "Assignee not found")
        if payload.completion_mode == "MATCHING_UPLOAD" and not payload.filename_glob:
            raise HTTPException(422, "Filename pattern is required")
        task = Task(title=payload.title.strip(), instructions=payload.instructions.strip(), server_id=payload.server_id, target_path=payload.target_path, assignee_id=payload.assignee_id, created_by=auth.user.id, due_at=as_utc(payload.due_at), completion_mode=payload.completion_mode, filename_glob=payload.filename_glob)
        db.add(task)
        await db.flush()
        await add_audit(db, request, "TASK_CREATE", "task", actor=auth.user, resource_id=task.id, server_id=task.server_id, path=task.target_path)
        await db.commit()
        return task_json(task)

    async def task_action(task_id: str, next_status: str, request: Request, auth: AuthContext, db: AsyncSession, reason: str | None = None) -> dict[str, Any]:
        require_active(auth)
        task = await db.get(Task, task_id)
        if not task:
            raise HTTPException(404, "Task not found")
        if auth.user.role == "AUDITOR":
            raise HTTPException(403, "Task action denied")
        manager = auth.user.role == "ADMIN" or (auth.user.role == "MANAGER" and "MANAGE_TASKS" in await effective_permissions(db, auth.user, task.server_id, task.target_path))
        if next_status == "PENDING":
            if not manager:
                raise HTTPException(403, "Only an administrator or scoped manager can reopen a task")
        elif task.assignee_id != auth.user.id and auth.user.role != "ADMIN":
            raise HTTPException(403, "Task action denied")
        transitions = {
            "PENDING": {"IN_PROGRESS", "COMPLETED", "DISMISSED"},
            "IN_PROGRESS": {"COMPLETED", "DISMISSED"},
            "OVERDUE": {"IN_PROGRESS", "COMPLETED", "DISMISSED"},
            "COMPLETED": {"PENDING"},
            "DISMISSED": {"PENDING"},
        }
        if next_status not in transitions.get(task.status, set()):
            raise HTTPException(409, f"Task cannot change from {task.status} to {next_status}")
        task.status, task.dismissal_reason, task.version = next_status, reason, task.version + 1
        await add_audit(db, request, f"TASK_{next_status}", "task", actor=auth.user, resource_id=task.id, server_id=task.server_id, path=task.target_path, detail={"reason": reason} if reason else {})
        await db.commit()
        return task_json(task)

    @app.post("/api/v1/tasks/{task_id}/start")
    async def start_task(task_id: str, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        return await task_action(task_id, "IN_PROGRESS", request, auth, db)

    @app.post("/api/v1/tasks/{task_id}/complete")
    async def complete_task(task_id: str, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        return await task_action(task_id, "COMPLETED", request, auth, db)

    @app.post("/api/v1/tasks/{task_id}/dismiss")
    async def dismiss_task(task_id: str, payload: DismissInput, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        return await task_action(task_id, "DISMISSED", request, auth, db, payload.reason)

    @app.post("/api/v1/tasks/{task_id}/reopen")
    async def reopen_task(task_id: str, request: Request, auth: CsrfAuth, db: Db) -> dict[str, Any]:
        return await task_action(task_id, "PENDING", request, auth, db)

    @app.get("/api/v1/audit-events")
    async def list_audit(auth: Auth, db: Db, limit: int = 100) -> dict[str, Any]:
        require_active(auth)
        events = (
            await db.scalars(
                select(AuditEvent)
                .where(AuditEvent.action != "FOLDER_LIST")
                .order_by(AuditEvent.timestamp.desc())
                .limit(min(max(limit, 1), 200))
            )
        ).all()
        visible = []
        for event in events:
            if auth.user.role in {"ADMIN", "AUDITOR"} or event.actor_id == auth.user.id:
                visible.append(event)
            elif event.server_id and event.path and "LIST" in await effective_permissions(db, auth.user, event.server_id, event.path):
                visible.append(event)
        server_names = dict((await db.execute(select(SftpServer.id, SftpServer.name))).all())
        include_request_metadata = auth.user.role in {"ADMIN", "AUDITOR"}
        return {
            "items": [
                audit_json(
                    event,
                    server_names.get(event.server_id),
                    include_request_metadata=include_request_metadata,
                )
                for event in visible
            ]
        }

    @app.get("/api/v1/dashboard")
    async def dashboard(auth: Auth, db: Db) -> dict[str, Any]:
        require_active(auth)
        roots = await file_roots(auth, db)
        task_query = select(Task).where(Task.assignee_id == auth.user.id, Task.status.in_(["PENDING", "IN_PROGRESS", "OVERDUE"])).order_by(Task.due_at).limit(20)
        tasks = (await db.scalars(task_query)).all()
        audit_query = (
            select(AuditEvent)
            .where(AuditEvent.actor_id == auth.user.id, AuditEvent.action != "FOLDER_LIST")
            .order_by(AuditEvent.timestamp.desc())
            .limit(20)
        )
        activity = (await db.scalars(audit_query)).all()
        pending_approvals = 0
        if auth.user.role == "ADMIN":
            pending_approvals = len((await db.scalars(select(User.id).where(User.state == "PENDING_APPROVAL"))).all())
        server_names = dict((await db.execute(select(SftpServer.id, SftpServer.name))).all())
        return {"tasks": [task_json(task) for task in tasks], "roots": roots["items"], "recentActivity": [audit_json(event, server_names.get(event.server_id)) for event in activity], "pendingApprovals": pending_approvals}

    return app


app = create_app()
