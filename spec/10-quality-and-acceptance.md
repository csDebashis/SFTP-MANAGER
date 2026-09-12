# Quality and acceptance

Owner: Quality engineering. Every behavior-changing pull request updates this
module when its release evidence or acceptance contract changes.

## 14. Test strategy

### 14.1 Unit tests

- Role ceilings and every folder permission.
- Direct/group grant union, recursive matching, removal, and deep-folder access roots.
- Canonical path normalization, traversal rejection, encoded traversal, invalid Unicode, and symlink rejection.
- Password policy, hashing, session expiry/rotation, CSRF, rate limiting, and last-Admin protection.
- Credential encryption/decryption and mandatory redaction.
- Task recurrence across month-end, leap year, timezone, and daylight-saving boundaries.
- Scheduler startup catch-up, schedule-time first assignment visibility,
  deterministic occurrence uniqueness, exact-folder matching for externally
  delivered and already-present files regardless of preserved remote modified
  time, selectable 5/10/30-minute, hourly, and daily check cadence, persisted
  last/next-check timestamps, forced user refresh, absent-file overdue behavior,
  and recovery from a temporary SFTP scan failure.
- Shared group work-item consistency under member add/remove, automatic filename
  matching, rejection of manual matching-file completion, dismissal, urgency
  thresholds, due-frequency bounds, schedule deletion, and overdue transitions.
- Audit visibility, event immutability, metadata redaction, and CSV escaping.
- SQLAlchemy repository transactions, constraints, fresh baseline initialization,
  baseline marker/table/column validation, incompatible-database rejection, and
  shared contract suite.

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
- Dashboard/task ordering (overdue then recent pending), orange due-soon and red
  overdue treatments without a visible half-time message, lifecycle status,
  labeled due date/time, non-visual accessible urgency, matching-file refresh,
  last-check display, exact SFTP-folder CTA routing, dismiss reason validation,
  SFTP server and folder columns, folder cards, and recent activity.
- Task-definition add/edit modal flows, Repeat choices, conditional
  daily/weekly/monthly fields, matching-file interval validation, compact
  user/group assignee selection, due-frequency validation, schedule table,
  complete hover/focus details, confirmed deletion, and refreshed definitions.
- Breadcrumb-bound folder navigation and every file operation, including
  pre-populated inline file/folder rename without a browser prompt, adjacent
  Save/Cancel controls, Enter/Escape keyboard behavior, pending progress,
  listing refresh on success, and readable in-row validation/API failures;
  same-server move uses a modal accessible-folder picker with root/breadcrumb
  navigation, folder-only choices, invalid/unauthorized destination prevention,
  pending indicators, refreshed success state, and retryable in-dialog errors.
- Server setup/test/rotation/deletion, including cascade confirmation and refreshed dependent counts; user management, group/grant editing, task configuration, and audit filtering/export.
- Access-grant rows identify the specific user or group and server, including after names are changed and the list is refreshed.
- Server, access-grant, and group creation begins from an add button, uses a modal form, refreshes the list/count on success, and follows the shared pending/error/success interaction rules.
- Group member selection is a searchable multi-select that remains usable with a large user directory in both create and edit dialogs.
- Group rows expose an eye/view member dialog with searchable resolved members,
  per-member removal, pending spinner, in-dialog error, refreshed membership,
  and immediate effective-access recalculation.
- Profile identity and password forms remain closed until their respective
  actions open modal dialogs; success closes the modal and displays for two
  seconds, while failure remains highlighted inside the active modal.
- User, server, credential, grant, and group edit actions open populated modal forms; user forms expose display name and unique email while retaining the immutable user ID; pending requests show spinners, failures remain in the modal, retries clear stale errors, successful saves close the modal, and success notifications disappear after two seconds.
- Edit-dialog actions are left-aligned in primary-action-then-Cancel order, and invalid paths produce readable validation text rather than serialized objects.
- A dense, sticky-header audit table uses balanced action, actor, resource,
  location, outcome, and time columns so more records fit without large unused
  gaps. The Admin/Auditor audit information tooltip/focus control shows
  request/resource IDs, source IP, and client details; Manager/User activity and
  dashboard responses never receive or display the sensitive fields.
