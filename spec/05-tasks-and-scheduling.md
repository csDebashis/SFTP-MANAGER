# Tasks and scheduling

Owner: Workflow and scheduling. Related modules:
[files](04-sftp-and-files.md), [audit](06-audit.md),
[data and API](07-data-architecture-and-api.md).

## Task definitions and pending actions

A task definition represents expected file work. An Admin may manage definitions anywhere. A Manager may manage a definition only when the target folder is covered by `MANAGE_TASKS`.

Each definition contains:

- ID, title, instructions, enabled state, server ID, canonical target folder, assignee user/group IDs, schedule, IANA timezone, due offset, call-to-action type, completion mode, optional filename glob, external-file check interval, last-check time, completion policy, created/updated metadata, and version.

Supported schedules are:

- `ONCE`: one local date and time.
- `DAILY`: local time and optional weekday restriction.
- `WEEKLY`: selected weekdays and local time.
- `MONTHLY`: day 1–28 or `LAST_DAY`, plus local time.

APScheduler evaluates schedules in the definition's timezone and persists generated instances in SQLite. Daylight-saving transitions use the first valid occurrence after a skipped local time and the first occurrence for a repeated local time. A database uniqueness constraint on the deterministic occurrence key prevents duplicate instances across restarts.

The task-definition form opens only after **Add task schedule** is selected and
the edit form opens from the selected schedule's edit action. Both modal forms
expose a required **Repeat** choice for `ONCE`,
`DAILY`, `WEEKLY`, and `MONTHLY`. It conditionally requests the local first
occurrence, IANA timezone, selected weekdays, month day or `LAST_DAY`, and due
offset. The schedule table shows only its description, compact schedule summary,
and actions. A focusable/hoverable information control exposes all definition
details, including assignee, server and folder, timezone, due offset, completion
rule, next occurrence, check interval, last check, status, and version. All
schedules, including a one-time schedule with an already-materialized first
assignment, remain editable. Submission uses the shared pending spinner,
in-form error, refreshed-list, and two-second success notification behavior.

The production backend image includes a complete IANA timezone database and
accepts compatibility aliases returned by supported browsers (for example,
`Asia/Calcutta`) as well as current canonical names.

The single-process scheduler performs three independent, coalescing jobs:

- generate all due occurrences at startup and at least every 15 seconds;
- dispatch due external-file checks at least every 60 seconds while each active
  `MATCHING_UPLOAD` assignment independently observes its configured interval;
- transition elapsed pending/in-progress work to `OVERDUE` at least every 15
  seconds.

Only one instance of each job may run at once. A scheduler retry or process
restart must not create another task for an existing occurrence key.

Task behavior:

- Saving a definition materializes its first assignment immediately, even when
  the scheduled occurrence is in the future, so the assignee can see and plan
  the work as soon as an Admin creates it. Its `scheduledAt` and `dueAt` remain
  the configured times. Subsequent recurring assignments are generated only
  from their deterministic scheduler occurrences.
- Group membership expands to a snapshot of individual assignments when an instance is generated.
- `dueOffsetMinutes` is applied to the scheduled occurrence and may be from 0 to 43,200 minutes.
- CTA type is either `OPEN_FOLDER` or `OPEN_PAGE`. The target is validated when the definition is saved.
- Completion mode is `MANUAL` or `MATCHING_UPLOAD`.
- `MATCHING_UPLOAD` requires a filename glob using `*` and `?` only. A successful upload or move into the exact target folder completes the uploader's assignment only when the uploader is an eligible assignee.
- A matching-file definition requires one external-check interval from 5, 10,
  or 30 minutes, hourly, or daily. The interval is copied into each work-item
  snapshot. Each attempt records `lastCheckedAt`; an unresolved attempt advances
  `nextCheckAt` by that interval. These timestamps survive process/container
  restarts in SQLite and are displayed in the task UI.
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
- An assignee, Admin, or Manager with scoped `MANAGE_TASKS` may select **Check
  folder** on an unresolved matching-file work item to force the same exact-path
  validation immediately, regardless of `nextCheckAt`. The UI shows a pending
  spinner, reloads the item and `lastCheckedAt`, and reports whether a matching
  file was found. Manual validation does not create a folder-list audit event;
  a resulting automatic completion is audited with its detection source.
- Completion policy is `ANY_ASSIGNEE` or `ALL_ASSIGNEES`. `ANY_ASSIGNEE` closes remaining assignments after the first completion. `ALL_ASSIGNEES` closes the instance after every assignment is completed or dismissed.
- Assignments transition from `PENDING` to `IN_PROGRESS`, `COMPLETED`, or `DISMISSED`; a pending/in-progress assignment becomes `OVERDUE` after its due time.
- Assignment queries and both user task surfaces sort `OVERDUE` items first
  (oldest due first), then unresolved items by most recently assigned, followed
  by resolved history. Overdue rows/cards use a strong error-color border and
  background; unresolved work due within 24 hours uses a warning color. Status
  remains present in text so urgency is never communicated by color alone.
- Dismissal requires a reason. Completion, dismissal, reopening, overdue transition, and automatic matching are audited.
- Editing a definition affects future instances only. Existing instances retain a snapshot of the definition fields needed for display and routing.
- Disabling a definition stops future generation but does not remove existing assignments.
- Deleting definitions is not supported. Definitions are disabled to preserve audit context.
