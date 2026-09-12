"use client";

import AssignmentLateIcon from "@mui/icons-material/AssignmentLate";
import FolderIcon from "@mui/icons-material/Folder";
import HistoryIcon from "@mui/icons-material/History";
import { Alert, Box, Button, Card, CardActionArea, CardContent, Chip, CircularProgress, Grid, Stack, Typography } from "@mui/material";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import AppShell from "@/components/AppShell";
import type { AuditEvent, Root, Task } from "@/types";

type Dashboard = { tasks: Task[]; roots: Root[]; recentActivity: AuditEvent[]; pendingApprovals: number };

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const router = useRouter();
  const load = () => api<Dashboard>("/dashboard").then(setData).catch((reason) => setError(reason.message));
  useEffect(() => { void load(); }, []);
  return <AppShell title="Home"><Stack spacing={3}>{error && <Alert severity="error">{error}</Alert>}{!data ? <CircularProgress /> : <><Box><Typography variant="h4">Good to see you</Typography><Typography color="text.secondary">Here is what needs attention across your SFTP workspace.</Typography></Box>{data.pendingApprovals > 0 && <Alert severity="warning" action={<Button onClick={() => router.push("/admin")}>Review</Button>}>{data.pendingApprovals} signup request{data.pendingApprovals === 1 ? "" : "s"} awaiting approval.</Alert>}<Section title="Action required" icon={<AssignmentLateIcon color="primary" />}><Grid container spacing={2}>{data.tasks.length === 0 ? <Empty text="No pending actions." /> : data.tasks.map((task) => <Grid item xs={12} md={6} key={task.id}><Card><CardContent><Stack spacing={1.5}><Stack direction="row" justifyContent="space-between"><Typography variant="h6">{task.title}</Typography><Chip label={task.status} color={task.status === "OVERDUE" ? "error" : "warning"} size="small" /></Stack><Typography color="text.secondary">{task.instructions}</Typography><Typography variant="caption">Due {new Date(task.dueAt).toLocaleString()}</Typography><Button variant="contained" onClick={() => router.push(`/files?serverId=${task.serverId}&path=${encodeURIComponent(task.targetPath)}`)}>Open folder</Button></Stack></CardContent></Card></Grid>)}</Grid></Section><Section title="Accessible folders" icon={<FolderIcon color="primary" />}><Grid container spacing={2}>{data.roots.length === 0 ? <Empty text="No folders have been assigned." /> : data.roots.map((root) => <Grid item xs={12} sm={6} md={4} key={`${root.serverId}:${root.path}`}><Card><CardActionArea onClick={() => router.push(`/files?serverId=${root.serverId}&path=${encodeURIComponent(root.path)}`)}><CardContent><FolderIcon color="primary" /><Typography variant="h6">{root.serverName}</Typography><Typography color="text.secondary" noWrap>{root.path}</Typography></CardContent></CardActionArea></Card></Grid>)}</Grid></Section><Section title="Recent activity" icon={<HistoryIcon color="primary" />}><Card><CardContent><Stack divider={<Box sx={{ borderTop: "1px solid #e2e8f0" }} />}>{data.recentActivity.length === 0 ? <Typography color="text.secondary">No recent activity.</Typography> : data.recentActivity.map((event) => <Box key={event.id} py={1}><Typography fontWeight={650}>{event.action.replaceAll("_", " ")}</Typography><Typography variant="caption" color="text.secondary">{new Date(event.timestamp).toLocaleString()} {event.path ? `• ${event.path}` : ""}</Typography></Box>)}</Stack></CardContent></Card></Section></>}</Stack></AppShell>;
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <Stack spacing={1.5}><Stack direction="row" spacing={1} alignItems="center">{icon}<Typography variant="h5">{title}</Typography></Stack>{children}</Stack>; }
function Empty({ text }: { text: string }) { return <Grid item xs={12}><Alert severity="info">{text}</Alert></Grid>; }