- Upload API and UI tests cover multi-file picker and directory-card drag-and-drop selection, concurrent same/different-folder sessions, persistence across menu navigation, the floating progress window, its compact aggregate-progress state, minimize/expand and independent/batch pause/resume/retry/cancel controls, bounded raw chunks, SFTP-stat-confirmed progress, remote-finalization state, cancellation/network failure, remote-offset resume, atomic completion, same-target conflict protection, and refreshed directory contents. Deployment tests upload a file larger than Next.js's former 10 MiB proxy threshold and verify its final remote size and content.
- Loading, empty, offline, timeout, forbidden, conflict, stale-update, and partial-stream failure states.
- Automated accessibility scans plus keyboard and screen-reader smoke tests for primary journeys.
- Responsive behavior at 320 px, tablet, desktop, and 200% browser zoom; adjacent hover-magnified action icons remain separated and usable.

### 14.5 Operational and security tests

- Startup rejects unsafe/missing configuration, an unwritable database path,
  and databases whose marker or table/column shape differs from the current
  non-migrating schema baseline.
- Operational logging tests cover every supported severity, HTTP status mapping, valid JSON-lines output, request-ID/route correlation, rotation settings, persistent container filesystem output, and exclusion of query strings, payloads, credentials, raw exceptions, IP addresses, and client metadata.
- Compose deployment tests verify that `/var/log/sftp-manager/application.log`
  is the same non-empty file exposed in the Git-ignored host
  `/Users/debchowd/SFTP-MANAGER/logs` directory, and that
  `/data/sftp-manager.db` is the same valid SQLite database exposed in the
  Git-ignored host `/Users/debchowd/SFTP-MANAGER/db` directory with the current
  baseline marker and no Alembic metadata table.
- Health endpoints and metrics reflect scheduler and remote-server failures correctly.
- Restart and container replacement preserve SQLite records and do not affect remote files.
- Fresh-start tests initialize the complete current schema and baseline marker
  in an empty host `db` directory, preserve data when reopening the same
  baseline, and reject pre-baseline databases without running migrations.
- Concurrent-write tests exercise the busy timeout, transaction rollback, task occurrence uniqueness, and idempotency uniqueness.
- Brute-force, session fixation, CSRF, traversal, malicious filename, oversized upload, CSV injection, stored/reflected XSS, and secret-leak tests.
- Dependency, static-analysis, and container-image scans.
- Vercel deployment tests validate that the committed Services configuration
  routes `/api/*` to FastAPI before the Next.js catch-all, and that the Vercel
  demo runtime selects writable `/tmp` storage, seeded demo users, and secure
  cookies without requiring committed secrets, even when optional Vercel system
  variables are absent or inherited filesystem settings target read-only paths.

## 15. Acceptance criteria and traceability

