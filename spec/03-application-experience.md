# Application experience

Owner: Frontend platform. Related modules: [identity](02-identity-and-access.md),
[files](04-sftp-and-files.md), [tasks](05-tasks-and-scheduling.md).

## Application shell and navigation

- Use Node.js 24, Next.js App Router, React, TypeScript, Material UI, and the MUI Material Symbols icon set throughout, with a theme based on Material Design 3 principles. Do not mix in unrelated icon libraries or Unicode glyphs for application actions.
- Run the frontend as an independent Node.js service. It must proxy same-origin `/api/*` traffic to FastAPI through `BACKEND_INTERNAL_URL`; FastAPI must not serve frontend assets.
- Provide responsive navigation: permanent/mini drawer on desktop and temporary drawer on smaller screens.
- Global navigation contains Home, Files, My Activity, and Profile. Role-authorized entries add Tasks, Audit, and Admin.
- Admin contains Signup Requests, Users, Groups & Access, and SFTP Servers.
- All pages provide a visible title, keyboard-focus management, loading skeleton, empty state, recoverable error state, and permission-denied state. API failures use a high-contrast error treatment with an icon, border, and shadow. Page-local errors are destroyed on navigation; form errors are cleared when another form opens and on each retry, so a stale failure cannot follow the user into another workflow.
- Destructive actions require a confirmation dialog describing the exact target. File deletion requires the user to type the filename when configured by policy.
- Dates are stored in UTC and displayed in the user's selected IANA timezone, defaulting to the browser timezone.
- The UI must not rely on hidden navigation for security. The API independently authorizes every request.

## Dashboard

The authenticated home page contains:

1. **Action required** — the current user's task assignments in `PENDING`, `IN_PROGRESS`, or `OVERDUE`, ordered with overdue work first and then the most recently assigned unresolved work.
2. **Accessible folders** — access-root cards grouped by SFTP server. Selecting a card opens the file explorer at that exact path.
3. **Recent activity** — the 20 newest audit events the user is authorized to view.
4. **Administrative attention** — visible only to Admins and containing pending signup count, disabled server count, and failed task-generation count.

Each task card displays title, target server/folder, due time, status, instructions summary, and a primary action. Overdue cards are strongly highlighted and work due within 24 hours uses a warning treatment, with textual status retained for accessibility. The primary action opens the exact folder or page configured by the task. An unresolved matching-file card also provides a spinner-backed **Check folder** action and displays its last-check timestamp. An assigned user may dismiss an assignment only after entering a reason between 3 and 500 characters. Dismissal is reversible by an Admin or an authorized Manager.
