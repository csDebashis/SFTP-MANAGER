# Data, architecture, and API

Owner: Backend platform. Related modules: [operations](09-operations-and-persistence.md),
[quality](10-quality-and-acceptance.md).

## 6. Domain model

All IDs are server-generated UUIDv4 values. A user's ID is assigned during signup and is immutable; email and display-name changes never rewrite references to that user. All timestamps use RFC 3339 UTC strings. Mutable records contain an integer `version` incremented after each successful change.

| Entity | Required fields |
|---|---|
| `User` | `id`, `emailNormalized`, `displayName`, `passwordHash`, `role`, `state`, `timezone`, `createdAt`, `updatedAt`, `version` |
| `Session` | `idHash`, `userId`, `csrfSecretHash`, `issuedAt`, `lastUsedAt`, `expiresAt`, `clientMetadata` |
| `PasswordResetToken` | `tokenHash`, `userId`, `expiresAt`, `usedAt` |
| `Group` | `id`, `name`, `description`, `memberUserIds`, `createdAt`, `updatedAt`, `version` |
| `SftpServer` | `id`, `name`, `host`, `port`, `username`, `authType`, `encryptedCredential`, `rootPath`, `hostKeyFingerprint`, `enabled`, `timeouts`, `lastTest`, `version` |
| `FolderGrant` | `id`, `principalType`, `principalId`, `serverId`, `canonicalPath`, `permissions`, `recursive`, `createdBy`, `createdAt`, `version` |
| `FileUpload` | `id`, `userId`, `serverId`, `folderPath`, `filename`, `totalSize`, SFTP-confirmed `receivedSize`, `replace`, `status`, `createdAt`, `updatedAt` |
| `TaskDefinition` | Fields defined in section 5.7 plus exactly one of `assigneeUserId`/`assigneeGroupId`, `fileCheckIntervalMinutes`, `lastCheckedAt`, and occurrence-key generation metadata |
| `TaskInstance` | `id`, `definitionId`, `occurrenceKey`, `scheduledAt`, `dueAt`, exactly one of `assigneeUserId`/`assigneeGroupId`, definition display/routing snapshot, `status`, `fileCheckIntervalMinutes`, `lastCheckedAt`, `nextCheckAt`, `createdAt` |
| `AuditEvent` | Fields defined in section 5.8 |

Repository contracts must exist for every entity category and expose only domain
operations, not storage-specific queries. Services depend on repository
protocols/interfaces through dependency injection. SQLAlchemy repositories use
explicit transactions so changes to multiple related records either commit
fully or roll back fully. The current SQLAlchemy metadata is the authoritative
schema baseline for both SQLite and PostgreSQL; no migration framework is used.

## 7. System architecture

### 7.1 Logical architecture

```text
Browser
  │
  ▼
Node.js + Next.js + React + TypeScript + Material UI
  │ HTTPS / JSON / streamed files
  ▼
FastAPI route layer
  validation · session/CSRF middleware · request IDs
  │
  ▼
Application services
  authentication · authorization · files · tasks · administration · audit
  ├───────────────┬──────────────────┐
  ▼               ▼                  ▼
Repositories   APScheduler        SFTP gateway
  │               │                  │
  └───────┬───────┘                  ▼
          ▼                    AsyncSSH connection pools
SQLite/PostgreSQL + SQLAlchemy       │
durable application data             ▼
                              Remote SFTP servers
```

### 7.2 Component responsibilities

- **Node.js/Next.js frontend:** an independently deployed React service providing presentation, routing, forms, accessible interactions, task context, and streaming upload/download initiation. It proxies same-origin API requests but never computes authoritative access.
- **FastAPI routes:** protocol handling, schema validation, session/CSRF enforcement, status codes, ETags, idempotency headers, and response shaping.
- **Application services:** transactions, authorization decisions, canonical-path policy, task rules, secret redaction, and audit emission.
- **Repositories:** replaceable persistence contracts implemented with
  SQLAlchemy, using SQLite for Compose and PostgreSQL for durable Vercel
  deployments.
- **SFTP gateway:** connection establishment, host-key verification, remote path handling, bounded pooling, streaming, timeout mapping, and safe cleanup.
- **Scheduler:** generation of task instances and overdue transitions. A single elected scheduler process uses database uniqueness constraints to prevent duplicate occurrences.
- **Observability:** structured operational logs, metrics, traces/correlation IDs, and health state. Operational logs are separate from audit events.

