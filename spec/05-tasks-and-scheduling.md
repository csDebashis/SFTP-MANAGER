# Tasks and scheduling

Owner: Workflow and scheduling. Related modules:
[files](04-sftp-and-files.md), [audit](06-audit.md),
[data and API](07-data-architecture-and-api.md).

## Task definitions and pending actions

A task definition represents expected file work. An Admin may manage definitions anywhere. A Manager may manage a definition only when the target folder is covered by `MANAGE_TASKS`.

Each definition contains:

- ID, title, instructions, enabled state, server ID, canonical target folder, assignee user/group IDs, schedule, IANA timezone, due offset, call-to-action type, completion mode, optional filename glob, completion policy, created/updated metadata, and version.

Supported schedules are:

- `ONCE`: one local date and time.
- `DAILY`: local time and optional weekday restriction.
- `WEEKLY`: selected weekdays and local time.
- `MONTHLY`: day 1–28 or `LAST_DAY`, plus local time.

APScheduler evaluates schedules in the definition's timezone and persists generated instances in SQLite. Daylight-saving transitions use the first valid occurrence after a skipped local time and the first occurrence for a repeated local time. A database uniqueness constraint on the deterministic occurrence key prevents duplicate instances across restarts.

The task-definition form exposes a required **Repeat** choice for `ONCE`,
`DAILY`, `WEEKLY`, and `MONTHLY`. It conditionally requests the local first
occurrence, IANA timezone, selected weekdays, month day or `LAST_DAY`, and due
offset. The list shows the saved schedule and next occurrence. Submission uses
the shared pending spinner, in-form error, refreshed-list, and two-second success
notification behavior.

The production backend image includes a complete IANA timezone database and
accepts compatibility aliases returned by supported browsers (for example,
`Asia/Calcutta`) as well as current canonical names.

The single-process scheduler performs three independent, coalescing jobs:

- generate all due occurrences at startup and at least every 15 seconds;
- scan active `MATCHING_UPLOAD` work items at least every 30 seconds;
- transition elapsed pending/in-progress work to `OVERDUE` at least every 15
  seconds.

Only one instance of each job may run at once. A scheduler retry or process
restart must not create another task for an existing occurrence key.

Task behavior:

- Group membership expands to a snapshot of individual assignments when an instance is generated.
- `dueOffsetMinutes` is applied to the scheduled occurrence and may be from 0 to 43,200 minutes.
- CTA type is either `OPEN_FOLDER` or `OPEN_PAGE`. The target is validated when the definition is saved.
- Completion mode is `MANUAL` or `MATCHING_UPLOAD`.
- `MATCHING_UPLOAD` requires a filename glob using `*` and `?` only. A successful upload or move into the exact target folder completes the uploader's assignment only when the uploader is an eligible assignee.
- The scheduled file checker also lists the definition's exact SFTP folder so
  files delivered outside this portal can complete work. A regular file matches
  only when its name satisfies the glob and its remote modified time is not
  earlier than the occurrence's scheduled time. Directories, symbolic links,
  portal temporary upload objects, older files, other folders, and other servers
  do not match.
- A successful portal upload/move or scheduled file check changes the matching
  assignment to `COMPLETED` and records the detection source. An absent file
  leaves the assignment `PENDING` or `IN_PROGRESS`; after `dueAt` it becomes
  `OVERDUE`. A later matching file may still complete an overdue assignment.
- Temporary SFTP outages leave work-item state unchanged, emit a safe
  operational warning, and are retried on the next scan. One failing folder does
  not prevent other definitions from being evaluated.
- Completion policy is `ANY_ASSIGNEE` or `ALL_ASSIGNEES`. `ANY_ASSIGNEE` closes remaining assignments after the first completion. `ALL_ASSIGNEES` closes the instance after every assignment is completed or dismissed.
- Assignments transition from `PENDING` to `IN_PROGRESS`, `COMPLETED`, or `DISMISSED`; a pending/in-progress assignment becomes `OVERDUE` after its due time.
- Dismissal requires a reason. Completion, dismissal, reopening, overdue transition, and automatic matching are audited.
- Editing a definition affects future instances only. Existing instances retain a snapshot of the definition fields needed for display and routing.
- Disabling a definition stops future generation but does not remove existing assignments.
- Deleting definitions is not supported. Definitions are disabled to preserve audit context.
