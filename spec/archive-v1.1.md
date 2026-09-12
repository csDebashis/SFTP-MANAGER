# SFTP Management Portal — Archived monolithic specification (v1.1)

> This file is retained for historical traceability. The modular documents
> linked from the repository-root `SPEC.md` are authoritative. Do not add new
> requirements here.

| Field | Value |
|---|---|
| Status | Implementation-ready specification |
| Version | 1.1 |
| Product scope | Single-organization production deployment |
| Frontend | Node.js 24, Next.js, React, TypeScript, Material UI |
| Backend | Python 3.12, FastAPI, Pydantic, SQLAlchemy, AsyncSSH, APScheduler |
| Application persistence | Durable SQLite database |

## 1. Purpose

The SFTP Management Portal provides a secure, browser-based interface for authorized users to work with folders and files across one or more SFTP servers. It replaces direct SFTP-client access for routine operations, makes expected file-delivery work visible as actionable tasks, centralizes folder authorization, and records security-relevant activity.

The product must provide:

- Approval-based signup and secure login.
- Role-based feature access and folder-level permissions.
- A dashboard containing pending work and accessible SFTP locations.
- Full, authorized file and folder management.
- Administration of SFTP servers, credentials, users, groups, and grants.
- One-time and recurring file-related tasks.
- Immutable, authorization-aware audit history.
- A clean, responsive Material Design user experience.

## 2. Goals and success criteria

### 2.1 Goals

1. Let users reach an authorized remote folder and perform a permitted operation without a desktop SFTP client.
2. Make time-sensitive file work, such as month-end uploads, visible and actionable from the home page.
3. Give administrators one place to configure SFTP connections and manage least-privilege access.
4. Make every security-relevant or state-changing action attributable and reviewable.
5. Persist application state and audit history in SQLite behind repository contracts that permit a later migration to PostgreSQL or another production database.

### 2.2 Measurable success criteria

- 100% of backend SFTP operations perform an authorization check against the canonical target path before connecting to the remote server.
- 100% of authentication attempts, file-content transfers, file/folder mutations, administrative changes, task actions, and authorization failures produce an audit event. Successful folder listings are intentionally excluded.
- A signed-in user can reach any directly granted folder from the dashboard in no more than two interactions.
- A task call-to-action opens its exact server, folder, or administration destination.
- No API response, application log, or audit event exposes passwords, private keys, passphrases, session tokens, encryption keys, or file contents.
- Primary UI workflows meet WCAG 2.1 AA requirements.
- Repository contract tests pass for the SQLite implementation and any future persistent implementation.
- Under normal network conditions, non-SFTP API requests have a p95 response time below 500 ms; folder listings have a p95 below 3 seconds, excluding remote-server outages.

## 3. Scope

### 3.1 Included in the first release

- One organization and one shared user directory.
- Local email/password authentication.
- Admin approval of signup requests.
- Admin, Manager, User, and Auditor roles.
- Direct-user and group-based folder grants.
- One or more remote SFTP servers.
- Password and private-key SFTP authentication.
- Browse, upload, download, create-folder, rename, move, and delete operations.
- One-time and recurring task definitions and generated task instances.
- In-app task and approval queues.
- Configurable email for account approval and password-reset messages.
- Searchable, filterable, durable audit events stored in SQLite.
- Separate frontend and backend containers orchestrated by Docker Compose.
- Durable SQLite storage, schema migrations, backup, and restore procedures.

### 3.2 Excluded from the first release

- Multiple organizations or tenant isolation.
- Horizontal scaling or high availability.
- Cross-server file copy or move.
- File editing or preview in the browser.
- Antivirus, DLP, content inspection, or file transformation. An integration hook may be added later.
- SSO, SAML, OIDC, LDAP, SCIM, or external identity-provider integration.
- Public sharing links and anonymous file access.
- Native mobile applications.
- Recursive deletion of non-empty folders.

## 4. Users, roles, and authorization

### 4.1 Account states

| State | Meaning | Allowed behavior |
|---|---|---|
| `PENDING_APPROVAL` | Signup was completed but not reviewed | May view only the pending-approval page and log out |
| `ACTIVE` | Approved and enabled | May use capabilities allowed by role and grants |
| `SUSPENDED` | Temporarily disabled by an Admin | Cannot create a new session; existing sessions are immediately revoked |
| `REJECTED` | Signup was rejected | Cannot sign in; email may be reused only after an Admin removes the rejected record |

Email addresses are trimmed and compared case-insensitively. Each email is unique. A user has exactly one built-in role and may belong to zero or more groups.

### 4.2 Role matrix

| Capability | Admin | Manager | User | Auditor |
|---|:---:|:---:|:---:|:---:|
| View dashboard and own tasks | Yes | Yes | Yes | Yes |
| Use SFTP locations | All locations | According to grants | According to grants | Read-only according to grants |
| Create/edit task definitions | All locations | Locations with `MANAGE_TASKS` | No | No |
| Act on assigned tasks | Yes | Yes | Yes | No |
| Approve/manage users | Yes | No | No | No |
| Manage groups and folder grants | Yes | No | No | No |
| Configure SFTP servers/credentials | Yes | No | No | No |
| View audit events | All | Own and authorized-folder events | Own and authorized-folder events | All |
| Modify audit events | No | No | No | No |

