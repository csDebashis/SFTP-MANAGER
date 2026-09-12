# Identity and access

Owner: Identity and administration. Related modules:
[API](07-data-architecture-and-api.md), [audit](06-audit.md).

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
