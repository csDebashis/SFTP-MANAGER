# Operations guide

## Operational logging

The backend writes the same redacted JSON-lines records to stdout and to a
rotating file. The Compose deployment stores the files in the persistent
`application_logs` volume at:

```text
/var/log/sftp-manager/application.log
```

Local, non-container execution defaults to `./logs/application.log` from the
process working directory.

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
docker compose exec backend tail -n 100 /var/log/sftp-manager/application.log
```

Inspect the persistent volume location managed by Docker:

```bash
docker volume inspect sftp-manager_application_logs
```

The application never exposes operational files through an HTTP endpoint.
Access to the Docker host and volume should be limited to operators. Collectors
must preserve JSON lines and apply an independent retention policy before old
rotations are removed.

## Health and startup

- `/api/v1/health/live` confirms the API event loop responds.
- `/api/v1/health/ready` confirms database and scheduler readiness without
  requiring every remote SFTP server to be online.
- Alembic migrations run before Uvicorn accepts traffic.
- The backend runs one worker so APScheduler has one owner and SQLite writes
  remain coordinated.

After deploying, `scripts/verify-build-deploy.sh` waits for both health checks
and verifies that the backend filesystem log exists and is non-empty.

## Durable state and backup

SQLite lives in the `sqlite_data` volume at `/data/sftp-manager.db`. Do not copy
only the main database file while the service is writing; use SQLite's online
backup API or stop the backend and capture the database together with its WAL
state. Remote SFTP file contents are not stored in SQLite.

Application logs and SQLite use separate volumes. Backing up one does not back
up the other.

## Incident correlation

Use the response `X-Request-ID` to correlate a user-visible failure with the
operational log and, when the action is auditable, its SQLite audit event.
Operational logs intentionally omit source IP, client metadata, payloads, raw
exceptions, and secrets. Authorized Admin/Auditor audit views are the controlled
place for incident metadata captured by the product.