The role defines the maximum feature set. A folder grant never elevates a user beyond the role ceiling. Admins have global access but are still audited. Auditor is always read-only even if a write permission is mistakenly included in a grant.

### 4.3 Folder permissions

The supported permission codes are:

| Permission | Allows |
|---|---|
| `LIST` | List a folder and read non-content metadata for its immediate children |
| `DOWNLOAD` | Read and download file contents |
| `UPLOAD` | Upload a new file that does not replace an existing path |
| `CREATE_FOLDER` | Create a child folder |
| `RENAME` | Rename a file or folder within its current parent |
| `MOVE` | Move a file or empty folder within the same configured SFTP server |
| `DELETE` | Delete a file or an empty folder |
| `MANAGE_TASKS` | Create and manage task definitions targeting the folder |

Each grant targets one user or one group, one enabled SFTP server, one canonical absolute path beneath that server's configured root, a non-empty permission set, and a `recursive` flag.

Authorization rules:

1. Paths are decoded exactly once, normalized to POSIX form, and resolved relative to the configured server root.
2. `..`, NUL bytes, backslashes, invalid encodings, and any result outside the configured root are rejected.
3. A non-recursive grant applies only to the exact folder. A recursive grant applies to that folder and every descendant.
4. Effective permissions are the union of all active direct-user and group grants matching the path.
5. There is no explicit deny grant in v1. To revoke access, an Admin must remove every overlapping direct and group grant. The UI must display the sources of effective access before removal.
6. Access is evaluated at request time. Removing a grant affects the next request and active transfers are cancelled when practical.
7. A user granted a deep folder sees that folder as an access root; the user does not gain visibility into its parents or siblings.
8. Remote symbolic links are hidden from listings and cannot be opened, downloaded, renamed, moved, or deleted in v1.
9. Every source and destination involved in rename or move is authorized separately.

## 5. Functional requirements

### 5.1 Authentication and account lifecycle

#### Signup

- The public signup page collects display name, email, password, and password confirmation.
- Passwords must be at least 12 characters and pass a compromised/common-password check supplied by a locally maintained deny list.
- A successful signup creates a `PENDING_APPROVAL` user and a corresponding audit event, then shows a non-enumerating confirmation message.
- Signup assigns an immutable server-generated UUIDv4 user ID. Every session, group membership, direct-user grant, task assignment, upload session, audit relationship, and subsequent user operation references that ID; an email address or display name is never used as a relational identity.
- Admin dashboards show pending signup requests. An Admin may approve, reject, or leave a request pending.
- Approval requires selection of a role and may include group membership and folder grants. Approval activates the account, invalidates any stale sessions, and sends an email when SMTP is configured.
- The first Admin is created at startup from `BOOTSTRAP_ADMIN_EMAIL` and a password read from `BOOTSTRAP_ADMIN_PASSWORD_FILE`. The password is hashed immediately and never logged.

#### Login and sessions

- Login accepts email and password and returns the same generic failure response for unknown users, incorrect passwords, rejected accounts, and suspended accounts.
- Pending users are authenticated only far enough to reach the pending-approval page.
- Passwords are hashed with Argon2id using current OWASP-recommended parameters.
- The browser receives an opaque, cryptographically random session identifier in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie.
- Session records are stored in SQLite and contain only a hash of the identifier, user ID, issued time, last-used time, expiry, CSRF secret, and client metadata.
- Default session lifetime is 8 hours with a 30-minute idle timeout. Both values are configurable.
- Session IDs rotate after login, password change, role change, and privilege change.
- Logout revokes the current session. Password reset, suspension, rejection, or role downgrade revokes all sessions for the user.
- State-changing browser requests require a CSRF token bound to the session.
- Login is rate-limited to 5 failed attempts per account and source address in 15 minutes, followed by a 15-minute lockout. Lockouts and rate-limit rejections are audited.

#### Password lifecycle

- Active users may change their password after confirming the current password.
- Forgot-password requests always return a generic success message.
- When SMTP is configured, the server emails a single-use reset token that expires after 30 minutes. Only a hash of the token is stored.
- Production configuration validation fails if SMTP is absent and password reset has not been explicitly disabled.
- Password changes and resets revoke all sessions and are audited without recording reset tokens.

#### Profile identity

- An active user may update their own display name and email address from Profile. An Admin may update those fields for any user from the user-management edit dialog.
- Profile mutations target `/users/{id}` using the immutable signup-assigned user ID. A non-Admin may target only their own ID and may not submit role or account-state changes.
- Updated email addresses are trimmed, normalized to lowercase, validated, and remain globally unique. A conflict returns HTTP 409 and leaves the existing profile unchanged.
- Changing a display name or email does not change the user ID or detach sessions, group memberships, folder grants, tasks, uploads, or audit ownership. The new email becomes the login identifier immediately.
- Profile changes are audited against the affected user ID. The UI displays the immutable user ID for clarity, shows pending progress, keeps errors with the form, and shows a two-second success notification after saving.

### 5.2 Application shell and navigation

