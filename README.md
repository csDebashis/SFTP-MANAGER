# SFTP Management Portal

A secure web portal for managing authorized SFTP folders, scheduled file tasks, users, folder grants, and audit activity.

## Demo accounts

Demo seeding is enabled by default for local development and the reference Compose deployment.

| Role | Email | Password |
|---|---|---|
| Admin | `admin@gmail.com` | `Admin123!Secure` |
| User | `user@gmail.com` | `User123!Secure` |

Set `SEED_DEMO_USERS=false` outside a development or demonstration environment.

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

The zero-configuration Vercel deployment is deliberately a disposable demo. It
uses the demo accounts above and stores SQLite, mock SFTP files, and filesystem
logs under the function instance's writable `/tmp` directory. Vercel instances
are stateless and may scale down or be replaced, so accounts, sessions, tasks,
audit history, saved servers, and mock files can reset at any time. Different
instances may also observe different local state. Do not enter production SFTP
credentials or use this mode for production data.

The Compose deployment below remains the supported durable production runtime.
Moving production to Vercel requires an external database, distributed
scheduling/locking, external log collection, and Vercel environment variables
for all secrets; those resources cannot be securely created from a Git import.

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
rotation. Operational logs never replace the immutable SQLite audit history.

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