### 7.3 Future project structure

The implementation should use the following structure. The deployment artifacts shown here are included alongside this specification; application source and manifests are added during implementation.

```text
SFTP-MANAGER/
├── SPEC.md
├── README.md
├── compose.yaml
├── scripts/
│   └── verify-build-deploy.sh
├── deploy/
│   └── secrets/                 # Local Compose secret files (never committed)
├── backend/
│   ├── Dockerfile
│   ├── pyproject.toml
│   ├── app/
│   │   ├── main.py
│   │   ├── api/                 # FastAPI routers and wire schemas
│   │   ├── auth/                # Passwords, sessions, CSRF, dependencies
│   │   ├── core/                # Configuration, errors, shared policies
│   │   ├── models/              # Domain entities and enums
│   │   ├── repositories/        # Protocols and SQLAlchemy implementations
│   │   ├── services/            # Application use cases and authorization
│   │   ├── sftp/                # AsyncSSH gateway and path safety
│   │   ├── scheduler/           # Task generation and overdue processing
│   │   └── observability/       # Logging, metrics, health, request IDs
│   └── tests/
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── package-lock.json
│   ├── next.config.ts
│   ├── src/
│   │   ├── app/                 # Next.js routes, layouts, and providers
│   │   ├── api/                 # Typed HTTP client and generated types
│   │   ├── components/          # Shared presentational components
│   │   ├── features/            # Auth, files, tasks, admin, audit
│   │   ├── theme/               # Material theme and design tokens
│   │   └── types/               # Client-only TypeScript types
│   └── tests/
└── docs/
    ├── architecture.md
    ├── api.md
    ├── security.md
    └── operations.md
```

## 8. REST API contract

All endpoints are under `/api/v1`. JSON uses camelCase. Except for signup, login, password reset, and health endpoints, requests require an active session. State-changing browser requests also require `X-CSRF-Token`.

### 8.1 Endpoint inventory

| Method and path | Purpose | Minimum authorization |
|---|---|---|
| `POST /auth/signup` | Create pending user | Public |
| `POST /auth/login` | Create session | Public |
| `POST /auth/logout` | Revoke current session | Signed in |
| `GET /auth/me` | Current user, role, navigation capabilities | Signed in |
| `POST /auth/password/forgot` | Request reset email | Public |
| `POST /auth/password/reset` | Consume reset token | Public |
| `POST /auth/password/change` | Change own password | Active user |
| `GET /users` | Search users/signup requests | Admin |
| `POST /users/{id}/approve` | Approve with role/access | Admin |
| `POST /users/{id}/reject` | Reject signup | Admin |
| `PATCH /users/{id}` | Update display name/email; Admin may also update role/state | Admin or self; self is profile-only |
| `POST /users/{id}/revoke-sessions` | Revoke all sessions | Admin |
| `GET, POST /groups` | List/create groups | Admin |
| `GET, PATCH, DELETE /groups/{id}` | Read/change/remove group | Admin |
| `GET, POST /access-grants` | List/create grants | Admin |
| `PATCH, DELETE /access-grants/{id}` | Change/remove grant | Admin |
| `GET /users/{id}/effective-access` | Explain effective access | Admin or self |
| `GET, POST /sftp-servers` | List/create server configurations | Admin |
| `GET, PATCH, DELETE /sftp-servers/{id}` | Read/change/remove server | Admin |
| `POST /sftp-servers/test` | Test unsaved configuration | Admin |
| `POST /sftp-servers/{id}/test` | Test saved configuration | Admin |
| `POST /sftp-servers/{id}/rotate-credential` | Replace credential | Admin |
| `GET /files/roots` | List visible access roots | Active user |
| `GET /files/list` | List folder | `LIST` |
| `POST /files/uploads` | Create resumable upload and remote temporary object | `UPLOAD` |
| `GET /files/uploads/{id}` | Return SFTP-confirmed resumable-upload offset | Upload owner with `UPLOAD` |
| `PUT /files/uploads/{id}/content` | Stream one bounded chunk to SFTP at `X-Upload-Offset` | Upload owner with `UPLOAD` |
| `POST /files/uploads/{id}/complete` | Verify size and atomically expose uploaded file | Upload owner with `UPLOAD` |
| `DELETE /files/uploads/{id}` | Cancel upload and remove its temporary object | Upload owner |
| `GET /files/download` | Stream download | `DOWNLOAD` |
| `POST /files/folders` | Create folder | `CREATE_FOLDER` |
| `POST /files/rename` | Rename item | `RENAME` |
| `POST /files/move` | Move item | `MOVE` plus destination permission |
| `POST /files/replace` | Explicitly replace file | `UPLOAD` and `DELETE` |
| `DELETE /files/item` | Delete file or empty folder | `DELETE` |
| `GET, POST /task-definitions` | List/create definitions | Scoped; create requires Admin or `MANAGE_TASKS` Manager |
| `GET, PATCH, DELETE /task-definitions/{id}` | Read/change/delete definition and generated work | Scoped task authority |
| `POST /task-definitions/{id}/disable` | Disable definition | Scoped task authority |
| `GET /tasks` | List assignments in urgency/recent-assignment order | Signed in, visibility-filtered |
| `POST /tasks/{id}/start` | Start own assignment | Assignee |
| `POST /tasks/{id}/complete` | Complete own manual assignment; matching-file work is rejected | Assignee |
| `POST /tasks/{id}/dismiss` | Dismiss with reason | Assignee |
| `POST /tasks/{id}/reopen` | Reopen assignment | Admin or scoped Manager |
| `POST /tasks/{id}/check` | Force exact-folder validation for a matching-file assignment | Assignee, Admin, or scoped Manager |
| `GET /audit-events` | Filter audit history | Visibility-filtered |
| `GET /audit-events/export` | Export filtered CSV | Admin or Auditor |
| `GET /dashboard` | Aggregate tasks, roots, activity, attention | Signed in |
| `GET /health/live` | Process liveness | Public, no sensitive detail |
| `GET /health/ready` | Configuration and scheduler readiness | Protected at infrastructure boundary |