- Use Node.js 24, Next.js App Router, React, TypeScript, Material UI, and the MUI Material Symbols icon set throughout, with a theme based on Material Design 3 principles. Do not mix in unrelated icon libraries or Unicode glyphs for application actions.
- Run the frontend as an independent Node.js service. It must proxy same-origin `/api/*` traffic to FastAPI through `BACKEND_INTERNAL_URL`; FastAPI must not serve frontend assets.
- Provide responsive navigation: permanent/mini drawer on desktop and temporary drawer on smaller screens.
- Global navigation contains Home, Files, My Activity, and Profile. Role-authorized entries add Tasks, Audit, and Admin.
- Admin contains Signup Requests, Users, Groups & Access, and SFTP Servers.
- All pages provide a visible title, keyboard-focus management, loading skeleton, empty state, recoverable error state, and permission-denied state.
- Destructive actions require a confirmation dialog describing the exact target. File deletion requires the user to type the filename when configured by policy.
- Dates are stored in UTC and displayed in the user's selected IANA timezone, defaulting to the browser timezone.
- The UI must not rely on hidden navigation for security. The API independently authorizes every request.

### 5.3 Dashboard

The authenticated home page contains:

1. **Action required** — the current user's task assignments in `PENDING`, `IN_PROGRESS`, or `OVERDUE`, ordered by overdue status and due time.
2. **Accessible folders** — access-root cards grouped by SFTP server. Selecting a card opens the file explorer at that exact path.
3. **Recent activity** — the 20 newest audit events the user is authorized to view.
4. **Administrative attention** — visible only to Admins and containing pending signup count, disabled server count, and failed task-generation count.

Each task card displays title, target server/folder, due time, status, instructions summary, and a primary action. The primary action opens the exact folder or page configured by the task. An assigned user may dismiss an assignment only after entering a reason between 3 and 500 characters. Dismissal is reversible by an Admin or an authorized Manager.

### 5.4 SFTP server administration

Only Admins may create, edit, enable, disable, test, rotate credentials for, or remove an SFTP server configuration.

Each server contains:

- Unique ID, display name, description, host, port, username, authentication type, configured remote root, pinned host-key fingerprint, enabled state, connection/operation timeouts, created/updated metadata, and integer version.
- Either a password or a private key and optional passphrase. Secrets are encrypted with AES-256-GCM using a key supplied through `APP_CREDENTIAL_ENCRYPTION_KEY_FILE`.
- A sanitized last-test result containing timestamp, latency, success/failure, and a safe error code.

Rules:

- Port defaults to 22 and must be between 1 and 65535.
- The remote root must be an absolute normalized POSIX path.
- Host-key verification is mandatory after initial enrollment. During server creation, the backend connects and authenticates first, retrieves the server's SHA-256 host-key fingerprint from the SSH handshake, and saves that fingerprint automatically in the same successful operation. The form never asks the Admin to enter a fingerprint.
- Initial enrollment uses trust on first use (TOFU). The saved fingerprint is visible on the server record for optional out-of-band verification, and every subsequent connection fails closed if the presented host key differs.
- A server configuration is not stored when the initial connection, authentication, or fingerprint discovery fails. Editing connection identity fields triggers the same connect-and-repin workflow before changes are committed.
- Secrets are write-only. Read APIs return only `credentialConfigured`, authentication type, and last-rotated timestamp.
- Editing non-secret fields leaves the credential unchanged. Credential replacement is a separate rotation action.
- Disabling a server immediately removes it from user navigation and rejects new operations and task targets.
- Server removal requires an explicit confirmation naming the server and describing the cascade. In one SQLite transaction, removal deletes the server row and encrypted credential together with every associated direct/group folder grant, task definition/instance or current task record, and unfinished resumable upload-session record. Immutable audit history is retained with a server-name snapshot and deleted-record counts, and remote SFTP folders/files are never deleted by removal.
- Connection tests do not persist a configuration unless the subsequent create/update request succeeds.
- Plaintext credential material must be zeroed or dereferenced promptly after use and must never be serialized to logs, errors, metrics, or audit metadata.

The server list is the default Admin view. An **Add another SFTP server** button expands the otherwise-collapsed form. After a successful connection and save, the form closes, clears sensitive fields, and the refreshed server list remains visible. A failed connection keeps the form open with a safe error so the Admin can correct it.

### 5.5 Folder and file explorer

The explorer provides server and access-root selection, breadcrumbs bounded by the visible access root, a sortable directory table, and permitted actions.

- The page toolbar displays **Upload files** and **Create folder** when the current folder grants those operations.
- Each file row displays **Download** plus any authorized rename, move, replace, or delete actions. Each folder row opens the child folder and displays any authorized management actions.
- Upload and download remain available to Admins and to any non-Auditor user with the corresponding folder grant. Auditors may download only when granted `DOWNLOAD` and can never upload or modify content.

#### Listing and metadata

- Folder listing requires `LIST` and returns name, relative path, type, size, modified time, and allowed actions.
- Successful folder listings are not written to audit history. A rejected listing still produces the standard authorization-denial or sensitive-validation audit event.
- Results sort folders before files by default and support server-side pagination.
- Hidden files are shown only when `SHOW_HIDDEN_FILES=true`; authorization rules remain unchanged.
- Symlinks are omitted and generate a safe diagnostic metric, not a user-visible target.

#### Upload

