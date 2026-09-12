# Operations and persistence

Owner: Platform operations. Related modules:
[architecture](07-data-architecture-and-api.md), [quality](10-quality-and-acceptance.md).

## 11. Observability and operations

### 11.1 Operational telemetry

- Emit redacted structured JSON logs to stdout and a rotating filesystem file with UTC timestamp, severity, service, request ID, route template, status, and duration. The minimum level, maximum file size, retained rotation count, and log directory are configurable. Invalid logging configuration prevents startup.
- Operational logging uses an explicit safe-field allow-list. Request bodies, query strings, cookies, session/CSRF/reset tokens, credentials, encryption material, remote banners, filenames/file contents, raw exception messages, source IP, and user-agent/client metadata are never written to application logs. Request and resource correlation identifiers may be included.
- `DEBUG` is opt-in diagnostic detail, `INFO` records normal lifecycle and successful requests, `WARNING` records recoverable risks and client failures, `ERROR` records server failures, and `CRITICAL` is reserved for process-safety or data-integrity failures requiring intervention.
- Emit metrics for request latency/error rate, active sessions, SFTP connection attempts and latency, transfer counts/bytes/outcomes, scheduler lag, generated/overdue tasks, authorization denials, login failures, database latency/lock contention, and entity counts.
- Never use operational logs as the audit source of truth.
- `/health/live` succeeds while the event loop is responsive.
- `/health/ready` verifies required configuration, SQLite connectivity/schema version, scheduler operation, and credential-key availability. It does not require every remote SFTP server to be online.

### 11.2 Failure behavior

- Remote server unavailability must not prevent login or access to non-SFTP administration pages.
- SFTP failures use categorized codes such as `SFTP_AUTH_FAILED`, `SFTP_HOST_KEY_MISMATCH`, `SFTP_TIMEOUT`, `SFTP_PATH_NOT_FOUND`, and `SFTP_UNAVAILABLE`.
- Metadata operations may retry once only for an idempotent network failure. File mutations do not retry automatically unless protected by their operation-specific idempotency logic.
- Connection pools are keyed by server configuration version and closed after credential rotation, host-key change, disablement, or shutdown.
- Graceful shutdown rejects new transfers, allows active transfers up to 30 seconds to finish, performs cleanup, checkpoints SQLite WAL state, and then closes database and SFTP connections.

## 12. Configuration and deployment

The deployment uses separate containers for the Node.js/React frontend and Python/FastAPI backend. Docker Compose builds each service from its own Dockerfile, connects them on a private network, mounts a named volume at `/data` in the backend for the SQLite database, and mounts a separate named volume at `/var/log/sftp-manager` for rotating application logs. The frontend is the only application service exposed to the host and proxies `/api` requests to the backend. Both containers run as non-root users with read-only root filesystems and explicitly declared temporary filesystems.

Required production configuration includes:

- Public base URL and trusted proxy/origin settings.
- Session signing material supplied through a mounted secret file.
- Credential-encryption key supplied through a mounted secret file.
- Bootstrap Admin email and password secret file.
- SQLite URL defaulting to `sqlite+aiosqlite:////data/sftp-manager.db`.
- SQLite busy timeout, WAL checkpoint interval, and backup destination.
- SMTP settings or an explicit configuration disabling self-service password reset.
- Upload/concurrency/timeout limits.
- The Node.js API proxy request-body limit defaults to `8mb`, which is large enough for the maximum 8 MiB raw upload chunk while preventing accidental whole-file request buffering. The total-file limit remains independently configurable in the backend.
- Operational log directory, minimum severity level, rotation size/count, retention/collection policy, and metrics exposure policy.

The backend must run Alembic migrations before becoming ready and must refuse startup when required secrets are absent, default/development values are used, origins are invalid, the SQLite path is not writable, or the schema is newer than the application. The application must never silently recreate or replace an unreadable database.

Deployment must enforce:

- One backend replica with one scheduler owner. Multiple frontend replicas are allowed outside the reference Compose deployment.
- A persistent Docker volume for `/data`; container replacement must preserve this volume.
- A separately protected persistent volume for `/var/log/sftp-manager`; application users cannot read it through application APIs, and operator/collector access follows least privilege.
- SQLite WAL mode, foreign-key enforcement, a busy timeout, and `synchronous=FULL` for all production connections.
- Nightly online SQLite backups using the SQLite backup API, integrity verification, retention policy, and periodic restore tests.
- Network egress restricted to configured SFTP and SMTP destinations where the platform permits it.
- Metrics and readiness endpoints restricted to the deployment platform or monitoring network.
- Coordinated backend upgrades so only one scheduler owner writes task occurrences during migration.

### 12.1 Container build and deployment workflow

- `backend/Dockerfile` is a multi-stage Python image with separate `test` and `runtime` targets. The runtime target installs the application wheel, runs Alembic migrations, and starts one Uvicorn worker as a non-root user.
- `frontend/Dockerfile` is a multi-stage Node.js image with separate `test`, `build`, and `runtime` targets. The runtime target starts the optimized Next.js application as a non-root user.
- `compose.yaml` builds the two runtime targets, exposes only the frontend, waits for backend readiness, mounts the durable `sqlite_data` and `application_logs` volumes, and injects secrets as files.
- `scripts/verify-build-deploy.sh` is the supported local release entry point. By default it builds and runs both test targets, validates Compose, builds production images, deploys with `docker compose up --detach --remove-orphans --wait`, verifies a non-empty backend filesystem log, and prints service status.
- `scripts/verify-build-deploy.sh --verify-only` performs tests and production image builds without deploying.
- Deployment requires `BOOTSTRAP_ADMIN_EMAIL` plus the three non-empty files documented in `deploy/secrets/README.md`. The script must stop before deployment if any prerequisite is missing.

## 13. SQLite persistence and future scaling

SQLite is the durable system of record for users, sessions, servers, encrypted credentials, grants, task definitions, task instances, idempotency records, and audit events. SQLAlchemy 2.x supplies the data-access layer, `aiosqlite` supplies asynchronous access, and Alembic supplies forward-only production migrations.

SQLite requirements:

- Enable foreign keys on every connection and use WAL journal mode.
- Store the database on a durable local block/filesystem volume that supports POSIX locking; do not place the live database on NFS or object storage.
- Apply unique constraints for normalized email, group name, task occurrence key, and scoped idempotency key.
- Index audit timestamp/action/actor/server/path fields, active sessions, grant lookups, and pending task due times.
- Run migrations as a one-shot startup step before the API accepts traffic.
- Produce consistent online backups through the SQLite backup API, validate backups with `PRAGMA integrity_check`, and test restores.
- Set and document recovery objectives based on backup frequency and retention. WAL files must be included in operational monitoring and checkpointed safely.

Repository interfaces must remain database-agnostic so a future PostgreSQL migration does not change route or service contracts. Before horizontal backend scaling, replace SQLite or prove a supported shared-storage topology, add distributed session/idempotency behavior, and use a distributed scheduler or leader-election mechanism.
