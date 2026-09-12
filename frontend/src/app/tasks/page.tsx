"use client";

import AddTaskIcon from "@mui/icons-material/AddTask";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import DoNotDisturbAltIcon from "@mui/icons-material/DoNotDisturbAlt";
import EditIcon from "@mui/icons-material/Edit";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PauseCircleOutlineIcon from "@mui/icons-material/PauseCircleOutline";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert, Box, Button, Card, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, FormControl, IconButton, InputLabel, MenuItem,
  Select, Snackbar, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, TextField, Tooltip, Typography, alpha,
} from "@mui/material";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/api/client";
import AppShell from "@/components/AppShell";
import type { Group, Server, Task, TaskDefinition, User } from "@/types";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const CHECK_INTERVALS = [
  { value: 5, label: "Every 5 minutes" },
  { value: 10, label: "Every 10 minutes" },
  { value: 30, label: "Every 30 minutes" },
  { value: 60, label: "Hourly" },
  { value: 1440, label: "Daily" },
] as const;

type TaskForm = {
  title: string;
  instructions: string;
  serverId: string;
  targetPath: string;
  assigneeType: "USER" | "GROUP";
  assigneeId: string;
  scheduleType: "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";
  startAt: string;
  timezone: string;
  weekdays: number[];
  monthDay: string;
  dueOffsetMinutes: string;
  completionMode: "MANUAL" | "MATCHING_UPLOAD";
  filenameGlob: string;
  fileCheckIntervalMinutes: 5 | 10 | 30 | 60 | 1440;
};