- Upload requires `UPLOAD` on the destination folder.
- The browser first creates a durable upload session, then sends the file as bounded raw binary chunks. The backend streams each request body directly to a uniquely named temporary object in the target SFTP folder without staging the complete file on the frontend or backend filesystem.
- On success, the temporary file is atomically renamed to the requested filename. Explicit cancellation and unrecoverable failures trigger best-effort temporary-object cleanup; transient interruptions retain the resumable object as described below.
- Users may choose one or more files with the system picker or drag and drop one or more files directly onto the current folder's directory-listing card. The listing card highlights while files are dragged over it; no separate drag-and-drop section is displayed. Every selected file captures the server and folder visible at selection time, so the user may navigate elsewhere and enqueue files for another folder without changing earlier destinations.
- Upload ownership lives in an application-level background manager rather than the Files page. Changing menus or routes does not cancel active uploads. A responsive floating window in the bottom-right corner remains visible across application navigation and shows each filename, captured server/folder destination, SFTP-confirmed progress, and state.
- The floating upload window has a Material Symbol minimize action. Its minimized state remains a single compact row containing the upload count, aggregate SFTP-confirmed progress bar and percentage, a pause/resume-all action, a cancel-all action, and an expand action. Aggregate progress is calculated as total remotely confirmed bytes divided by the total bytes of all visible jobs. Batch actions affect only unfinished eligible jobs and do not change completed uploads.
- Multiple independent files may upload concurrently to the same or different authorized folders. The browser runs up to two upload sessions concurrently by default and queues additional files, matching the default per-user transfer limit; backend authorization, configurable per-user/global limits, and distinct temporary objects remain authoritative. Concurrent non-replacement uploads targeting the same final path must never silently overwrite one another: the first completion succeeds and later completion attempts return HTTP 409.
- A chunk response reports `receivedBytes` only after the SFTP write completes and a remote `stat` confirms the temporary object's new size. The UI progress bar and percentage use this SFTP-confirmed byte count, never browser-to-proxy transmission progress. After the confirmed count reaches 100%, the UI indicates that the atomic final rename is in progress until the completion endpoint responds.
- Each queued or active upload has accessible pause and cancel icon buttons in the floating window. Pause aborts only the current bounded chunk request, retains the remote temporary object and durable upload-session record, and frees a concurrent-upload slot. Resume queries the remote temporary-object size and continues from the SFTP-confirmed offset; already confirmed chunks are not resent.
- A browser/network interruption, timeout, or temporary remote failure leaves that file and upload-session ID available in the floating window with an accessible retry/resume icon. Retrying follows the same remote-offset reconciliation used after pause.
- Explicit cancellation aborts the active request and performs best-effort deletion of only that upload's remote temporary object and durable upload-session record without interrupting other uploads. An interrupted request retains the partial temporary object so it can be resumed safely.
- The default chunk size is 4 MiB and may be configured from 64 KiB to 8 MiB. Each chunk request is rejected if it exceeds the advertised limit or would exceed the declared file size.
- Existing destinations are never silently overwritten. A conflict returns HTTP 409. Replacement requires explicit UI confirmation plus both `UPLOAD` and `DELETE`; the backend performs a replace operation with its own idempotency key and audit event.
- The filename must be a single valid path segment and pass length and character validation.
- A successful upload is evaluated against eligible automatic-completion task rules.

#### Download

- Download requires `DOWNLOAD` on the file's parent folder.
- The response streams from SFTP, sets a safe `Content-Disposition` filename, disables MIME sniffing, and never caches private content in a shared cache.
- Partial/range download is outside v1. Interrupted downloads are audited as failures or cancellations.

#### Create, rename, move, and delete

- Create-folder requires `CREATE_FOLDER` on the parent.
- Rename requires `RENAME` on the parent and rejects collisions with HTTP 409.
- Move is limited to one configured SFTP server. It requires `MOVE` at the source parent and `UPLOAD` for a file or `CREATE_FOLDER` for a folder at the destination parent. Both paths must remain within authorized roots.
- File deletion and empty-folder deletion require `DELETE` on the parent.
- Non-empty folder deletion returns HTTP 409. Recursive delete is not supported.
- Operations that the remote server cannot perform atomically must fail safely and must not report success until the final state is verified.

### 5.6 Users, groups, and access management

Admins can:

- Search and filter users by display name, email, state, role, and group.
- Approve, reject, suspend, reactivate, update role, and revoke sessions.
- Create, rename, and remove groups and edit group membership.
- Add, edit, and remove direct-user and group folder grants.
- Preview a user's effective permissions at any server path, including the grant sources.

The folder-grant list must identify the principal unambiguously. Each row displays a `User` or `Group` badge, the resolved user email address or group name, the SFTP server name, canonical folder path, recursive-inheritance state, and effective permission codes. Principal and server IDs remain the authoritative identifiers; names are display snapshots returned by the API and refreshed after every mutation.

Administration edit interactions are consistent across users, SFTP servers, credentials, folder grants, and groups:

- The Servers, Access, and Groups tabs show their existing records by default and expose prominent **Add SFTP server**, **Add folder grant**, and **Create group** buttons. Each button opens a dedicated modal create form; create forms are not expanded inline in the list.
- Successful creation closes the modal, immediately refreshes the corresponding list and count, and shows the same two-second success notification used by edit flows.
- Group create and edit forms select members through a searchable multi-select dropdown that supports selecting and removing multiple users without rendering a checkbox for every user on the page.
- Selecting **Edit** opens a modal form populated with the current record; edit fields must not replace or reuse an inline create form.
- Each SFTP server row provides a **Delete** action. Its confirmation modal states that access grants, tasks, credentials, and unfinished upload-session records will be removed while audit history and remote files remain. Success closes the modal, refreshes the Servers and Access counts, and uses the shared two-second success notification; failure remains inside the modal.
- Opening the modal and retrying a submission clear any stale error from the prior attempt.
- Submission disables submit/cancel controls as appropriate and displays an indeterminate spinner plus a progress label until the API settles.
- A failed submission leaves the modal open and shows the safe API error inside the modal directly below the form actions. Structured validation responses are converted to readable field messages and must never render as an object-coercion placeholder such as `[object Object]`.
- Modal actions are left-aligned, with the primary save/submit action first and **Cancel** immediately after it.
- A successful submission closes the modal, refreshes the corresponding list, and shows a success notification that dismisses automatically after two seconds.
- Inline create forms use the same pending spinner, stale-error clearing, in-form failure placement, refreshed list, and two-second success notification behavior.

Validation and safety rules:

- The system must always retain at least one active Admin.
- An Admin cannot demote or suspend the last active Admin.
- Group removal is blocked until the Admin confirms removal of its grants and memberships in one audited transaction.
- Grant creation verifies that the server is enabled, the path exists and is a folder, and the acting Admin can establish an SFTP connection.
- Grant edits use optimistic concurrency. Stale changes receive HTTP 412.
- Removing a grant or group membership recalculates affected users' effective access immediately.

### 5.7 Task definitions and pending actions

A task definition represents expected file work. An Admin may manage definitions anywhere. A Manager may manage a definition only when the target folder is covered by `MANAGE_TASKS`.

Each definition contains:

- ID, title, instructions, enabled state, server ID, canonical target folder, assignee user/group IDs, schedule, IANA timezone, due offset, call-to-action type, completion mode, optional filename glob, completion policy, created/updated metadata, and version.

Supported schedules are:

- `ONCE`: one local date and time.
- `DAILY`: local time and optional weekday restriction.
- `WEEKLY`: selected weekdays and local time.
- `MONTHLY`: day 1–28 or `LAST_DAY`, plus local time.

APScheduler evaluates schedules in the definition's timezone and persists generated instances in SQLite. Daylight-saving transitions use the first valid occurrence after a skipped local time and the first occurrence for a repeated local time. A database uniqueness constraint on the deterministic occurrence key prevents duplicate instances across restarts.

Task behavior:

- Group membership expands to a snapshot of individual assignments when an instance is generated.
- `dueOffsetMinutes` is applied to the scheduled occurrence and may be from 0 to 43,200 minutes.
- CTA type is either `OPEN_FOLDER` or `OPEN_PAGE`. The target is validated when the definition is saved.
- Completion mode is `MANUAL` or `MATCHING_UPLOAD`.
- `MATCHING_UPLOAD` requires a filename glob using `*` and `?` only. A successful upload or move into the exact target folder completes the uploader's assignment only when the uploader is an eligible assignee.
- Completion policy is `ANY_ASSIGNEE` or `ALL_ASSIGNEES`. `ANY_ASSIGNEE` closes remaining assignments after the first completion. `ALL_ASSIGNEES` closes the instance after every assignment is completed or dismissed.
- Assignments transition from `PENDING` to `IN_PROGRESS`, `COMPLETED`, or `DISMISSED`; a pending/in-progress assignment becomes `OVERDUE` after its due time.
- Dismissal requires a reason. Completion, dismissal, reopening, overdue transition, and automatic matching are audited.
- Editing a definition affects future instances only. Existing instances retain a snapshot of the definition fields needed for display and routing.
- Disabling a definition stops future generation but does not remove existing assignments.
- Deleting definitions is not supported. Definitions are disabled to preserve audit context.

### 5.8 Audit history

Audit events are append-only. No role, including Admin, may update or delete an event through application APIs.

Each event contains:

- `id`, UTC `timestamp`, `requestId`, optional `sessionIdHashPrefix`, actor user ID and display snapshot, action code, resource type and ID, optional server ID and canonical path, outcome (`SUCCESS`, `FAILURE`, or `DENIED`), safe reason/error code, source IP, user-agent summary, and redacted metadata.

Audit coverage includes:

- Signup, login, logout, password actions, lockout, and session revocation.
- User approval/rejection, state and role changes, groups, memberships, and grants.
- SFTP server creation, testing, change, disablement, removal, fingerprint confirmation, and credential rotation.
- Upload, download, create-folder, rename, move, replace, and delete. Successful folder listings are excluded to avoid filling audit history with routine navigation events.
- Task-definition and task-assignment lifecycle actions.
- Audit searches and exports.
- Authorization failures and sensitive validation failures.

Visibility is evaluated when events are queried:

- Admin and Auditor can view all events.
- Only Admin and Auditor responses from the dedicated audit-history endpoint include source IP and client/user-agent metadata. The dedicated audit page presents those fields inside its accessible request-details information control.
- Manager and User can view events where they are the actor plus folder-scoped events whose canonical path they can currently `LIST`.
- Manager/User activity responses and dashboard recent-activity responses never contain source IP or client/user-agent metadata, including when the dashboard belongs to an Admin or Auditor.
- Authentication events belonging to another user are never exposed to Manager or User.
- Losing folder access removes related events from subsequent results; it does not alter stored events.

