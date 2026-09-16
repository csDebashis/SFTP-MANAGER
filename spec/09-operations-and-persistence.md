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
- `/health/ready` verifies required configuration, database connectivity/current-baseline compatibility, scheduler operation, and credential-key availability. It does not require every remote SFTP server to be online.

### 11.2 Failure behavior

- Remote server unavailability must not prevent login or access to non-SFTP administration pages.
- SFTP failures use categorized codes such as `SFTP_AUTH_FAILED`, `SFTP_HOST_KEY_MISMATCH`, `SFTP_TIMEOUT`, `SFTP_PATH_NOT_FOUND`, and `SFTP_UNAVAILABLE`.
- Metadata operations may retry once only for an idempotent network failure. File mutations do not retry automatically unless protected by their operation-specific idempotency logic.
- Connection pools are keyed by server configuration version and closed after credential rotation, host-key change, disablement, or shutdown.
- Graceful shutdown rejects new transfers, allows active transfers up to 30 seconds to finish, performs cleanup, checkpoints SQLite WAL state when SQLite is in use, and then closes database and SFTP connections.

## 12. Configuration and deployment

The deployment uses separate containers for the Node.js/React frontend and Python/FastAPI backend. Docker Compose builds each service from its own Dockerfile, connects them on a private network, bind-mounts `/Users/debchowd/SFTP-MANAGER/db` at `/data` for SQLite, and bind-mounts `/Users/debchowd/SFTP-MANAGER/logs` at `/var/log/sftp-manager` for rotating application logs. Both host directories are excluded from Git. The frontend is the only application service exposed to the host and proxies `/api` requests to the backend. Both containers run as non-root users with read-only root filesystems and explicitly declared temporary filesystems.

Required production configuration includes:

- Public base URL and trusted proxy/origin settings.
- Session signing material supplied through a mounted secret file.
- Credential-encryption key supplied through a mounted secret file.
- Bootstrap Admin email and password secret file.
- SQLite URL defaulting to `sqlite+aiosqlite:////data/sftp-manager.db`.
- SQLite busy timeout and WAL checkpoint interval.
- SMTP settings or an explicit configuration disabling self-service password reset.
- Upload/concurrency/timeout limits.
- The Node.js API proxy request-body limit defaults to `8mb`, which is large enough for the maximum 8 MiB raw upload chunk while preventing accidental whole-file request buffering. The total-file limit remains independently configurable in the backend.
- Operational log directory, minimum severity level, rotation size/count, retention/collection policy, and metrics exposure policy.

During FastAPI startup, the backend creates the complete current schema when the SQLite database is empty. For an existing database, it validates the baseline marker and exact table/column shape before becoming ready. Startup must fail when required secrets are absent, default/development values are used, origins are invalid, the SQLite path is not writable, or the database is incompatible. The application must never silently migrate, recreate, or replace an existing database.

Deployment must enforce:

- One backend replica with one scheduler owner. Multiple frontend replicas are allowed outside the reference Compose deployment.
- A protected, writable host bind mount from `/Users/debchowd/SFTP-MANAGER/db` to `/data`; container replacement must preserve this directory and its SQLite/WAL files.
- A separately protected, writable host bind mount from `/Users/debchowd/SFTP-MANAGER/logs` to `/var/log/sftp-manager`; application users cannot read it through application APIs, and operator/collector access follows least privilege.
- SQLite WAL mode, foreign-key enforcement, a busy timeout, and `synchronous=FULL` for all production connections.
- Network egress restricted to configured SFTP and SMTP destinations where the platform permits it.
- Metrics and readiness endpoints restricted to the deployment platform or monitoring network.
- Coordinated backend replacement so only one scheduler owner writes task occurrences during startup.

### 12.1 Container build and deployment workflow

- `backend/Dockerfile` is a multi-stage Python image with separate `test` and `runtime` targets. The runtime target installs the application wheel and starts one Uvicorn worker as a non-root user; FastAPI startup initializes or validates the baseline schema.
- `frontend/Dockerfile` is a multi-stage Node.js image with separate `test`, `build`, and `runtime` targets. The runtime target starts the optimized Next.js application as a non-root user.
- `compose.yaml` builds the two runtime targets, exposes only the frontend, waits for backend readiness, mounts the Git-ignored host `db` and `logs` directories, and injects secrets as files.
- `scripts/verify-build-deploy.sh` is the supported local release entry point. By default it builds and runs both test targets, validates Compose, builds production images, creates and validates both writable host persistence directories, deploys with `docker compose up --detach --remove-orphans --wait`, verifies the non-empty log through both container and host paths, and verifies SQLite integrity, the current baseline marker, and absence of Alembic metadata through both paths before printing service status.
- `scripts/verify-build-deploy.sh --verify-only` performs tests and production image builds without deploying.
- Deployment requires `BOOTSTRAP_ADMIN_EMAIL` plus the three non-empty files documented in `deploy/secrets/README.md`. The script must stop before deployment if any prerequisite is missing.

