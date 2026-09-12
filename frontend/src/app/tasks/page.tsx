"use client";

import AddTaskIcon from "@mui/icons-material/AddTask";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DoNotDisturbAltIcon from "@mui/icons-material/DoNotDisturbAlt";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, InputLabel, MenuItem, Select, Stack, TextField, Typography } from "@mui/material";
import { FormEvent, useEffect, useState } from "react";
import { api } from "@/api/client";
import AppShell from "@/components/AppShell";
import type { Server, Task, User } from "@/types";

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [error, setError] = useState("");
  const [dismissTask, setDismissTask] = useState<Task | null>(null);
  const [reason, setReason] = useState("");
  const [form, setForm] = useState({ title: "", instructions: "", serverId: "", targetPath: "/", assigneeId: "", dueAt: "", completionMode: "MANUAL", filenameGlob: "" });
  async function load() {
    try {
      const [taskResult, current] = await Promise.all([api<{ items: Task[] }>("/tasks"), api<{ user: User }>("/auth/me")]);
      setTasks(taskResult.items); setMe(current.user);
      if (current.user.role === "ADMIN") {
        const [userResult, serverResult] = await Promise.all([api<{ items: User[] }>("/users"), api<{ items: Server[] }>("/sftp-servers")]);
        setUsers(userResult.items.filter((user) => user.state === "ACTIVE")); setServers(serverResult.items.filter((server) => server.enabled));
        setForm((currentForm) => ({ ...currentForm, assigneeId: currentForm.assigneeId || userResult.items.find((user) => user.role === "USER")?.id || "", serverId: currentForm.serverId || serverResult.items[0]?.id || "" }));
      }
    } catch (reasonValue) { setError((reasonValue as Error).message); }
  }
  useEffect(() => { load(); }, []);
  async function action(task: Task, value: string, body?: object) { try { await api(`/tasks/${task.id}/${value}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }); setDismissTask(null); setReason(""); await load(); } catch (reasonValue) { setError((reasonValue as Error).message); } }
  async function create(event: FormEvent) { event.preventDefault(); try { await api("/tasks", { method: "POST", body: JSON.stringify({ ...form, dueAt: new Date(form.dueAt).toISOString(), filenameGlob: form.filenameGlob || null }) }); setForm({ ...form, title: "", instructions: "", dueAt: "", filenameGlob: "" }); await load(); } catch (reasonValue) { setError((reasonValue as Error).message); } }
  return <AppShell title="Tasks"><Stack spacing={2.5}><Box><Typography variant="h4">File tasks</Typography><Typography color="text.secondary">Track expected uploads and other SFTP actions.</Typography></Box>{error && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}{!me ? <CircularProgress /> : <>{me.role === "ADMIN" && <Card><CardContent><Stack component="form" spacing={2} onSubmit={create}><Stack direction="row" spacing={1} alignItems="center"><AddTaskIcon color="primary" /><Typography variant="h6">Create task</Typography></Stack><TextField label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /><TextField label="Instructions" multiline minRows={2} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /><Stack direction={{ xs: "column", md: "row" }} spacing={2}><FormControl fullWidth><InputLabel>Assignee</InputLabel><Select label="Assignee" value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>{users.map((user) => <MenuItem key={user.id} value={user.id}>{user.email}</MenuItem>)}</Select></FormControl><FormControl fullWidth><InputLabel>Server</InputLabel><Select label="Server" value={form.serverId} onChange={(e) => setForm({ ...form, serverId: e.target.value })}>{servers.map((server) => <MenuItem key={server.id} value={server.id}>{server.name}</MenuItem>)}</Select></FormControl><TextField label="Target path" value={form.targetPath} onChange={(e) => setForm({ ...form, targetPath: e.target.value })} fullWidth /><TextField label="Due" type="datetime-local" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} InputLabelProps={{ shrink: true }} required fullWidth /></Stack><Stack direction={{ xs: "column", md: "row" }} spacing={2}><FormControl fullWidth><InputLabel>Completion</InputLabel><Select label="Completion" value={form.completionMode} onChange={(e) => setForm({ ...form, completionMode: e.target.value })}><MenuItem value="MANUAL">Manual</MenuItem><MenuItem value="MATCHING_UPLOAD">Matching upload</MenuItem></Select></FormControl>{form.completionMode === "MATCHING_UPLOAD" && <TextField label="Filename pattern" placeholder="report-*.csv" value={form.filenameGlob} onChange={(e) => setForm({ ...form, filenameGlob: e.target.value })} required fullWidth />}</Stack><Button variant="contained" type="submit" disabled={!form.serverId || !form.assigneeId} sx={{ alignSelf: "flex-start" }}>Create task</Button></Stack></CardContent></Card>}<Stack spacing={1.5}>{tasks.length === 0 && <Alert severity="info">No tasks to show.</Alert>}{tasks.map((task) => <Card key={task.id}><CardContent><Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ md: "center" }}><Box flex={1}><Stack direction="row" spacing={1} alignItems="center"><Typography variant="h6">{task.title}</Typography><Chip size="small" label={task.status} color={task.status === "OVERDUE" ? "error" : task.status === "COMPLETED" ? "success" : "warning"} /></Stack><Typography color="text.secondary">{task.instructions}</Typography><Typography variant="caption">{task.targetPath} · due {new Date(task.dueAt).toLocaleString()}</Typography></Box>{task.status === "PENDING" && <Button startIcon={<PlayArrowIcon />} onClick={() => action(task, "start")}>Start</Button>}{["PENDING", "IN_PROGRESS", "OVERDUE"].includes(task.status) && <><Button color="success" startIcon={<CheckCircleIcon />} onClick={() => action(task, "complete")}>Complete</Button><Button color="warning" startIcon={<DoNotDisturbAltIcon />} onClick={() => setDismissTask(task)}>Dismiss</Button></>}</Stack></CardContent></Card>)}</Stack></>}</Stack><Dialog open={Boolean(dismissTask)} onClose={() => setDismissTask(null)}><DialogTitle>Dismiss task</DialogTitle><DialogContent><TextField autoFocus fullWidth multiline minRows={3} margin="dense" label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} helperText="Required, 3–500 characters" /></DialogContent><DialogActions><Button onClick={() => setDismissTask(null)}>Cancel</Button><Button variant="contained" color="warning" disabled={reason.trim().length < 3} onClick={() => dismissTask && action(dismissTask, "dismiss", { reason })}>Dismiss</Button></DialogActions></Dialog></AppShell>;
}