The UI supports filters for date range, actor, action, outcome, server, and path. Every visible event identifies the actor, action, affected user/group or file/item, SFTP server, folder, outcome, and timestamp when those fields apply. Access-grant events show the affected principal and permissions. File upload, download, rename/move, replacement, and deletion events show the affected filename or item name. Request and resource IDs may be revealed from an accessible information control on hover or keyboard focus. Source IP and client/user-agent metadata remain in SQLite for authorized incident investigation and appear only in the Admin/Auditor audit page's request-details control; they are excluded from Manager/User activity, dashboard activity, and CSV exports. CSV export is available only to Admin and Auditor and is itself audited. Spreadsheet-formula prefixes in exported values must be escaped.

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
| `TaskDefinition` | Fields defined in section 5.7 plus `occurrenceKey` generation metadata |
| `TaskInstance` | `id`, `definitionId`, `definitionSnapshot`, `occurrenceKey`, `scheduledAt`, `dueAt`, `status`, `assignments`, `createdAt` |
| `TaskAssignment` | `userId`, `status`, `startedAt`, `completedAt`, `dismissedAt`, `dismissalReason`, `completedByEventId` |
| `AuditEvent` | Fields defined in section 5.8 |

Repository contracts must exist for every entity category and expose only domain operations, not storage-specific queries. Services depend on repository protocols/interfaces through dependency injection. SQLAlchemy repositories use explicit SQLite transactions so changes to multiple related records either commit fully or roll back fully. Alembic owns all schema changes.

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
SQLite + SQLAlchemy                  │
durable application data             ▼
                              Remote SFTP servers
