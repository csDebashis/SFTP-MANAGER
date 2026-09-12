# Architecture and code guide

This document is the starting point for maintainers. Product behavior and
acceptance criteria remain authoritative in the domain modules indexed by
[`SPEC.md`](../SPEC.md).

## Runtime topology

The system deliberately separates the browser application from the API:

```text
Browser
  │
  ▼
Next.js / React frontend (port 3000)
  │  same-origin /api proxy
  ▼
FastAPI backend (private Compose network)
  ├── SQLite durable application state (/data)
  ├── JSON operational logs (/var/log/sftp-manager)
  └── AsyncSSH connections to configured SFTP servers
```

The frontend and backend have independent Dockerfiles and non-root runtime
images. Only the frontend is published to the host by the reference Compose
deployment.

## Backend modules

- `app/main.py` owns the application factory, HTTP schemas, route handlers,
  request IDs, status-to-severity logging, authorization, and audit emission.
- `app/models.py` defines SQLAlchemy entities. Relationships use immutable,
  generated user and resource UUIDs; mutable names and email addresses are not
  identifiers.
- `app/db.py` configures SQLite, async sessions, foreign-key enforcement, WAL
  mode, and transactional access.
- `app/security.py` centralizes password hashing, session/token derivation, and
  encrypted SFTP credential handling.
- `app/sftp/gateway.py` is the trust boundary for canonical remote paths,
  verified host keys, streamed transfers, and the local mock adapter.
- `app/logging_config.py` configures redacted operational logging. It never
  replaces the append-only business audit trail.

Alembic migrations in `backend/migrations/versions` are the only supported way
to change the production schema. Add a migration whenever a persisted model
changes.

## Request and authorization flow

1. The frontend sends a same-origin request and includes the session cookie.
2. Middleware assigns or bounds an `X-Request-ID` and starts timing the request.
3. FastAPI validates the wire schema before a service operation runs.
4. The backend resolves the current user by the session's immutable user UUID.
5. File operations canonicalize every source and destination, calculate current
   role/grant permissions, and only then connect to SFTP.
6. A state-changing or security-relevant operation writes its audit event in
   the same transaction where practical.
7. Middleware returns the request ID and emits one safe operational completion
   record using the route template, status, and duration.

Remote folder listing is intentionally not audited. Upload, download, create,
rename, move, replace, and delete operations are audited.

## Upload lifecycle

Uploads are resumable sessions rather than one large proxied request. The
browser sends bounded chunks, and the backend streams each chunk to a uniquely
named temporary object on SFTP. Progress advances only after the gateway checks
the remote object size. A completed object is atomically renamed to the desired
filename. A failed browser request can resume from the last server-confirmed
offset; cancel performs best-effort temporary-object cleanup.

The upload manager lives above route-level UI, so navigation does not destroy
active sessions. It supports concurrent files, per-file pause/resume/cancel,
aggregate controls, retry, and compact/expanded progress views.

## Audit records versus application logs

These stores have distinct purposes:

| Store | Purpose | Location | User-visible |
|---|---|---|---|
| Audit events | Immutable business/security evidence | SQLite | Subject to audit visibility rules |
| Application log | Runtime diagnosis and operations | Rotating JSON-lines file and stdout | Never exposed by application APIs |

Operational logs must contain no request bodies, query strings, cookies,
credentials, remote banners, file contents, or raw exception messages. Add new
context fields only by extending the explicit allow-list in
`logging_config.py` and adding a redaction test.

## Change checklist

When changing behavior:

1. Update the relevant domain module linked from `SPEC.md`.
2. Preserve UUID-based relationships and backend authorization.
3. Add focused backend and/or frontend tests, including failure behavior.
4. Add an Alembic migration for schema changes.
5. Run `./scripts/verify-build-deploy.sh --verify-only` before review.
