# Product and scope

Owner: Product. Related modules: [identity](02-identity-and-access.md),
[files](04-sftp-and-files.md), [tasks](05-tasks-and-scheduling.md).

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
- Separate frontend and backend containers orchestrated by rootless Podman Compose.
- Durable SQLite storage initialized from the current schema baseline.

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