File routes identify the server with `serverId` and the remote location with a URL-encoded path. The backend never trusts client-provided permission flags or canonical paths.

Access-grant read, create, and update responses include `principalName` and `serverName` display fields in addition to `principalId` and `serverId`. For a group principal, `principalName` is the current group name; for a user principal, it is the current normalized email address resolved from the immutable user ID. The client must use IDs for mutations and the resolved names only for list presentation.

Task responses include `serverName`, `assigneeType`, and the authoritative
`assigneeId`. A group-owned task is one shared record selected through current
`GroupMember` rows; no per-member task copies are generated. Task-definition
create/update validates that the selected user or group exists. Task-list,
dashboard, manual folder-check, portal file-matching, and task-action
authorization all evaluate current group membership.

### 8.2 Pagination and filtering

- Collection responses use cursor pagination with `items` and `nextCursor`.
- Default page size is 50; the maximum is 200.
- Cursors are opaque, signed, expire after 15 minutes, and encode the stable sort boundary and normalized filters.
- Audit default sort is newest first. File default sort is folder-first, case-insensitive name order.
- Invalid or expired cursors return HTTP 400 with `INVALID_CURSOR`.

### 8.3 Errors

Every non-streaming error uses this envelope:

```json
{
  "error": {
    "code": "FOLDER_ACCESS_DENIED",
    "message": "You do not have access to this folder.",
    "requestId": "01J...",
    "fieldErrors": []
  }
}
```

Rules:

- Messages are safe for users and do not reveal credentials, existence of inaccessible resources, stack traces, or remote server banners.
- HTTP 401 means no valid session; 403 means known but forbidden; 404 is used when revealing existence would leak unauthorized data; 409 represents state/path conflicts; 412 represents stale versions; 422 represents field validation; 429 represents rate limiting; 502 represents a safe SFTP protocol/remote failure; and 504 represents remote timeout.
- Streaming failures after headers are sent terminate the stream and emit an audit event plus operational log with the request ID.

### 8.4 Concurrency and idempotency

- Mutable-resource reads return an `ETag` derived from the record version.
- Admin updates require `If-Match`; missing headers return 428 and stale versions return 412.
- File mutations, signup approval, credential rotation, and task actions require `Idempotency-Key` UUID headers.
- Idempotency results are stored in the configured durable database for 24
  hours and scoped to user, method, and normalized target. Reusing a key with a
  different payload returns 409.
- Concurrent writes use short database transactions. SQLite applies a
  configurable busy timeout and `BEGIN IMMEDIATE` where serialization is
  required; PostgreSQL relies on transactional constraints. Long SFTP network
  operations must not hold a database transaction open.
