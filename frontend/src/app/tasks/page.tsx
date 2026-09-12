"use client";

import AddTaskIcon from "@mui/icons-material/AddTask";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DoNotDisturbAltIcon from "@mui/icons-material/DoNotDisturbAlt";
import EventRepeatIcon from "@mui/icons-material/EventRepeat";
import PauseCircleOutlineIcon from "@mui/icons-material/PauseCircleOutline";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { FormEvent, useEffect, useState } from "react";
import { api } from "@/api/client";
import AppShell from "@/components/AppShell";
import type { Server, Task, TaskDefinition, User } from "@/types";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type TaskForm = {
  title: string;
  instructions: string;
  serverId: string;
  targetPath: string;
  assigneeId: string;
  scheduleType: "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";
  startAt: string;
  timezone: string;
  weekdays: number[];
  monthDay: string;
  dueOffsetMinutes: string;
  completionMode: "MANUAL" | "MATCHING_UPLOAD";
  filenameGlob: string;
};

function localDateTimeInput(date = new Date(Date.now() + 5 * 60_000)): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function emptyForm(): TaskForm {
  return {
    title: "",
    instructions: "",
    serverId: "",
    targetPath: "/",
    assigneeId: "",
    scheduleType: "ONCE",
    startAt: localDateTimeInput(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    weekdays: [],
    monthDay: "LAST_DAY",
    dueOffsetMinutes: "1440",
    completionMode: "MANUAL",
    filenameGlob: "",
  };
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [definitions, setDefinitions] = useState<TaskDefinition[]>([]);
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dismissTask, setDismissTask] = useState<Task | null>(null);
  const [reason, setReason] = useState("");
  const [form, setForm] = useState<TaskForm>(emptyForm);

  async function load() {
    try {
      const [taskResult, current] = await Promise.all([
        api<{ items: Task[] }>("/tasks"),
        api<{ user: User }>("/auth/me"),
      ]);
      setTasks(taskResult.items);
      setMe(current.user);
      if (current.user.role === "ADMIN") {
        const [userResult, serverResult, definitionResult] = await Promise.all([
          api<{ items: User[] }>("/users"),
          api<{ items: Server[] }>("/sftp-servers"),
          api<{ items: TaskDefinition[] }>("/task-definitions"),
        ]);
        const activeUsers = userResult.items.filter((user) => user.state === "ACTIVE");
        const enabledServers = serverResult.items.filter((server) => server.enabled);
        setUsers(activeUsers);
        setServers(enabledServers);
        setDefinitions(definitionResult.items);
        setForm((currentForm) => ({
          ...currentForm,
          assigneeId: currentForm.assigneeId || activeUsers.find((user) => user.role === "USER")?.id || "",
          serverId: currentForm.serverId || enabledServers[0]?.id || "",
        }));
      }
    } catch (reasonValue) {
      setError((reasonValue as Error).message);
    }
  }

  useEffect(() => { void load(); }, []);

  function showSuccess(message: string) {
    setSuccess(message);
    window.setTimeout(() => setSuccess(""), 2000);
  }

  async function action(task: Task, value: string, body?: object) {
    setError("");
    try {
      await api(`/tasks/${task.id}/${value}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      setDismissTask(null);
      setReason("");
      await load();
    } catch (reasonValue) {
      setError((reasonValue as Error).message);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await api("/task-definitions", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          startAt: new Date(form.startAt).toISOString(),
          dueOffsetMinutes: Number(form.dueOffsetMinutes),
          weekdays: form.scheduleType === "WEEKLY" || form.scheduleType === "DAILY" ? form.weekdays : [],
          monthDay: form.scheduleType === "MONTHLY" ? form.monthDay : null,
          filenameGlob: form.completionMode === "MATCHING_UPLOAD" ? form.filenameGlob : null,
        }),
      });
      setForm((current) => ({ ...emptyForm(), serverId: current.serverId, assigneeId: current.assigneeId }));
      await load();
      showSuccess("Task schedule created");
    } catch (reasonValue) {
      setError((reasonValue as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function disableDefinition(definition: TaskDefinition) {
    setError("");
    try {
      await api(`/task-definitions/${definition.id}/disable`, { method: "POST" });
      await load();
      showSuccess("Task schedule disabled");
    } catch (reasonValue) {
      setError((reasonValue as Error).message);
    }
  }

  return (
    <AppShell title="Tasks">
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="h4">File tasks</Typography>
          <Typography color="text.secondary">Schedule expected deliveries and track each generated work item.</Typography>
        </Box>
        {error && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}
        {success && <Alert severity="success">{success}</Alert>}
        {!me ? <CircularProgress /> : (
          <>
            {me.role === "ADMIN" && (
              <Card>
                <CardContent>
                  <Stack component="form" spacing={2} onSubmit={create}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <AddTaskIcon color="primary" />
                      <Typography variant="h6">Create task schedule</Typography>
                    </Stack>
                    <TextField label="Title" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required />
                    <TextField label="Instructions" multiline minRows={2} value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} />
                    <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                      <FormControl fullWidth>
                        <InputLabel id="task-assignee-label">Assignee</InputLabel>
                        <Select id="task-assignee" labelId="task-assignee-label" label="Assignee" value={form.assigneeId} onChange={(event) => setForm({ ...form, assigneeId: event.target.value })}>
                          {users.map((user) => <MenuItem key={user.id} value={user.id}>{user.email}</MenuItem>)}
                        </Select>
                      </FormControl>
                      <FormControl fullWidth>
                        <InputLabel id="task-server-label">Server</InputLabel>
                        <Select id="task-server" labelId="task-server-label" label="Server" value={form.serverId} onChange={(event) => setForm({ ...form, serverId: event.target.value })}>
                          {servers.map((server) => <MenuItem key={server.id} value={server.id}>{server.name}</MenuItem>)}
                        </Select>
                      </FormControl>
                      <TextField label="Target folder" value={form.targetPath} onChange={(event) => setForm({ ...form, targetPath: event.target.value })} fullWidth required />
                    </Stack>
                    <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                      <FormControl fullWidth>
                        <InputLabel id="task-repeat-label">Repeat</InputLabel>
                        <Select id="task-repeat" labelId="task-repeat-label" label="Repeat" value={form.scheduleType} onChange={(event) => setForm({ ...form, scheduleType: event.target.value as TaskForm["scheduleType"] })}>
                          <MenuItem value="ONCE">Once</MenuItem>
                          <MenuItem value="DAILY">Daily</MenuItem>
                          <MenuItem value="WEEKLY">Weekly</MenuItem>
                          <MenuItem value="MONTHLY">Monthly</MenuItem>
                        </Select>
                      </FormControl>
                      <TextField label="First occurrence" type="datetime-local" value={form.startAt} onChange={(event) => setForm({ ...form, startAt: event.target.value })} slotProps={{ inputLabel: { shrink: true } }} required fullWidth />
                      <TextField label="Timezone" value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} required fullWidth />
                      <TextField label="Due after (minutes)" type="number" value={form.dueOffsetMinutes} onChange={(event) => setForm({ ...form, dueOffsetMinutes: event.target.value })} inputProps={{ min: 0, max: 43200 }} required fullWidth />
                    </Stack>
                    {(form.scheduleType === "DAILY" || form.scheduleType === "WEEKLY") && (
                      <FormControl fullWidth>
                        <InputLabel id="task-weekdays-label">Repeat on</InputLabel>
                        <Select
                          id="task-weekdays"
                          labelId="task-weekdays-label"
                          multiple
                          label="Repeat on"
                          value={form.weekdays}
                          onChange={(event) => setForm({ ...form, weekdays: event.target.value as number[] })}
                          renderValue={(selected) => selected.length ? selected.map((day) => WEEKDAYS[day].slice(0, 3)).join(", ") : "Every day"}
                        >
                          {WEEKDAYS.map((day, index) => <MenuItem key={day} value={index}>{day}</MenuItem>)}
                        </Select>
                      </FormControl>
                    )}
                    {form.scheduleType === "MONTHLY" && (
                      <FormControl fullWidth>
                        <InputLabel id="task-month-day-label">Day of month</InputLabel>
                        <Select id="task-month-day" labelId="task-month-day-label" label="Day of month" value={form.monthDay} onChange={(event) => setForm({ ...form, monthDay: event.target.value })}>
                          <MenuItem value="LAST_DAY">Last day</MenuItem>
                          {Array.from({ length: 28 }, (_, index) => <MenuItem key={index + 1} value={String(index + 1)}>Day {index + 1}</MenuItem>)}
                        </Select>
                      </FormControl>
                    )}
                    <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                      <FormControl fullWidth>
                        <InputLabel id="task-completion-label">Completion</InputLabel>
                        <Select id="task-completion" labelId="task-completion-label" label="Completion" value={form.completionMode} onChange={(event) => setForm({ ...form, completionMode: event.target.value as TaskForm["completionMode"] })}>
                          <MenuItem value="MANUAL">Manual</MenuItem>
                          <MenuItem value="MATCHING_UPLOAD">Matching file in folder</MenuItem>
                        </Select>
                      </FormControl>
                      {form.completionMode === "MATCHING_UPLOAD" && <TextField label="Filename pattern" placeholder="report-*.csv" value={form.filenameGlob} onChange={(event) => setForm({ ...form, filenameGlob: event.target.value })} required fullWidth />}
                    </Stack>
                    <Button variant="contained" type="submit" disabled={submitting || !form.serverId || !form.assigneeId || (form.scheduleType === "WEEKLY" && form.weekdays.length === 0)} sx={{ alignSelf: "flex-start" }}>
                      {submitting ? <CircularProgress size={20} color="inherit" /> : "Create schedule"}
                    </Button>
                  </Stack>
                </CardContent>
              </Card>
            )}

            {me.role === "ADMIN" && definitions.length > 0 && (
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} alignItems="center"><EventRepeatIcon color="primary" /><Typography variant="h5">Schedules</Typography></Stack>
                {definitions.map((definition) => (
                  <Card key={definition.id}>
                    <CardContent>
                      <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ md: "center" }}>
                        <Box flex={1}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="h6">{definition.title}</Typography>
                            <Chip size="small" label={definition.scheduleType} color="primary" variant="outlined" />
                            <Chip size="small" label={definition.enabled ? "ACTIVE" : "FINISHED"} color={definition.enabled ? "success" : "default"} />
                          </Stack>
                          <Typography color="text.secondary">{definition.targetPath} · {definition.timezone}</Typography>
                          <Typography variant="caption">{definition.nextRunAt ? `Next occurrence ${new Date(definition.nextRunAt).toLocaleString()}` : "No future occurrences"}</Typography>
                        </Box>
                        {definition.enabled && <Button startIcon={<PauseCircleOutlineIcon />} onClick={() => disableDefinition(definition)}>Disable</Button>}
                      </Stack>
                    </CardContent>
                  </Card>
                ))}
              </Stack>
            )}

            <Stack spacing={1.5}>
              <Typography variant="h5">Work items</Typography>
              {tasks.length === 0 && <Alert severity="info">No tasks to show.</Alert>}
              {tasks.map((task) => (
                <Card key={task.id}>
                  <CardContent>
                    <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ md: "center" }}>
                      <Box flex={1}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="h6">{task.title}</Typography>
                          <Chip size="small" label={task.status} color={task.status === "OVERDUE" ? "error" : task.status === "COMPLETED" ? "success" : "warning"} />
                        </Stack>
                        <Typography color="text.secondary">{task.instructions}</Typography>
                        <Typography variant="caption">{task.targetPath} · due {new Date(task.dueAt).toLocaleString()}</Typography>
                      </Box>
                      {task.status === "PENDING" && <Button startIcon={<PlayArrowIcon />} onClick={() => action(task, "start")}>Start</Button>}
                      {["PENDING", "IN_PROGRESS", "OVERDUE"].includes(task.status) && (
                        <>
                          <Button color="success" startIcon={<CheckCircleIcon />} onClick={() => action(task, "complete")}>Complete</Button>
                          <Button color="warning" startIcon={<DoNotDisturbAltIcon />} onClick={() => setDismissTask(task)}>Dismiss</Button>
                        </>
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              ))}
            </Stack>
          </>
        )}
      </Stack>
      <Dialog open={Boolean(dismissTask)} onClose={() => setDismissTask(null)}>
        <DialogTitle>Dismiss task</DialogTitle>
        <DialogContent><TextField autoFocus fullWidth multiline minRows={3} margin="dense" label="Reason" value={reason} onChange={(event) => setReason(event.target.value)} helperText="Required, 3–500 characters" /></DialogContent>
        <DialogActions><Button onClick={() => setDismissTask(null)}>Cancel</Button><Button variant="contained" color="warning" disabled={reason.trim().length < 3} onClick={() => dismissTask && action(dismissTask, "dismiss", { reason })}>Dismiss</Button></DialogActions>
      </Dialog>
    </AppShell>
  );
}
