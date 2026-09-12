"use client";

import AssignmentLateIcon from "@mui/icons-material/AssignmentLate";
import FolderIcon from "@mui/icons-material/Folder";
import HistoryIcon from "@mui/icons-material/History";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Alert, Box, Button, Card, CardActionArea, CardContent, Chip, CircularProgress, Grid, Snackbar, Stack, Typography, alpha } from "@mui/material";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import AppShell from "@/components/AppShell";
import type { AuditEvent, Root, Task } from "@/types";

type Dashboard = { tasks: Task[]; roots: Root[]; recentActivity: AuditEvent[]; pendingApprovals: number };

function taskTone(task: Task, now = Date.now()): "overdue" | "halfway" | "normal" {
  const due = new Date(task.dueAt).getTime();
  if (task.status === "OVERDUE" || due < now) return "overdue";
  const scheduled = new Date(task.scheduledAt || task.createdAt).getTime();
  return due > scheduled && now >= scheduled + (due - scheduled) / 2 ? "halfway" : "normal";
}

function taskUrgencyLabel(task: Task, tone: ReturnType<typeof taskTone>): string {
  if (!["PENDING", "IN_PROGRESS", "OVERDUE"].includes(task.status)) return "resolved";
  if (tone === "overdue") return "overdue";
  if (tone === "halfway") return "due soon";
  return "on schedule";
}

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [checking, setChecking] = useState("");
  const router = useRouter();

  async function load() {
    setError("");
    try { setData(await api<Dashboard>("/dashboard")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load dashboard"); }
  }

  useEffect(() => { void load(); }, []);

  async function checkFolder(task: Task) {
    setError(""); setChecking(task.id);
    try {
      const result = await api<{ task: Task; matched: boolean }>(`/tasks/${task.id}/check`, { method: "POST" });
      await load();
      setSuccess(result.matched ? `${task.title} completed: matching file found` : "Folder checked: no matching file found");
      window.setTimeout(() => setSuccess(""), 2000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to check the SFTP folder"); }
    finally { setChecking(""); }
  }

  return (
    <AppShell title="Home">
      <Stack spacing={3}>
        {error && <Alert severity="error" variant="filled" onClose={() => setError("")}>{error}</Alert>}
        {!data ? <CircularProgress aria-label="Loading dashboard" /> : (
          <>
            <Box><Typography variant="h4">Good to see you</Typography><Typography color="text.secondary">Here is what needs attention across your SFTP workspace.</Typography></Box>
            {data.pendingApprovals > 0 && <Alert severity="warning" action={<Button onClick={() => router.push("/admin")}>Review</Button>}>{data.pendingApprovals} signup request{data.pendingApprovals === 1 ? "" : "s"} awaiting approval.</Alert>}
            <Section title="Action required" icon={<AssignmentLateIcon color="primary" />}>
              <Grid container spacing={2}>
                {data.tasks.length === 0 ? <Empty text="No pending actions." /> : data.tasks.map((task) => {
                  const tone = taskTone(task);
                  return (
                    <Grid item xs={12} md={6} key={task.id}>
                      <Card aria-label={`${task.title}; ${task.status}; ${taskUrgencyLabel(task, tone)}; due ${new Date(task.dueAt).toLocaleString()}`} data-task-tone={tone} sx={(theme) => tone === "overdue" ? { border: `2px solid ${theme.palette.error.main}`, backgroundColor: alpha(theme.palette.error.main, 0.1) } : tone === "halfway" ? { border: `2px solid ${theme.palette.warning.main}`, backgroundColor: alpha(theme.palette.warning.main, 0.08) } : {}}>
                        <CardContent><Stack spacing={1.5}>
                          <Stack direction="row" justifyContent="space-between" spacing={1}><Typography variant="h6">{task.title}</Typography><Chip label={task.status} color={tone === "overdue" ? "error" : tone === "halfway" ? "warning" : "primary"} size="small" /></Stack>
                          <Typography color="text.secondary">{task.instructions}</Typography>
                          <Typography variant="caption">{task.serverName || task.serverId} · {task.targetPath}</Typography>
                          <Typography variant="caption">Due {new Date(task.dueAt).toLocaleString()}</Typography>
                          {task.lastCheckedAt && <Typography variant="caption" color="text.secondary">Last folder check {new Date(task.lastCheckedAt).toLocaleString()}</Typography>}
                          <Stack direction="row" spacing={1} flexWrap="wrap">
                            <Button variant="contained" onClick={() => router.push(`/files?serverId=${task.serverId}&path=${encodeURIComponent(task.targetPath)}`)}>Open folder</Button>
                            {task.completionMode === "MATCHING_UPLOAD" && <Button startIcon={checking === task.id ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />} disabled={Boolean(checking)} onClick={() => checkFolder(task)}>Check folder</Button>}
                          </Stack>
                        </Stack></CardContent>
                      </Card>
                    </Grid>
                  );
                })}
              </Grid>
            </Section>
            <Section title="Accessible folders" icon={<FolderIcon color="primary" />}>
              <Grid container spacing={2}>{data.roots.length === 0 ? <Empty text="No folders have been assigned." /> : data.roots.map((root) => <Grid item xs={12} sm={6} md={4} key={`${root.serverId}:${root.path}`}><Card><CardActionArea onClick={() => router.push(`/files?serverId=${root.serverId}&path=${encodeURIComponent(root.path)}`)}><CardContent><FolderIcon color="primary" /><Typography variant="h6">{root.serverName}</Typography><Typography color="text.secondary" noWrap>{root.path}</Typography></CardContent></CardActionArea></Card></Grid>)}</Grid>
            </Section>
            <Section title="Recent activity" icon={<HistoryIcon color="primary" />}>
              <Card><CardContent><Stack divider={<Box sx={{ borderTop: "1px solid #e2e8f0" }} />}>{data.recentActivity.length === 0 ? <Typography color="text.secondary">No recent activity.</Typography> : data.recentActivity.map((event) => <Box key={event.id} py={1}><Typography fontWeight={650}>{event.action.replaceAll("_", " ")}</Typography><Typography variant="caption" color="text.secondary">{new Date(event.timestamp).toLocaleString()} {event.path ? `• ${event.path}` : ""}</Typography></Box>)}</Stack></CardContent></Card>
            </Section>
          </>
        )}
      </Stack>
      <Snackbar open={Boolean(success)} autoHideDuration={2000} onClose={() => setSuccess("")} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}><Alert severity="success" variant="filled">{success}</Alert></Snackbar>
    </AppShell>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <Stack spacing={1.5}><Stack direction="row" spacing={1} alignItems="center">{icon}<Typography variant="h5">{title}</Typography></Stack>{children}</Stack>;
}

function Empty({ text }: { text: string }) {
  return <Grid item xs={12}><Alert severity="info">{text}</Alert></Grid>;
}