### 12.2 Vercel deployment

- Importing the repository root from the `vercel` branch deploys the Next.js
  frontend and FastAPI backend together through Vercel Services. Ordered public
  rewrites route `/api/*` to FastAPI before routing all other paths to Next.js.
- Without a PostgreSQL `DATABASE_URL`, the import-ready configuration runs in
  demonstration mode. When the backend detects
  Vercel through its runtime environment, `/var/task` application mount, or a
  read-only working directory, it uses the writable `/tmp/sftp-manager` tree for
  SQLite, mock SFTP files, and filesystem logs, seeds the documented demo users,
  and emits secure session cookies unless explicitly overridden. Inherited
  filesystem-path and demo-seeding environment settings are ignored in this
  mode so container defaults cannot redirect writes into the read-only
  application image or require unavailable Docker secret files.
- Vercel demonstration state is instance-local and disposable. Scale-down,
  replacement, redeployment, or routing to another instance may reset or fork
  accounts, sessions, tasks, audit history, server configuration, and mock SFTP
  files. Operators must not enter production SFTP credentials or production
  data in this mode.
- When `DATABASE_URL` selects PostgreSQL, the Vercel backend uses the asyncpg
  SQLAlchemy driver, provider-enforced TLS, a deliberately small local
  connection pool, and a PostgreSQL advisory transaction lock for concurrent
  cold-start schema initialization. Users, sessions, server configuration,
  grants, tasks, idempotency records, and audit events then survive instance
  replacement and deployment.
- Durable Vercel mode respects `SEED_DEMO_USERS`; when disabled, the first Admin
  is created from `BOOTSTRAP_ADMIN_EMAIL` and the serverless secret
  `BOOTSTRAP_ADMIN_PASSWORD`. SFTP credentials use the serverless secret
  `APP_CREDENTIAL_ENCRYPTION_KEY`. Secret values must be stored only in Vercel
  environment configuration and never committed.
- `DEPLOYMENT_MODE` is the authoritative `demo`/`production` selector when set.
  Demo mode seeds and normalizes the documented accounts and permits their
  publication only in the login footer. Production mode disables demo seeding
  and public credential disclosure, and Vercel startup rejects production mode
  unless `DATABASE_URL` selects PostgreSQL. `SEED_DEMO_USERS` remains a
  compatibility fallback when the selector is absent.
- Vercel demonstration mode does not satisfy durable production persistence,
  continuous scheduler ownership, filesystem-log retention, backup, or
  single-writer guarantees. Compose remains the supported production runtime.
- PostgreSQL makes request-driven application state durable, but Vercel
  Functions still do not provide continuous APScheduler ownership or a durable
  filesystem. Structured logs go to stdout for Vercel Runtime Logs; longer-term
  operational-log retention requires a supported external collector or Vercel
  Log Drain. Immutable application audit events remain durable in PostgreSQL.

## 13. SQLite persistence and future scaling

SQLite is the durable Compose system of record for users, sessions, servers,
encrypted credentials, grants, task definitions, task instances, idempotency
records, and audit events. PostgreSQL provides the same durable system of record
for Vercel. SQLAlchemy 2.x supplies the data-access layer, with `aiosqlite` and
`asyncpg` as the asynchronous drivers. The declared SQLAlchemy metadata and
`schema_baseline` marker are the only schema authority; migration scripts and
migration dependencies are intentionally absent.

SQLite requirements:

- Enable foreign keys on every connection and use WAL journal mode.
- Store the database in `/Users/debchowd/SFTP-MANAGER/db` on a durable local filesystem that supports POSIX locking; do not place the live database on NFS or object storage.
- Apply unique constraints for normalized email, group name, task occurrence key, and scoped idempotency key.
- Index audit timestamp/action/actor/server/path fields, active sessions, grant lookups, and pending task due times.
- Initialize all baseline tables and the singleton baseline marker as one startup operation before the API accepts traffic.
- Treat version 1.2 as the schema baseline: an empty host `db` directory is initialized automatically, while importing or incrementally upgrading a pre-baseline or future-incompatible database is outside scope and fails startup.
- No database backup or restore workflow is required for this deployment; operators may intentionally stop the stack, clear the host `db` directory, and start from a fresh baseline when data can be discarded.

Repository interfaces must remain database-agnostic so SQLite and PostgreSQL do
not change route or service contracts. Before horizontal backend scaling, use
PostgreSQL or prove a supported shared-storage topology, preserve distributed
session/idempotency behavior, and use a distributed scheduler or
leader-election mechanism.