| ID | Acceptance criterion |
|---|---|
| `AC-01` | A visitor can sign up, remains pending, and cannot access application data until an Admin approves the account. |
| `AC-01A` | Signup assigns an immutable UUID user ID. A user can update their own display name and unique normalized email without changing that ID or losing sessions, groups, grants, tasks, uploads, or audit attribution; every user-related mutation targets the ID, and only Admins may change another user or role/state. |
| `AC-02` | Role-based navigation and backend authorization expose Admin features only to Admins and scoped task management only to eligible Managers. |
| `AC-03` | A definition creates no visible work before its scheduled occurrence. At occurrence time, dashboard and task lists show authorized direct/current-group work, order overdue work first and then newest unresolved work, display lifecycle status and labeled due date/time, turn orange without a visible half-time message after half the due window and red when overdue, expose urgency accessibly, and show all accessible SFTP roots. |
| `AC-04` | Selecting a task CTA or folder card opens the exact authorized folder/page and never exposes an unauthorized ancestor. |
| `AC-05` | Users can browse, upload, download, create, rename, move, replace, and delete only when the required folder permissions are effective. Rename uses a pre-populated inline file/folder-name editor with adjacent Save/Cancel controls, Enter/Escape support, pending progress, refreshed success state, and highlighted in-row failures without native browser prompts. Move uses a same-server modal folder picker with bounded accessible-root/breadcrumb navigation, folder-only choices, invalid/unauthorized destination prevention, loading/submission progress, refreshed success state, and highlighted in-dialog failures without native prompts or free-text paths. Multiple uploads support file-picker and drag-and-drop selection on the directory-listing card, concurrent same/different-folder background operation across menu navigation, bottom-right progress with expanded per-file controls and a minimized single-row aggregate progress plus batch pause/resume/cancel controls, bounded direct-to-SFTP chunks, progress calculated only from remotely written and size-verified bytes, cancellation cleanup, offset-based resume after pause or failure, same-target conflict protection, and files larger than the frontend proxy's former 10 MiB default. |
| `AC-06` | An Admin can configure password/private-key SFTP servers without entering a host fingerprint; a successful initial connection automatically pins the discovered key, closes the form, and refreshes the server list, while a failed connection saves nothing. An Admin can also confirm server deletion, which atomically removes its credentials, access grants, tasks, and unfinished upload sessions while retaining audit history and remote files. |
| `AC-07` | An Admin can add, edit, and remove user/group folder grants, see the specific user or group and server on every grant row, and preview effective access; edit failures remain inside a spinner-backed modal and successful saves close it, refresh the list, and show a two-second success notification. |
| `AC-08` | Admins and authorized Managers can add/edit/delete user- or group-owned one-time/month-end or other supported recurring schedules in modal flows; due time cannot extend past the next frequency, the compact schedule table exposes complete details on hover/focus, and instances are generated once per occurrence. |
| `AC-09` | A group schedule has one shared work item visible to current members; any member's state change is immediately consistent for all, and membership add/remove immediately changes visibility. Users can start or dismiss matching-file work and navigate directly to its SFTP folder, but cannot manually complete it; completion requires a matching portal/external file in the exact folder, including a file already present or carrying an older preserved modified time, uses a selectable 5/10/30-minute, hourly, or daily persisted check cadence, records last check, and supports an authorized immediate refresh. |
| `AC-10` | Required authentication, file-content transfer, file/folder mutation, task, access, server, and audit-query actions create immutable, secret-free audit events; successful folder listings do not create or appear as audit events. Source IP/client metadata is serialized only by the dedicated audit endpoint for Admin/Auditor sessions and never by Manager/User or dashboard activity APIs. |
| `AC-11` | Users see their own and currently authorized-folder events; Admins and Auditors can search all events; no role can modify audit history. |
| `AC-12` | All file content is streamed, paths are canonicalized, symlinks/traversal are rejected, and remote roots cannot be escaped. |
| `AC-13` | The backend persists application state through SQLAlchemy repository interfaces and SQLite, and repository contract tests permit a later database implementation without API changes. |
| `AC-14` | Restarting or replacing containers preserves users, configuration, sessions, tasks, and audit history through the host-mounted `/Users/debchowd/SFTP-MANAGER/db` SQLite directory, preserves operational logs through `/Users/debchowd/SFTP-MANAGER/logs`, and leaves remote SFTP files unchanged. |
| `AC-15` | Primary workflows meet WCAG 2.1 AA and pass the defined functional, integration, authorization, security, and operational test suites. |
| `AC-16` | Importing the `vercel` branch as a Vercel Services project deploys the Next.js and FastAPI services under one domain and starts a clearly documented disposable demo using writable `/tmp` state and secure cookies; it requires no committed secret, never claims production durability, and leaves Compose as the supported durable production deployment. |

Release approval requires all acceptance criteria to pass in a production-like environment. Any exception must be documented with owner, risk, mitigation, and expiry date.

## 16. Product assumptions

- “Materials views” means a modern Material Design interface built with Material UI.
- The portal serves one organization, and all configured SFTP servers belong to that organization.
- Server-side authorization is authoritative; frontend guards exist only for usability.
- SFTP files and folder metadata remain authoritative on remote servers and are not copied into application repositories.
- Email is used only for account lifecycle notifications in v1; task reminders are in-app.
- English is the only supported interface language in v1, while filenames may contain valid Unicode supported by the remote server.
- SQLite is the durable application system of record; remote SFTP servers remain the system of record for file content and remote folder metadata.
