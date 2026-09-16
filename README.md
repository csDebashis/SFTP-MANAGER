# SFTP Management Portal

A secure web portal for managing authorized SFTP folders, scheduled file tasks, users, folder grants, and audit activity.

## Demo accounts

Demo seeding is enabled by default for local development and the reference Compose deployment.

| Role | Email | Password |
|---|---|---|
| Admin | `admin@example.com` | `Admin123!Secure` |
| User | `user@example.com` | `User123!Secure` |

`DEPLOYMENT_MODE=demo` seeds these accounts and shows them in the login-page
footer; the email and password fields themselves always start empty. Set
`DEPLOYMENT_MODE=production` outside a development or demonstration
environment. Production mode disables demo seeding and removes the credential
footer. `SEED_DEMO_USERS` remains a compatibility fallback only when
`DEPLOYMENT_MODE` is unset.

## Run locally

Backend:

```bash
python3 -m venv .venv
.venv/bin/pip install -e 'backend[test]'
DATABASE_URL=sqlite+aiosqlite:///./sftp-manager.db \
  .venv/bin/uvicorn app.main:app --app-dir backend --reload
```

Frontend, in a second terminal:

```bash
cd frontend
npm install
BACKEND_INTERNAL_URL=http://127.0.0.1:8000 npm run dev
```

Open `http://localhost:3000`.

## Import into Vercel

Import the repository root and select the `vercel` branch. The committed
`vercel.json` declares the Next.js frontend and FastAPI backend as one Vercel
Services deployment, with `/api/*` routed directly to FastAPI and all other
requests routed to Next.js. In the import screen, use the **Services** framework
preset if Vercel does not select it automatically.

For durable Vercel state, add a PostgreSQL database from the Vercel Marketplace
(Neon is supported on the free plans) and connect it to this project. The
integration supplies `DATABASE_URL`; the backend automatically selects asyncpg,
requires TLS when the provider URL requests it, and stores users, sessions,
tasks, server configuration, transfer metadata, idempotency records, and audit
events in PostgreSQL. Set these Production environment variables in Vercel:

| Variable | Value |
|---|---|
| `APP_ENV` | `production` |
| `DEPLOYMENT_MODE` | `production` |
| `BOOTSTRAP_ADMIN_EMAIL` | Initial administrator email |
| `BOOTSTRAP_ADMIN_PASSWORD` | A secret password of at least 12 characters |
| `APP_CREDENTIAL_ENCRYPTION_KEY` | 32 random bytes or their URL-safe base64 encoding |

Vercel cannot mount the Docker secret files used by Compose. Add the two secret
values through the Vercel environment-variable UI, scope them to Production,
and never commit them. Redeploy after connecting the database or changing an
environment variable. The bootstrap password is used only when no active Admin
exists, but it should remain protected and be rotated after first login.

For a public demo such as `sftp-manager.csdebashis.com`, set
`DEPLOYMENT_MODE=demo`. The same mode works with PostgreSQL for durable demo
accounts and sessions. Without a PostgreSQL `DATABASE_URL`, the import remains
a deliberately disposable demo and stores SQLite, mock SFTP files, and
filesystem logs under the function instance's writable `/tmp` directory. That
state can reset at any time and must not receive production credentials or
data. Vercel rejects `DEPLOYMENT_MODE=production` without PostgreSQL. Even in
durable PostgreSQL mode, mock SFTP files and the local filesystem log are
disposable; real file contents remain on the remote SFTP server.

Database audit events are durable with PostgreSQL. Runtime logs are emitted to
Vercel stdout, but Vercel Hobby retains them only for its platform retention
window. Long-term operational-log storage needs an external collector or a
Vercel plan that supports Log Drains. Vercel Functions also cannot continuously
own the in-process APScheduler, so request-driven task operations are durable
but reliable unattended schedules require an external scheduler. The Compose
deployment below remains the simplest all-in-one durable runtime for the
current architecture.

## Test, build, and deploy with Compose

Create the secret files described in `deploy/secrets/README.md`, export `BOOTSTRAP_ADMIN_EMAIL`, and run:

```bash
./scripts/verify-build-deploy.sh
```

Use `--verify-only` to run tests and build both production images without deploying.

The browser sends file content in resumable 4 MiB chunks. Compose sets
`UPLOAD_PROXY_MAX_BODY_SIZE=8mb`; progress advances only after FastAPI has
written a chunk to the remote SFTP temporary object and verified its size.

## Application logs

The backend emits redacted JSON logs at `DEBUG`, `INFO`, `WARNING`, `ERROR`,
and `CRITICAL` levels. Compose bind-mounts the repository's ignored `logs`
directory into the backend while also sending the records to container stdout.
The active host file is `./logs/application.log`:

```bash
tail -f logs/application.log
docker compose logs --follow backend
docker compose exec backend tail -n 100 /var/log/sftp-manager/application.log
```

`LOG_LEVEL`, `LOG_MAX_BYTES`, and `LOG_BACKUP_COUNT` control verbosity and
rotation. Operational logs never replace the immutable database audit history.

Compose mounts durable application data from the Git-ignored host directory
`/Users/debchowd/SFTP-MANAGER/db`; the active database is
`./db/sftp-manager.db`. An empty database is created directly from the current
SQLAlchemy schema baseline. The backend has no Alembic dependency or migration
scripts; incompatible databases are rejected and may be replaced with a fresh
database after stopping the stack.

## Documentation

- [`SPEC.md`](SPEC.md) — product, security, API, and acceptance requirements
- [`docs/architecture.md`](docs/architecture.md) — runtime topology and code guide
- [`docs/operations.md`](docs/operations.md) — logging, health, deployment, and durable-state operations
- [`deploy/secrets/README.md`](deploy/secrets/README.md) — local Compose secret setup
