# Audit history

Owner: Security and compliance. Related modules:
[identity](02-identity-and-access.md), [files](04-sftp-and-files.md),
[tasks](05-tasks-and-scheduling.md).

## Audit contract

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
