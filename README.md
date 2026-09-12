# SFTP Management Portal

A secure web portal for managing authorized SFTP folders, scheduled file tasks, users, folder grants, and audit activity.

## Demo accounts

Demo seeding is enabled by default for local development and the reference
Podman Compose deployment.

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

## Test, build, and deploy

Install Podman and `podman-compose`, initialize and start its Linux VM on
macOS, create the secret files described in `deploy/secrets/README.md`, export
`BOOTSTRAP_ADMIN_EMAIL`, and run:

```bash
brew install podman podman-compose
podman machine init       # first installation only
podman machine start
export BOOTSTRAP_ADMIN_EMAIL=admin@gmail.com
./scripts/verify-build-deploy.sh
```

The supported deployment workflow uses rootless Podman and explicitly selects
`podman-compose` as the Compose provider. The two OCI images are built from
separate `backend/Containerfile` and `frontend/Containerfile` definitions.
The official Podman macOS installer is preferred for production operator
workstations. If Apple HyperVisor cannot boot on Apple Silicon, install
`krunkit` from the official `libkrun/krun` tap and recreate the machine with
`podman machine init --provider libkrun`.

Use `--verify-only` to run tests and build both production images without deploying.

The browser sends file content in resumable 4 MiB chunks. Podman Compose sets
`UPLOAD_PROXY_MAX_BODY_SIZE=8mb`; progress advances only after FastAPI has
written a chunk to the remote SFTP temporary object and verified its size.

## Application logs

The backend emits redacted JSON logs at `DEBUG`, `INFO`, `WARNING`, `ERROR`,
and `CRITICAL` levels. Podman Compose bind-mounts the repository's ignored `logs`
directory into the backend while also sending the records to container stdout.
The active host file is `./logs/application.log`:

```bash
tail -f logs/application.log
podman compose logs --follow backend
podman compose exec backend tail -n 100 /var/log/sftp-manager/application.log
```

`LOG_LEVEL`, `LOG_MAX_BYTES`, and `LOG_BACKUP_COUNT` control verbosity and
rotation. Operational logs never replace the immutable SQLite audit history.

Podman Compose mounts durable application data from the Git-ignored host directory
`/Users/debchowd/SFTP-MANAGER/db`; the active database is
`./db/sftp-manager.db`. An empty database is created directly from the current
SQLAlchemy schema baseline. The backend has no Alembic dependency or migration
scripts; incompatible databases are rejected and may be replaced with a fresh
database after stopping the stack.

## Documentation

- [`SPEC.md`](SPEC.md) — product, security, API, and acceptance requirements
- [`docs/architecture.md`](docs/architecture.md) — runtime topology and code guide
- [`docs/operations.md`](docs/operations.md) — logging, health, deployment, and durable-state operations
- [`deploy/secrets/README.md`](deploy/secrets/README.md) — local Podman Compose secret setup
