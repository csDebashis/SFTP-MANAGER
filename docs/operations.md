# Operations guide

## Vercel deployment

Import the repository root from the `vercel` branch. The root `vercel.json`
defines a Next.js frontend service, a FastAPI backend service, and ordered
same-domain routing. Select the **Services** framework preset during import if
it is not detected automatically.

### Durable PostgreSQL mode

Connect a PostgreSQL provider from the Vercel Marketplace to the project. A
Neon connection supplies `DATABASE_URL` automatically. The backend normalizes
provider PostgreSQL URLs for asyncpg, uses a deliberately small connection
pool, and serializes concurrent cold-start schema initialization with a
PostgreSQL advisory transaction lock.

Configure these Production environment variables in the Vercel project:

| Variable | Requirement |
|---|---|
| `APP_ENV` | Set to `production` |
| `DATABASE_URL` | Provider-managed PostgreSQL connection URL |
| `SEED_DEMO_USERS` | Set to `false` |
| `BOOTSTRAP_ADMIN_EMAIL` | Initial administrator email |
| `BOOTSTRAP_ADMIN_PASSWORD` | Secret with at least 12 characters |
| `APP_CREDENTIAL_ENCRYPTION_KEY` | Secret containing 32 bytes or URL-safe base64 for 32 bytes |

Vercel serverless functions cannot mount Compose secret files. Store the
password and encryption key as encrypted environment variables, scope them to
Production, and never place their values in Git. The file variants retain
precedence in Compose, while the direct-value variants are intended for
serverless deployments. Redeploy after connecting the database or changing
configuration.

PostgreSQL persists accounts, sessions, tasks, schedules and occurrences,
server and grant metadata, transfer state, idempotency records, and audit
events across cold starts, scaling, and deployments. Actual SFTP file contents
remain on the configured remote server. The local mock SFTP adapter still uses
`/tmp` and is not durable.

Vercel Functions do not provide a continuously running process for the
in-process APScheduler. Manual and request-driven task operations remain
durable, but reliable unattended schedule execution requires an external
scheduler that invokes an authenticated application endpoint or a future
distributed worker design.

### Disposable fallback mode

When Vercel sets `VERCEL=1`, mounts the application under `/var/task`, or exposes
a read-only working directory and `DATABASE_URL` is not PostgreSQL, the backend
uses these writable paths:

| Resource | Vercel demo path |
|---|---|
| SQLite | `/tmp/sftp-manager/sftp-manager.db` |
| Mock SFTP | `/tmp/sftp-manager/mock-sftp` |
| Application log | `/tmp/sftp-manager/logs/application.log` |

In this demonstration mode, a stale SQLite `DATABASE_URL`, `MOCK_SFTP_ROOT`,
`APP_LOG_DIR`, and `SEED_DEMO_USERS` are ignored so container-oriented settings
cannot direct writes into Vercel's read-only application image or require
Docker secret files. A PostgreSQL `DATABASE_URL` is never ignored. The
documented demo users are always seeded in fallback mode. Explicit paths and
seed choices supplied directly by framework-native tests remain supported.

This mode seeds the documented demo users and enables secure cookies by
default. The paths are local to one stateless service instance and can disappear
on scale-down, replacement, or deployment; concurrent instances do not share
them. Production SFTP credentials and production data must never be entered in
this mode. Use PostgreSQL mode or Compose for durable application state.

## Operational logging

The backend writes the same redacted JSON-lines records to stdout and to a
rotating file. The Compose deployment bind-mounts the repository-local,
Git-ignored host directory:

```text
/Users/debchowd/SFTP-MANAGER/logs
```

The active host file is `logs/application.log`; inside the backend container it
is available at:

```text
/var/log/sftp-manager/application.log
```

Local, non-container execution defaults to `./logs/application.log` from the
process working directory.

On Vercel, structured records are emitted to stdout and appear in Runtime Logs.
The `/tmp` file is only a best-effort per-instance copy and is not durable.
Database audit events are durable in PostgreSQL and are distinct from runtime
logs. Retaining operational logs beyond the platform's built-in window requires
an external collector or a Vercel plan that supports Log Drains.

Each record includes UTC timestamp, severity, service, logger, and message.
Request completion records also include request ID, HTTP method, stable route
template, status, and duration. Query strings and payloads are not recorded.

### Severity policy

| Severity | Use |
|---|---|
| `DEBUG` | Request-start and opt-in diagnostic detail |
| `INFO` | Normal lifecycle and successful HTTP completion |
| `WARNING` | Recoverable risk, demo mode, and HTTP 4xx completion |
| `ERROR` | HTTP 5xx completion and unexpected request failure |
| `CRITICAL` | Process safety or data-integrity failure requiring intervention |

Set these environment variables before running Compose:

| Variable | Default | Meaning |
|---|---:|---|
| `LOG_LEVEL` | `INFO` | Minimum severity; one of `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |
| `LOG_MAX_BYTES` | `10485760` | Rotate the active file after this many bytes |
| `LOG_BACKUP_COUNT` | `5` | Number of rotated files retained |
| `APP_LOG_DIR` | `/var/log/sftp-manager` in Compose | Directory containing `application.log` |

Invalid values stop backend startup so logging cannot silently degrade.

### Viewing logs

Follow stdout through Docker:

```bash
docker compose logs --follow backend
```

Read the mounted filesystem log:

```bash
tail -f logs/application.log
docker compose exec backend tail -n 100 /var/log/sftp-manager/application.log
```

Confirm the Compose bind mount:

```bash
docker compose config
```

The application never exposes operational files through an HTTP endpoint.
Access to the Docker host and volume should be limited to operators. Collectors
must preserve JSON lines and apply an independent retention policy before old
rotations are removed.

## Health and startup

- `/api/v1/health/live` confirms the API event loop responds.
- `/api/v1/health/ready` confirms database and scheduler readiness without
  requiring every remote SFTP server to be online.
- FastAPI startup creates an empty baseline schema or validates an existing
  current-baseline database before readiness succeeds.
- Compose runs one backend worker so APScheduler has one owner and SQLite writes
  remain coordinated. Vercel has no continuously resident scheduler owner.

After deploying, `scripts/verify-build-deploy.sh` waits for both health checks
and verifies that the backend filesystem log exists and is non-empty.

## Durable state lifecycle

Compose mounts the Git-ignored host directory
`/Users/debchowd/SFTP-MANAGER/db` at `/data` in the backend. The active database
is therefore available on the host as `db/sftp-manager.db` and in the container
as `/data/sftp-manager.db`. An empty directory is initialized at the current
schema baseline during backend startup. The database stores a singleton
baseline marker and must match the current table/column shape when reopened.
Pre-baseline development databases are not imported or upgraded, no migration
tooling is installed, and this deployment does not provide a database
backup/restore workflow. Remote SFTP file contents are not stored in the
application database.

Application logs in the host `logs` directory and SQLite in the host `db`
directory are separate and excluded from Git. When application data may be
discarded, stop the stack before clearing the `db` directory, then redeploy to
create a fresh baseline database.

## Incident correlation

Use the response `X-Request-ID` to correlate a user-visible failure with the
operational log and, when the action is auditable, its database audit event.
Operational logs intentionally omit source IP, client metadata, payloads, raw
exceptions, and secrets. Authorized Admin/Auditor audit views are the controlled
place for incident metadata captured by the product.