```

### 7.2 Component responsibilities

- **Node.js/Next.js frontend:** an independently deployed React service providing presentation, routing, forms, accessible interactions, task context, and streaming upload/download initiation. It proxies same-origin API requests but never computes authoritative access.
- **FastAPI routes:** protocol handling, schema validation, session/CSRF enforcement, status codes, ETags, idempotency headers, and response shaping.
- **Application services:** transactions, authorization decisions, canonical-path policy, task rules, secret redaction, and audit emission.
- **Repositories:** replaceable persistence contracts implemented with SQLAlchemy and SQLite transactions in v1.
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
│   ├── alembic.ini
│   ├── migrations/
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
| `GET, PATCH /task-definitions/{id}` | Read/change definition | Scoped task authority |
| `POST /task-definitions/{id}/disable` | Disable definition | Scoped task authority |
| `GET /task-actions` | Dashboard/list assignments | Signed in, visibility-filtered |
| `POST /task-actions/{id}/start` | Start own assignment | Assignee |
| `POST /task-actions/{id}/complete` | Complete own assignment | Assignee |
| `POST /task-actions/{id}/dismiss` | Dismiss with reason | Assignee |
| `POST /task-actions/{id}/reopen` | Reopen assignment | Admin or scoped Manager |
| `GET /audit-events` | Filter audit history | Visibility-filtered |
| `GET /audit-events/export` | Export filtered CSV | Admin or Auditor |
| `GET /dashboard` | Aggregate tasks, roots, activity, attention | Signed in |
| `GET /health/live` | Process liveness | Public, no sensitive detail |
| `GET /health/ready` | Configuration and scheduler readiness | Protected at infrastructure boundary |

File routes identify the server with `serverId` and the remote location with a URL-encoded path. The backend never trusts client-provided permission flags or canonical paths.

Access-grant read, create, and update responses include `principalName` and `serverName` display fields in addition to `principalId` and `serverId`. For a group principal, `principalName` is the current group name; for a user principal, it is the current normalized email address resolved from the immutable user ID. The client must use IDs for mutations and the resolved names only for list presentation.

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
- Idempotency results are stored in SQLite for 24 hours and scoped to user, method, and normalized target. Reusing a key with a different payload returns 409.
- Concurrent writes use short SQLite transactions with a configurable busy timeout. Write transactions use `BEGIN IMMEDIATE` where serialization is required, and long SFTP network operations must not hold a database transaction open.

## 9. Security and privacy

- TLS 1.2 or newer is required at the reverse proxy. HTTP redirects to HTTPS.
- Apply HSTS in production, a restrictive Content Security Policy, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, and a strict referrer policy.
- Permit browser API access only from the configured same-origin frontend. Do not use wildcard CORS with credentials.
- Validate request bodies with strict Pydantic models; reject unknown security-sensitive fields.
- Normalize and authorize all file paths on the server. Treat filenames, remote metadata, error text, and audit metadata as untrusted output.
- Escape rendered values and CSV formula prefixes. Never render remote filenames as HTML.
- Encrypt SFTP credentials before storing them in SQLite using an externally supplied key. Do not persist that key in the database, image, or source tree.
- Redact secrets by field name and value fingerprint from structured logs and exception reporting.
- Use constant-time comparison for tokens and credential-verification artifacts where applicable.
- Cap request body sizes before parsing and enforce per-user transfer concurrency.
- The default maximum upload is 2 GiB, configurable from 1 MiB to 20 GiB.
- Default limits are 2 concurrent transfers per user, 10 globally, 10-second connection timeout, 60-second metadata-operation timeout, and 30-minute transfer timeout.
- Canonical paths are limited to 1,024 UTF-8 bytes and individual names to 255 UTF-8 bytes, subject to stricter remote limits.
- Dependency and container-image vulnerability scans must run in CI. Critical known vulnerabilities block release unless formally accepted.

## 10. Accessibility and visual design

- Meet WCAG 2.1 AA for login, signup, dashboard, explorer, task actions, administration, and audit workflows.
- All functionality must be keyboard operable with visible focus indicators and logical focus order.
- Icon-only controls require accessible names. Status must not be communicated by color alone.
- Application actions use MUI Material Symbol components. Buttons and icon buttons use consistent rounded, elevated light surfaces; hover provides a short lift and scale treatment that remains restrained enough to avoid layout movement, while keyboard focus remains visibly outlined. Hover and press transforms are disabled when the user requests reduced motion.
- Adjacent icon-action groups reserve a visible gap and may wrap at constrained widths or browser zoom levels, so hover magnification never overlaps another control or hides its focus/target surface.
- Tables provide proper headers and accessible sorting state. Dialogs trap focus and return it to the invoking control.
- Upload progress and task state changes use polite live regions. Background-upload minimize/expand, per-file pause/resume/retry/cancel, and aggregate pause/resume/cancel icons have visible tooltips and accessible names identifying their scope.
- Support 200% zoom without loss of primary functionality and reflow down to 320 CSS pixels.
- Use a consistent 8-pixel spacing system, responsive breakpoints, light/dark-compatible theme tokens, and clear elevation hierarchy.
- Avoid exposing raw remote/server error text. Provide a user-safe message, retry where appropriate, and the request ID for support.

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

## 14. Test strategy

### 14.1 Unit tests

- Role ceilings and every folder permission.
- Direct/group grant union, recursive matching, removal, and deep-folder access roots.
- Canonical path normalization, traversal rejection, encoded traversal, invalid Unicode, and symlink rejection.
- Password policy, hashing, session expiry/rotation, CSRF, rate limiting, and last-Admin protection.
- Credential encryption/decryption and mandatory redaction.
- Task recurrence across month-end, leap year, timezone, and daylight-saving boundaries.
- Assignment snapshots, completion policies, automatic filename matching, dismissal, and overdue transitions.
- Audit visibility, event immutability, metadata redaction, and CSV escaping.
- SQLAlchemy repository transactions, constraints, migration behavior, and shared contract suite.

### 14.2 Integration tests

Run against a disposable SFTP server and cover:

- Password and private-key authentication.
- Valid and mismatched host keys.
- Root-folder enforcement and inaccessible parents/siblings.
- Listing, streamed upload/download, atomic upload completion, replacement, create, rename, move, and deletion.
- Filename collisions, missing paths, non-empty folder deletion, permission errors, server outage, timeout, transfer cancellation, and cleanup.
- Connection-pool invalidation after configuration or credential changes.
- SFTP server deletion atomically cascades through access grants, tasks, credentials, and resumable upload-session records while preserving audit history and remote files.
- Task auto-completion after a matching upload and no completion after an ineligible upload.

### 14.3 API and authorization tests

- Public routes expose only intended behavior.
- Missing/expired sessions and CSRF tokens fail correctly.
- Pending, suspended, rejected, Manager, User, and Auditor restrictions match the role matrix.
- User profile updates target the immutable user ID, normalize and uniquely validate email changes, preserve all ID-based relationships, and prevent a user from editing another account or changing their own role/state.
- Direct calls cannot bypass hidden UI actions or folder grants.
- Source and destination authorization is enforced for rename/move/replace.
- Pagination cursors, ETags, stale updates, and idempotency replay/conflict behavior are correct.
- Error envelopes never reveal inaccessible resource existence or remote secrets.
- Every required action produces exactly one primary audit event with the correct outcome.

### 14.4 UI and accessibility tests

- Signup, pending approval, approval, login, logout, reset, password change, and self-service display-name/email updates by immutable user ID.
- Dashboard ordering, task CTA routing, dismiss reason validation, folder cards, and recent activity.
- Breadcrumb-bound folder navigation and every file operation.
- Server setup/test/rotation/deletion, including cascade confirmation and refreshed dependent counts; user management, group/grant editing, task configuration, and audit filtering/export.
- Access-grant rows identify the specific user or group and server, including after names are changed and the list is refreshed.
- Server, access-grant, and group creation begins from an add button, uses a modal form, refreshes the list/count on success, and follows the shared pending/error/success interaction rules.
- Group member selection is a searchable multi-select that remains usable with a large user directory in both create and edit dialogs.
- User, server, credential, grant, and group edit actions open populated modal forms; user forms expose display name and unique email while retaining the immutable user ID; pending requests show spinners, failures remain in the modal, retries clear stale errors, successful saves close the modal, and success notifications disappear after two seconds.
- Edit-dialog actions are left-aligned in primary-action-then-Cancel order, and invalid paths produce readable validation text rather than serialized objects.
- Audit rows show actor, action, affected access principal or file/item, server, folder, outcome, and timestamp. The Admin/Auditor audit information tooltip/focus control shows request/resource IDs, source IP, and client details; Manager/User activity and dashboard responses never receive or display the sensitive fields.
- Upload API and UI tests cover multi-file picker and directory-card drag-and-drop selection, concurrent same/different-folder sessions, persistence across menu navigation, the floating progress window, its compact aggregate-progress state, minimize/expand and independent/batch pause/resume/retry/cancel controls, bounded raw chunks, SFTP-stat-confirmed progress, remote-finalization state, cancellation/network failure, remote-offset resume, atomic completion, same-target conflict protection, and refreshed directory contents. Deployment tests upload a file larger than Next.js's former 10 MiB proxy threshold and verify its final remote size and content.
- Loading, empty, offline, timeout, forbidden, conflict, stale-update, and partial-stream failure states.
- Automated accessibility scans plus keyboard and screen-reader smoke tests for primary journeys.
- Responsive behavior at 320 px, tablet, desktop, and 200% browser zoom; adjacent hover-magnified action icons remain separated and usable.

### 14.5 Operational and security tests

- Startup rejects unsafe/missing configuration, an unwritable database path, and incompatible schema versions.
- Operational logging tests cover every supported severity, HTTP status mapping, valid JSON-lines output, request-ID/route correlation, rotation settings, persistent container filesystem output, and exclusion of query strings, payloads, credentials, raw exceptions, IP addresses, and client metadata.
- Health endpoints and metrics reflect scheduler and remote-server failures correctly.
- Restart and container replacement preserve SQLite records and do not affect remote files.
- Backup integrity and restore drills recover users, grants, tasks, encrypted credentials, and audit history.
- Concurrent-write tests exercise the busy timeout, transaction rollback, task occurrence uniqueness, and idempotency uniqueness.
- Brute-force, session fixation, CSRF, traversal, malicious filename, oversized upload, CSV injection, stored/reflected XSS, and secret-leak tests.
- Dependency, static-analysis, and container-image scans.

## 15. Acceptance criteria and traceability

| ID | Acceptance criterion |
|---|---|
| `AC-01` | A visitor can sign up, remains pending, and cannot access application data until an Admin approves the account. |
| `AC-01A` | Signup assigns an immutable UUID user ID. A user can update their own display name and unique normalized email without changing that ID or losing sessions, groups, grants, tasks, uploads, or audit attribution; every user-related mutation targets the ID, and only Admins may change another user or role/state. |
| `AC-02` | Role-based navigation and backend authorization expose Admin features only to Admins and scoped task management only to eligible Managers. |
| `AC-03` | The dashboard shows the signed-in user's actionable/overdue assignments and all accessible SFTP access roots. |
| `AC-04` | Selecting a task CTA or folder card opens the exact authorized folder/page and never exposes an unauthorized ancestor. |
| `AC-05` | Users can browse, upload, download, create, rename, move, replace, and delete only when the required folder permissions are effective; multiple uploads support file-picker and drag-and-drop selection on the directory-listing card, concurrent same/different-folder background operation across menu navigation, bottom-right progress with expanded per-file controls and a minimized single-row aggregate progress plus batch pause/resume/cancel controls, bounded direct-to-SFTP chunks, progress calculated only from remotely written and size-verified bytes, cancellation cleanup, offset-based resume after pause or failure, same-target conflict protection, and files larger than the frontend proxy's former 10 MiB default. |
| `AC-06` | An Admin can configure password/private-key SFTP servers without entering a host fingerprint; a successful initial connection automatically pins the discovered key, closes the form, and refreshes the server list, while a failed connection saves nothing. An Admin can also confirm server deletion, which atomically removes its credentials, access grants, tasks, and unfinished upload sessions while retaining audit history and remote files. |
| `AC-07` | An Admin can add, edit, and remove user/group folder grants, see the specific user or group and server on every grant row, and preview effective access; edit failures remain inside a spinner-backed modal and successful saves close it, refresh the list, and show a two-second success notification. |
| `AC-08` | Admins and authorized Managers can define one-time/month-end or other supported recurring tasks; instances are generated once per occurrence. |
| `AC-09` | Assigned users can start, complete, or dismiss tasks; dismissal requires a reason and configured matching uploads can complete assignments. |
| `AC-10` | Required authentication, file-content transfer, file/folder mutation, task, access, server, and audit-query actions create immutable, secret-free audit events; successful folder listings do not create or appear as audit events. Source IP/client metadata is serialized only by the dedicated audit endpoint for Admin/Auditor sessions and never by Manager/User or dashboard activity APIs. |
| `AC-11` | Users see their own and currently authorized-folder events; Admins and Auditors can search all events; no role can modify audit history. |
| `AC-12` | All file content is streamed, paths are canonicalized, symlinks/traversal are rejected, and remote roots cannot be escaped. |
| `AC-13` | The backend persists application state through SQLAlchemy repository interfaces and SQLite, and repository contract tests permit a later database implementation without API changes. |
| `AC-14` | Restarting or replacing containers preserves users, configuration, sessions, tasks, and audit history through the SQLite volume, while remote SFTP files remain unchanged. |
| `AC-15` | Primary workflows meet WCAG 2.1 AA and pass the defined functional, integration, authorization, security, and operational test suites. |

Release approval requires all acceptance criteria to pass in a production-like environment. Any exception must be documented with owner, risk, mitigation, and expiry date.

## 16. Product assumptions

- “Materials views” means a modern Material Design interface built with Material UI.
- The portal serves one organization, and all configured SFTP servers belong to that organization.
- Server-side authorization is authoritative; frontend guards exist only for usability.
- SFTP files and folder metadata remain authoritative on remote servers and are not copied into application repositories.
- Email is used only for account lifecycle notifications in v1; task reminders are in-app.
- English is the only supported interface language in v1, while filenames may contain valid Unicode supported by the remote server.
- SQLite is the durable application system of record; remote SFTP servers remain the system of record for file content and remote folder metadata.