function localDateTimeInput(date = new Date(Date.now() + 5 * 60_000)): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function emptyForm(): TaskForm {
  return {
    title: "", instructions: "", serverId: "", targetPath: "/", assigneeType: "USER", assigneeId: "",
    scheduleType: "ONCE", startAt: localDateTimeInput(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    weekdays: [], monthDay: "LAST_DAY", dueOffsetMinutes: "1440",
    completionMode: "MANUAL", filenameGlob: "", fileCheckIntervalMinutes: 5,
  };
}

function formFromDefinition(definition: TaskDefinition): TaskForm {
  return {
    title: definition.title,
    instructions: definition.instructions,
    serverId: definition.serverId,
    targetPath: definition.targetPath,
    assigneeType: definition.assigneeType || "USER",
    assigneeId: definition.assigneeId,
    scheduleType: definition.scheduleType,
    startAt: localDateTimeInput(new Date(definition.startAt)),
    timezone: definition.timezone,
    weekdays: [...definition.weekdays],
    monthDay: definition.monthDay || "LAST_DAY",
    dueOffsetMinutes: String(definition.dueOffsetMinutes),
    completionMode: definition.completionMode === "MATCHING_UPLOAD" ? "MATCHING_UPLOAD" : "MANUAL",
    filenameGlob: definition.filenameGlob || "",
    fileCheckIntervalMinutes: definition.fileCheckIntervalMinutes || 5,
  };
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function scheduleSummary(definition: TaskDefinition): string {
  const first = new Date(definition.startAt).toLocaleString();
  if (definition.scheduleType === "ONCE") return `Once · ${first}`;
  if (definition.scheduleType === "MONTHLY") return `Monthly · ${definition.monthDay === "LAST_DAY" ? "last day" : `day ${definition.monthDay}`} · ${first}`;
  const days = definition.weekdays.length ? definition.weekdays.map((day) => WEEKDAYS[day].slice(0, 3)).join(", ") : "every day";
  return `${definition.scheduleType === "DAILY" ? "Daily" : "Weekly"} · ${days} · ${first}`;
}

function checkIntervalLabel(minutes: number): string {
  return CHECK_INTERVALS.find((option) => option.value === minutes)?.label || `Every ${minutes} minutes`;
}

function activeTask(task: Task): boolean {
  return ["PENDING", "IN_PROGRESS", "OVERDUE"].includes(task.status);
}

function dueFrequencyLimit(form: Pick<TaskForm, "scheduleType" | "weekdays">): number {
  if (form.scheduleType === "ONCE") return 43_200;
  if (form.scheduleType === "MONTHLY") return 28 * 24 * 60;
  if (!form.weekdays.length) return form.scheduleType === "DAILY" ? 24 * 60 : 7 * 24 * 60;
  const ordered = Array.from(new Set(form.weekdays)).sort((left, right) => left - right);
  return Math.min(...ordered.map((day, index) => ((ordered[(index + 1) % ordered.length] - day) % 7 || 7) * 24 * 60));
}

function taskTone(task: Task, now = Date.now()): "overdue" | "halfway" | "normal" {
  const due = new Date(task.dueAt).getTime();
  if (task.status === "OVERDUE" || activeTask(task) && due < now) return "overdue";
  if (!activeTask(task)) return "normal";
  const scheduled = new Date(task.scheduledAt || task.createdAt).getTime();
  return due > scheduled && now >= scheduled + (due - scheduled) / 2 ? "halfway" : "normal";
}

function TaskScheduleFields({ form, change, users, groups, servers }: {
  form: TaskForm;
  change: (values: Partial<TaskForm>) => void;
  users: User[];
  groups: Group[];
  servers: Server[];
}) {
  const principals = form.assigneeType === "GROUP" ? groups : users;
  const frequencyLimit = dueFrequencyLimit(form);
  return (
    <Stack spacing={2}>
      <TextField autoFocus label="Title" value={form.title} onChange={(event) => change({ title: event.target.value })} required />
      <TextField label="Instructions" multiline minRows={2} value={form.instructions} onChange={(event) => change({ instructions: event.target.value })} />
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <FormControl fullWidth>
          <InputLabel id="task-assignee-type-label">Assign to</InputLabel>
          <Select labelId="task-assignee-type-label" label="Assign to" value={form.assigneeType} onChange={(event) => {
            const assigneeType = event.target.value as TaskForm["assigneeType"];
            const options = assigneeType === "GROUP" ? groups : users;
            change({ assigneeType, assigneeId: options[0]?.id || "" });
          }}>
            <MenuItem value="USER">User</MenuItem>
            <MenuItem value="GROUP">Group</MenuItem>
          </Select>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel id="task-assignee-label">{form.assigneeType === "GROUP" ? "Group" : "User"}</InputLabel>
          <Select labelId="task-assignee-label" label={form.assigneeType === "GROUP" ? "Group" : "User"} value={form.assigneeId} onChange={(event) => change({ assigneeId: event.target.value })}>
            {principals.map((principal) => <MenuItem key={principal.id} value={principal.id}>{"email" in principal ? `${principal.displayName} (${principal.email})` : principal.name}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel id="task-server-label">Server</InputLabel>
          <Select labelId="task-server-label" label="Server" value={form.serverId} onChange={(event) => change({ serverId: event.target.value })}>
            {servers.map((server) => <MenuItem key={server.id} value={server.id}>{server.name}</MenuItem>)}
          </Select>
        </FormControl>
        <TextField label="Target folder" value={form.targetPath} onChange={(event) => change({ targetPath: event.target.value })} fullWidth required />
      </Stack>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <FormControl fullWidth>
          <InputLabel id="task-repeat-label">Repeat</InputLabel>
          <Select labelId="task-repeat-label" label="Repeat" value={form.scheduleType} onChange={(event) => change({ scheduleType: event.target.value as TaskForm["scheduleType"] })}>
            <MenuItem value="ONCE">Once</MenuItem><MenuItem value="DAILY">Daily</MenuItem><MenuItem value="WEEKLY">Weekly</MenuItem><MenuItem value="MONTHLY">Monthly</MenuItem>
          </Select>
        </FormControl>
        <TextField label="First occurrence" type="datetime-local" value={form.startAt} onChange={(event) => change({ startAt: event.target.value })} slotProps={{ inputLabel: { shrink: true } }} required fullWidth />
        <TextField label="Timezone" value={form.timezone} onChange={(event) => change({ timezone: event.target.value })} required fullWidth />
        <TextField label="Due after (minutes)" type="number" value={form.dueOffsetMinutes} onChange={(event) => change({ dueOffsetMinutes: event.target.value })} inputProps={{ min: 0, max: frequencyLimit }} helperText={`Maximum ${frequencyLimit.toLocaleString()} minutes for this frequency`} required fullWidth />
      </Stack>
      {(form.scheduleType === "DAILY" || form.scheduleType === "WEEKLY") && (
        <FormControl fullWidth>
          <InputLabel id="task-weekdays-label">Repeat on</InputLabel>
          <Select labelId="task-weekdays-label" multiple label="Repeat on" value={form.weekdays} onChange={(event) => change({ weekdays: event.target.value as number[] })} renderValue={(selected) => selected.length ? selected.map((day) => WEEKDAYS[day].slice(0, 3)).join(", ") : "Every day"}>
            {WEEKDAYS.map((day, index) => <MenuItem key={day} value={index}>{day}</MenuItem>)}
          </Select>
        </FormControl>
      )}
      {form.scheduleType === "MONTHLY" && (
        <FormControl fullWidth>
          <InputLabel id="task-month-day-label">Day of month</InputLabel>
          <Select labelId="task-month-day-label" label="Day of month" value={form.monthDay} onChange={(event) => change({ monthDay: event.target.value })}>
            <MenuItem value="LAST_DAY">Last day</MenuItem>{Array.from({ length: 28 }, (_, index) => <MenuItem key={index + 1} value={String(index + 1)}>Day {index + 1}</MenuItem>)}
          </Select>
        </FormControl>
      )}
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <FormControl fullWidth>
          <InputLabel id="task-completion-label">Completion</InputLabel>
          <Select labelId="task-completion-label" label="Completion" value={form.completionMode} onChange={(event) => change({ completionMode: event.target.value as TaskForm["completionMode"] })}>
            <MenuItem value="MANUAL">Manual</MenuItem><MenuItem value="MATCHING_UPLOAD">Matching file in folder</MenuItem>
          </Select>
        </FormControl>
        {form.completionMode === "MATCHING_UPLOAD" && (
          <>
            <TextField label="Filename pattern" placeholder="report-*.csv" value={form.filenameGlob} onChange={(event) => change({ filenameGlob: event.target.value })} required fullWidth />
            <FormControl fullWidth>
              <InputLabel id="task-check-interval-label">Check folder</InputLabel>
              <Select labelId="task-check-interval-label" label="Check folder" value={form.fileCheckIntervalMinutes} onChange={(event) => change({ fileCheckIntervalMinutes: Number(event.target.value) as TaskForm["fileCheckIntervalMinutes"] })}>
                {CHECK_INTERVALS.map((option) => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
              </Select>
            </FormControl>
          </>
        )}
      </Stack>
    </Stack>
  );
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [definitions, setDefinitions] = useState<TaskDefinition[]>([]);
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [pageError, setPageError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const [scheduleDialog, setScheduleDialog] = useState(false);
  const [editingDefinition, setEditingDefinition] = useState<TaskDefinition | null>(null);
  const [form, setForm] = useState<TaskForm>(emptyForm);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dismissTask, setDismissTask] = useState<Task | null>(null);
  const [dismissError, setDismissError] = useState("");
  const [reason, setReason] = useState("");
  const [busyTask, setBusyTask] = useState("");
  const [deletingDefinition, setDeletingDefinition] = useState<TaskDefinition | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  async function load() {
    setLoading(true);
    setPageError("");
    try {
      const [taskResult, current] = await Promise.all([api<{ items: Task[] }>("/tasks"), api<{ user: User }>("/auth/me")]);
      setTasks(taskResult.items);
      setMe(current.user);
      if (current.user.role === "ADMIN") {
        const [userResult, groupResult, serverResult, definitionResult] = await Promise.all([
          api<{ items: User[] }>("/users"), api<{ items: Group[] }>("/groups"), api<{ items: Server[] }>("/sftp-servers"), api<{ items: TaskDefinition[] }>("/task-definitions"),
        ]);
        setUsers(userResult.items.filter((user) => user.state === "ACTIVE"));
        setGroups(groupResult.items);
        setServers(serverResult.items.filter((server) => server.enabled));
        setDefinitions(definitionResult.items);
      }
    } catch (reasonValue) {
      setPageError(errorMessage(reasonValue, "Unable to load tasks"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const sortedTasks = useMemo(() => [...tasks].sort((left, right) => {
    const priority = (task: Task) => task.status === "OVERDUE" ? 0 : activeTask(task) ? 1 : 2;
    const difference = priority(left) - priority(right);
    if (difference) return difference;
    if (left.status === "OVERDUE" && right.status === "OVERDUE") return new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime();
    return new Date(right.createdAt || right.dueAt).getTime() - new Date(left.createdAt || left.dueAt).getTime();
  }), [tasks]);

  function showSuccess(message: string) {
    setSuccess(message);
    window.setTimeout(() => setSuccess(""), 2000);
  }

  function openCreate() {
    const initial = emptyForm();
    initial.assigneeId = users.find((user) => user.role === "USER")?.id || users[0]?.id || "";
    initial.serverId = servers[0]?.id || "";
    setForm(initial); setEditingDefinition(null); setFormError(""); setPageError(""); setScheduleDialog(true);
  }

  function openEdit(definition: TaskDefinition) {
    setForm(formFromDefinition(definition)); setEditingDefinition(definition); setFormError(""); setPageError(""); setScheduleDialog(true);
  }

  function openDelete(definition: TaskDefinition) {
    setDeletingDefinition(definition); setDeleteError(""); setPageError("");
  }

  function closeSchedule() {
    if (submitting) return;
    setScheduleDialog(false); setEditingDefinition(null); setFormError("");
  }

  async function saveSchedule(event: FormEvent) {
    event.preventDefault(); setFormError(""); setSubmitting(true);
    const editing = editingDefinition;
    try {
      const body = {
        ...form,
        startAt: new Date(form.startAt).toISOString(),
        dueOffsetMinutes: Number(form.dueOffsetMinutes),
        weekdays: form.scheduleType === "WEEKLY" || form.scheduleType === "DAILY" ? form.weekdays : [],
        monthDay: form.scheduleType === "MONTHLY" ? form.monthDay : null,
        filenameGlob: form.completionMode === "MATCHING_UPLOAD" ? form.filenameGlob : null,
        fileCheckIntervalMinutes: form.completionMode === "MATCHING_UPLOAD" ? form.fileCheckIntervalMinutes : 5,
      };
      await api(editing ? `/task-definitions/${editing.id}` : "/task-definitions", { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
      setScheduleDialog(false); setEditingDefinition(null);
      await load();
      showSuccess(editing ? "Task schedule updated" : "Task schedule created");
    } catch (reasonValue) {
      setFormError(errorMessage(reasonValue, "Unable to save task schedule"));
    } finally {
      setSubmitting(false);
    }
  }

  async function disableDefinition(definition: TaskDefinition) {
    setPageError("");
    try {
      await api(`/task-definitions/${definition.id}/disable`, { method: "POST" }); await load(); showSuccess("Task schedule disabled");
    } catch (reasonValue) { setPageError(errorMessage(reasonValue, "Unable to disable task schedule")); }
  }

  async function deleteDefinition() {
    if (!deletingDefinition) return;
    setDeleteError(""); setDeleting(true);
    try {
      await api(`/task-definitions/${deletingDefinition.id}`, { method: "DELETE" });
      setDeletingDefinition(null);
      await load();
      showSuccess("Task schedule deleted");
    } catch (reasonValue) {
      setDeleteError(errorMessage(reasonValue, "Unable to delete task schedule"));
    } finally {
      setDeleting(false);
    }
  }

  async function taskAction(task: Task, value: string, body?: object) {
    setPageError(""); setDismissError(""); setBusyTask(`${value}:${task.id}`);
    try {
      await api(`/tasks/${task.id}/${value}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      setDismissTask(null); setReason(""); await load();
    } catch (reasonValue) {
      const message = errorMessage(reasonValue, "Unable to update task");
      if (value === "dismiss") setDismissError(message); else setPageError(message);
    } finally { setBusyTask(""); }
  }

  async function checkFolder(task: Task) {
    setPageError(""); setBusyTask(`check:${task.id}`);
    try {
      const result = await api<{ task: Task; matched: boolean }>(`/tasks/${task.id}/check`, { method: "POST" });
      await load();
      showSuccess(result.matched ? `${task.title} completed: matching file found` : "Folder checked: no matching file found");
    } catch (reasonValue) { setPageError(errorMessage(reasonValue, "Unable to check the SFTP folder")); }
    finally { setBusyTask(""); }
  }

  return (
    <AppShell title="Tasks">
      <Stack spacing={2.5}>
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={2} alignItems={{ sm: "center" }}>
          <Box><Typography variant="h4">File tasks</Typography><Typography color="text.secondary">Scheduled deliveries and their generated work items.</Typography></Box>
          {me?.role === "ADMIN" && <Button variant="contained" startIcon={<AddTaskIcon />} onClick={openCreate}>Add task schedule</Button>}
        </Stack>
        {pageError && <Alert severity="error" variant="filled" onClose={() => setPageError("")}>{pageError}</Alert>}
        {loading && !me ? <CircularProgress aria-label="Loading tasks" /> : (
          <>
            {me?.role === "ADMIN" && (
              <Stack spacing={1.25}>
                <Typography variant="h5">Schedules</Typography>
                {definitions.length === 0 ? <Alert severity="info">No task schedules have been created.</Alert> : (
                  <TableContainer component={Card}>
                    <Table aria-label="Task schedules">
                      <TableHead><TableRow><TableCell>Description</TableCell><TableCell>Schedule</TableCell><TableCell align="right">Actions</TableCell></TableRow></TableHead>
                      <TableBody>{definitions.map((definition) => {
                        const assignee = definition.assigneeType === "GROUP"
                          ? groups.find((group) => group.id === definition.assigneeId)
                          : users.find((user) => user.id === definition.assigneeId);
                        const server = servers.find((item) => item.id === definition.serverId);
                        const details = (
                          <Stack spacing={0.5} sx={{ p: 0.5 }}>
                            <Typography variant="subtitle2">{definition.title}</Typography>
                            <Typography variant="caption">Assignee: {definition.assigneeType === "GROUP" ? `Group · ${assignee && "name" in assignee ? assignee.name : definition.assigneeName || definition.assigneeId}` : assignee && "email" in assignee ? `${assignee.displayName} (${assignee.email})` : definition.assigneeName || definition.assigneeId}</Typography>
                            <Typography variant="caption">Server/folder: {server?.name || definition.serverId} · {definition.targetPath}</Typography>
                            <Typography variant="caption">Schedule: {scheduleSummary(definition)} · {definition.timezone}</Typography>
                            <Typography variant="caption">Due offset: {definition.dueOffsetMinutes} minutes</Typography>
                            <Typography variant="caption">Completion: {definition.completionMode === "MATCHING_UPLOAD" ? `Matching ${definition.filenameGlob} · ${checkIntervalLabel(definition.fileCheckIntervalMinutes)}` : "Manual"}</Typography>
                            <Typography variant="caption">Next occurrence: {definition.nextRunAt ? new Date(definition.nextRunAt).toLocaleString() : "None"}</Typography>
                            <Typography variant="caption">Last folder check: {definition.lastCheckedAt ? new Date(definition.lastCheckedAt).toLocaleString() : "Not checked"}</Typography>
                            <Typography variant="caption">Status: {definition.enabled ? "Active" : "No future occurrences"} · version {definition.version}</Typography>
                          </Stack>
                        );
                        return (
                          <TableRow key={definition.id} hover>
                            <TableCell><Typography fontWeight={750}>{definition.title}</Typography><Typography variant="body2" color="text.secondary">{definition.instructions || "No instructions"}</Typography></TableCell>
                            <TableCell><Typography>{scheduleSummary(definition)}</Typography><Typography variant="caption" color="text.secondary">{definition.enabled ? "Active" : "No future occurrences"}</Typography></TableCell>
                            <TableCell align="right"><Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Tooltip title={details} arrow placement="left"><IconButton aria-label={`View ${definition.title} schedule details`}><InfoOutlinedIcon /></IconButton></Tooltip>
                              <Tooltip title="Edit schedule"><IconButton aria-label={`Edit ${definition.title}`} onClick={() => openEdit(definition)}><EditIcon /></IconButton></Tooltip>
                              {definition.enabled && <Tooltip title="Disable future occurrences"><IconButton aria-label={`Disable ${definition.title}`} color="warning" onClick={() => disableDefinition(definition)}><PauseCircleOutlineIcon /></IconButton></Tooltip>}
                              <Tooltip title="Delete schedule"><IconButton aria-label={`Delete ${definition.title}`} color="error" onClick={() => openDelete(definition)}><DeleteIcon /></IconButton></Tooltip>
                            </Stack></TableCell>
                          </TableRow>
                        );
                      })}</TableBody>
                    </Table>
                  </TableContainer>
                )}
              </Stack>
            )}

            <Stack spacing={1.25}>
              <Typography variant="h5">Work items</Typography>
              {sortedTasks.length === 0 ? <Alert severity="info">No tasks to show.</Alert> : (
                <TableContainer component={Card}>
                  <Table aria-label="Assigned work items">
                    <TableHead><TableRow><TableCell>Task</TableCell><TableCell>SFTP location</TableCell><TableCell>Due and status</TableCell><TableCell>Folder check</TableCell><TableCell align="right">Actions</TableCell></TableRow></TableHead>
                    <TableBody>{sortedTasks.map((task) => {
                      const tone = taskTone(task);
                      return (
                        <TableRow key={task.id} data-testid={`task-row-${task.id}`} data-task-tone={tone} sx={(theme) => tone === "overdue" ? { backgroundColor: alpha(theme.palette.error.main, 0.13), borderLeft: `5px solid ${theme.palette.error.main}` } : tone === "halfway" ? { backgroundColor: alpha(theme.palette.warning.main, 0.12), borderLeft: `5px solid ${theme.palette.warning.main}` } : {}}>
                          <TableCell><Typography fontWeight={750}>{task.title}</Typography><Typography variant="body2" color="text.secondary">{task.instructions || "No instructions"}</Typography></TableCell>
                          <TableCell><Typography fontWeight={650}>{task.serverName || task.serverId}</Typography><Typography variant="caption" color="text.secondary">{task.targetPath}</Typography></TableCell>
                          <TableCell><Stack spacing={0.5} alignItems="flex-start"><Chip size="small" label={tone === "halfway" ? `${task.status} · half time elapsed` : task.status} color={tone === "overdue" ? "error" : task.status === "COMPLETED" ? "success" : tone === "halfway" ? "warning" : "primary"} /><Typography variant="body2">{new Date(task.dueAt).toLocaleString()}</Typography></Stack></TableCell>
                          <TableCell>{task.completionMode === "MATCHING_UPLOAD" ? <Stack spacing={0.25}><Typography variant="body2">{task.filenameGlob}</Typography><Typography variant="caption" color="text.secondary">{checkIntervalLabel(task.fileCheckIntervalMinutes)}</Typography><Typography variant="caption" color="text.secondary">Last checked: {task.lastCheckedAt ? new Date(task.lastCheckedAt).toLocaleString() : "Not checked"}</Typography></Stack> : <Typography color="text.secondary">Manual completion</Typography>}</TableCell>
                          <TableCell align="right"><Stack direction="row" spacing={1} justifyContent="flex-end" flexWrap="wrap">
                            {task.completionMode === "MATCHING_UPLOAD" && activeTask(task) && <Button size="small" startIcon={<FolderOpenIcon />} onClick={() => router.push(`/files?serverId=${task.serverId}&path=${encodeURIComponent(task.targetPath)}`)}>Open folder</Button>}
                            {task.completionMode === "MATCHING_UPLOAD" && activeTask(task) && <Button size="small" startIcon={busyTask === `check:${task.id}` ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />} disabled={Boolean(busyTask)} onClick={() => checkFolder(task)}>Check folder</Button>}
                            {task.status === "PENDING" && <Button size="small" startIcon={<PlayArrowIcon />} disabled={Boolean(busyTask)} onClick={() => taskAction(task, "start")}>Start</Button>}
                            {task.completionMode !== "MATCHING_UPLOAD" && activeTask(task) && <Button size="small" color="success" startIcon={<CheckCircleIcon />} disabled={Boolean(busyTask)} onClick={() => taskAction(task, "complete")}>Complete</Button>}
                            {activeTask(task) && <Button size="small" color="warning" startIcon={<DoNotDisturbAltIcon />} disabled={Boolean(busyTask)} onClick={() => { setDismissTask(task); setDismissError(""); setReason(""); setPageError(""); }}>Dismiss</Button>}
                          </Stack></TableCell>
                        </TableRow>
                      );
                    })}</TableBody>
                  </Table>
                </TableContainer>
              )}
            </Stack>
          </>
        )}
      </Stack>

      <Dialog open={scheduleDialog} onClose={closeSchedule} fullWidth maxWidth="lg">
        <DialogTitle>{editingDefinition ? "Edit task schedule" : "Add task schedule"}</DialogTitle>
        <Stack component="form" onSubmit={saveSchedule}>
          <DialogContent><TaskScheduleFields form={form} change={(values) => setForm((current) => ({ ...current, ...values }))} users={users} groups={groups} servers={servers} /></DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}>
            <Button variant="contained" type="submit" startIcon={submitting ? <CircularProgress size={18} color="inherit" /> : <AddTaskIcon />} disabled={submitting || !form.serverId || !form.assigneeId || Number(form.dueOffsetMinutes) > dueFrequencyLimit(form) || (form.scheduleType === "WEEKLY" && form.weekdays.length === 0)}>{submitting ? "Saving…" : editingDefinition ? "Save changes" : "Create schedule"}</Button>
            <Button type="button" onClick={closeSchedule} disabled={submitting}>Cancel</Button>
          </DialogActions>
          {formError && <Alert severity="error" variant="filled" sx={{ mx: 3, mb: 2 }}>{formError}</Alert>}
        </Stack>
      </Dialog>

      <Dialog open={Boolean(deletingDefinition)} onClose={() => { if (!deleting) { setDeletingDefinition(null); setDeleteError(""); } }} fullWidth maxWidth="sm">
        <DialogTitle>Delete task schedule</DialogTitle>
        <DialogContent><Alert severity="warning">Deleting <strong>{deletingDefinition?.title}</strong> stops future occurrences and removes its generated work items. Audit history is retained.</Alert></DialogContent>
        <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}>
          <Button variant="contained" color="error" startIcon={deleting ? <CircularProgress size={18} color="inherit" /> : <DeleteIcon />} disabled={deleting} onClick={() => void deleteDefinition()}>{deleting ? "Deleting…" : "Delete schedule"}</Button>
          <Button disabled={deleting} onClick={() => { setDeletingDefinition(null); setDeleteError(""); }}>Cancel</Button>
        </DialogActions>
        {deleteError && <Alert severity="error" variant="filled" sx={{ mx: 3, mb: 2 }}>{deleteError}</Alert>}
      </Dialog>

      <Dialog open={Boolean(dismissTask)} onClose={() => { if (!busyTask) setDismissTask(null); }} fullWidth maxWidth="sm">
        <DialogTitle>Dismiss task</DialogTitle>
        <Stack component="form" onSubmit={(event) => { event.preventDefault(); if (dismissTask) void taskAction(dismissTask, "dismiss", { reason }); }}>
          <DialogContent><TextField autoFocus fullWidth multiline minRows={3} margin="dense" label="Reason" value={reason} onChange={(event) => setReason(event.target.value)} helperText="Required, 3–500 characters" /></DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}><Button type="submit" variant="contained" color="warning" disabled={reason.trim().length < 3 || Boolean(busyTask)} startIcon={busyTask.startsWith("dismiss:") ? <CircularProgress size={18} color="inherit" /> : undefined}>Dismiss</Button><Button type="button" onClick={() => setDismissTask(null)} disabled={Boolean(busyTask)}>Cancel</Button></DialogActions>
          {dismissError && <Alert severity="error" variant="filled" sx={{ mx: 3, mb: 2 }}>{dismissError}</Alert>}
        </Stack>
      </Dialog>

      <Snackbar open={Boolean(success)} autoHideDuration={2000} onClose={() => setSuccess("")} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}><Alert severity="success" variant="filled" onClose={() => setSuccess("")}>{success}</Alert></Snackbar>
    </AppShell>
  );
}
