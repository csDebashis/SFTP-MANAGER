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
offset. An assignee type selects either one user or one group. The active due
offset maximum is shown in the form and cannot exceed the shortest interval
before the next configured occurrence. The schedule table shows only its
description, compact schedule summary,
and actions. A focusable/hoverable information control exposes all definition
details, including assignee, server and folder, timezone, due offset, completion
rule, next occurrence, check interval, last check, status, and version. All
schedules remain editable and provide an explicit delete action with a
confirmation that generated work items are also removed. Submission uses the
shared pending spinner,
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

- Saving a definition does not expose future work early. One work item is
  materialized when each scheduled occurrence becomes due; `scheduledAt` is the
  occurrence and `dueAt` is that occurrence plus its due offset.
- A group definition produces one group-owned work item, not one copy per
  member. All current members see and act on the same row and therefore observe
  the same status. Adding or removing a member changes visibility and action
  authority immediately without rewriting the work item.
- `dueOffsetMinutes` is applied to the scheduled occurrence and cannot exceed
  the shortest configured frequency: 1,440 minutes for an unrestricted daily
  schedule, the shortest circular weekday gap for weekday schedules, and 40,320
  minutes for monthly schedules. `ONCE` retains the general 43,200-minute cap
  because it has no subsequent occurrence.
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
  whenever its name satisfies the glob, including when the file was already
  present when the occurrence became due. Remote modified time is informational
  and is not a completion gate because SFTP server clocks and preserved source
  timestamps are not reliable delivery indicators. Directories, symbolic links,
  portal temporary upload objects, other folders, and other servers do not match.
- A successful portal upload/move or scheduled file check changes the matching
  assignment to `COMPLETED` and records the detection source. A matching-file
  work item has no manual **Complete** action and the API rejects manual
  completion; it remains dismissible with a reason. Its **Open folder** action
  routes directly to the exact SFTP server and target folder. An absent file
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
- Assignments transition from `PENDING` to `IN_PROGRESS`, `COMPLETED`, or `DISMISSED`; a pending/in-progress assignment becomes `OVERDUE` after its due time.
- Assignment queries and both user task surfaces sort `OVERDUE` items first
  (oldest due first), then unresolved items by most recently assigned, followed
  by resolved history. Overdue rows/cards use a strong error-color border and
  background. Once half of the scheduled-to-due interval has elapsed, unresolved
  work uses an orange warning background/border and a **half time elapsed** text
  label. Status remains present in text so urgency is never communicated by
  color alone. Work-item rows show both SFTP server name and target folder.
- Dismissal requires a reason. Completion, dismissal, reopening, overdue transition, and automatic matching are audited.
- Editing a definition affects future instances only. Existing instances retain a snapshot of the definition fields needed for display and routing.
- Disabling a definition stops future generation but does not remove existing assignments.
- Deleting a definition requires confirmation and atomically removes the
  definition plus its generated work items. Immutable audit events are retained,
  including a schedule-deletion event with a safe title and deleted-item count.
