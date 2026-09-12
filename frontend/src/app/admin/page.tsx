"use client";

import AddIcon from "@mui/icons-material/Add";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import NetworkCheckIcon from "@mui/icons-material/NetworkCheck";
import VisibilityIcon from "@mui/icons-material/Visibility";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormGroup,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { FormEvent, useEffect, useState } from "react";
import { api } from "@/api/client";
import AppShell from "@/components/AppShell";
import type { Grant, Group, Server, User } from "@/types";

const permissionOptions = ["LIST", "DOWNLOAD", "UPLOAD", "CREATE_FOLDER", "RENAME", "MOVE", "DELETE", "MANAGE_TASKS"];
const roles = ["ADMIN", "MANAGER", "USER", "AUDITOR"];
const userStates = ["PENDING_APPROVAL", "ACTIVE", "SUSPENDED", "REJECTED"];

type Done = (value: string) => Promise<void>;
type Fail = (value: string) => void;

type ServerForm = {
  name: string;
  description: string;
  host: string;
  port: string;
  username: string;
  authType: string;
  password: string;
  privateKey: string;
  passphrase: string;
  rootPath: string;
  adapterType: string;
  enabled: boolean;
};

type GrantForm = {
  principalType: string;
  principalId: string;
  serverId: string;
  path: string;
  permissions: string[];
  recursive: boolean;
};

type GroupForm = { name: string; description: string; memberIds: string[] };

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function BusyIcon() {
  return <CircularProgress size={18} color="inherit" />;
}

export default function AdminPage() {
  const [tab, setTab] = useState(0);
  const [users, setUsers] = useState<User[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [userResult, serverResult, grantResult, groupResult] = await Promise.all([
        api<{ items: User[] }>("/users"),
        api<{ items: Server[] }>("/sftp-servers"),
        api<{ items: Grant[] }>("/access-grants"),
        api<{ items: Group[] }>("/groups"),
      ]);
      setUsers(userResult.items);
      setServers(serverResult.items);
      setGrants(grantResult.items);
      setGroups(groupResult.items);
    } catch (reason) {
      setError(errorMessage(reason, "Unable to load admin data"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api<{ user: User }>("/auth/me")
      .then((result) => {
        if (result.user.role === "ADMIN") return load();
        setLoading(false);
      })
      .catch((reason) => {
        setError(errorMessage(reason, "Unable to verify administrator access"));
        setLoading(false);
      });
  }, []);

  const done: Done = async (text) => {
    setError("");
    await load();
    setMessage(text);
  };

  return (
    <AppShell title="Administration" requiredRole="ADMIN">
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="h4">Administration</Typography>
          <Typography color="text.secondary">Manage accounts, SFTP connections, groups, and folder access.</Typography>
        </Box>
        {error && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}
        <Tabs value={tab} onChange={(_, value) => { setTab(value); setError(""); }} variant="scrollable">
          <Tab label={`Users (${users.length})`} />
          <Tab label={`Servers (${servers.length})`} />
          <Tab label={`Access (${grants.length})`} />
          <Tab label={`Groups (${groups.length})`} />
        </Tabs>
        {loading ? <CircularProgress /> : (
          <>
            {tab === 0 && <UsersPanel users={users} done={done} fail={setError} />}
            {tab === 1 && <ServersPanel servers={servers} done={done} fail={setError} />}
            {tab === 2 && <AccessPanel grants={grants} users={users} groups={groups} servers={servers} done={done} fail={setError} />}
            {tab === 3 && <GroupsPanel groups={groups} users={users} done={done} fail={setError} />}
          </>
        )}
        <Snackbar
          open={Boolean(message)}
          autoHideDuration={2000}
          onClose={() => setMessage("")}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        >
          <Alert severity="success" variant="filled" onClose={() => setMessage("")} sx={{ width: "100%" }}>
            {message}
          </Alert>
        </Snackbar>
      </Stack>
    </AppShell>
  );
}

function UsersPanel({ users, done, fail }: { users: User[]; done: Done; fail: Fail }) {
  const [editing, setEditing] = useState<User | null>(null);
  const [editForm, setEditForm] = useState({ displayName: "", email: "", role: "USER", state: "ACTIVE" });
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState("");

  function openEdit(user: User) {
    setEditing(user);
    setEditForm({ displayName: user.displayName, email: user.email, role: user.role, state: user.state });
    setEditError("");
    fail("");
  }

  function closeEdit() {
    if (saving) return;
    setEditing(null);
    setEditError("");
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setEditError("");
    setSaving(true);
    try {
      const updated = await api<User>(`/users/${editing.id}`, { method: "PATCH", body: JSON.stringify(editForm) });
      setSaving(false);
      setEditing(null);
      await done(`${updated.email} updated`);
    } catch (reason) {
      setEditError(errorMessage(reason, "Unable to update user"));
      setSaving(false);
    }
  }

  async function approve(user: User) {
    setActionBusy(`approve:${user.id}`);
    try {
      await api(`/users/${user.id}/approve`, { method: "POST", body: JSON.stringify({ role: "USER" }) });
      await done(`${user.email} approved`);
    } catch (reason) {
      fail(errorMessage(reason, "Unable to approve user"));
    } finally {
      setActionBusy("");
    }
  }

  async function reject(user: User) {
    setActionBusy(`reject:${user.id}`);
    try {
      await api(`/users/${user.id}/reject`, { method: "POST" });
      await done(`${user.email} rejected`);
    } catch (reason) {
      fail(errorMessage(reason, "Unable to reject user"));
    } finally {
      setActionBusy("");
    }
  }

  async function revokeSessions(user: User) {
    setActionBusy(`revoke:${user.id}`);
    try {
      await api(`/users/${user.id}/revoke-sessions`, { method: "POST" });
      await done(`${user.email} sessions revoked`);
    } catch (reason) {
      fail(errorMessage(reason, "Unable to revoke sessions"));
    } finally {
      setActionBusy("");
    }
  }

  return (
    <Stack spacing={1.5}>
      {users.map((user) => (
        <Card key={user.id}>
          <CardContent>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ md: "center" }}>
              <Box flex={1}>
                <Typography fontWeight={750}>{user.displayName}</Typography>
                <Typography color="text.secondary">{user.email} · {user.role}</Typography>
              </Box>
              <Chip label={user.state} color={user.state === "ACTIVE" ? "success" : "warning"} />
              {user.state === "PENDING_APPROVAL" && (
                <>
                  <Button
                    variant="contained"
                    startIcon={actionBusy === `approve:${user.id}` ? <BusyIcon /> : <CheckCircleIcon />}
                    disabled={Boolean(actionBusy)}
                    onClick={() => approve(user)}
                  >
                    Approve
                  </Button>
                  <Button color="error" disabled={Boolean(actionBusy)} onClick={() => reject(user)}>
                    {actionBusy === `reject:${user.id}` ? <BusyIcon /> : "Reject"}
                  </Button>
                </>
              )}
              <Button startIcon={<EditIcon />} aria-label={`Edit ${user.email}`} onClick={() => openEdit(user)}>Edit</Button>
              <Button disabled={Boolean(actionBusy)} onClick={() => revokeSessions(user)}>
                {actionBusy === `revoke:${user.id}` ? <BusyIcon /> : "Revoke sessions"}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      ))}

      <Dialog open={Boolean(editing)} onClose={closeEdit} fullWidth maxWidth="sm">
        <DialogTitle>Edit user</DialogTitle>
        <Stack component="form" onSubmit={saveEdit}>
          <DialogContent>
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">User ID: {editing?.id}</Typography>
              <TextField
                autoFocus
                label="Display name"
                value={editForm.displayName}
                onChange={(event) => setEditForm({ ...editForm, displayName: event.target.value })}
                required
              />
              <TextField
                label="Email"
                type="email"
                autoComplete="email"
                value={editForm.email}
                onChange={(event) => setEditForm({ ...editForm, email: event.target.value })}
                required
              />
              <FormControl fullWidth>
                <InputLabel>Role</InputLabel>
                <Select label="Role" value={editForm.role} onChange={(event) => setEditForm({ ...editForm, role: event.target.value })}>
                  {roles.map((role) => <MenuItem key={role} value={role}>{role}</MenuItem>)}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel>Account state</InputLabel>
                <Select label="Account state" value={editForm.state} onChange={(event) => setEditForm({ ...editForm, state: event.target.value })}>
                  {userStates.map((state) => <MenuItem key={state} value={state}>{state.replaceAll("_", " ")}</MenuItem>)}
                </Select>
              </FormControl>
            </Stack>
          </DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}>
            <Button type="submit" variant="contained" startIcon={saving ? <BusyIcon /> : undefined} disabled={saving || !editForm.displayName.trim() || !editForm.email.trim()}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
            <Button type="button" onClick={closeEdit} disabled={saving}>Cancel</Button>
          </DialogActions>
          {editError && <Alert severity="error" sx={{ mx: 3, mb: 2 }}>{editError}</Alert>}
        </Stack>
      </Dialog>
    </Stack>
  );
}

function blankServerForm(): ServerForm {
  return {
    name: "",
    description: "",
    host: "",
    port: "22",
    username: "",
    authType: "PASSWORD",
    password: "",
    privateKey: "",
    passphrase: "",
    rootPath: "/",
    adapterType: "REAL",
    enabled: true,
  };
}

function serverFormFrom(server: Server): ServerForm {
  return {
    name: server.name,
    description: server.description,
    host: server.host,
    port: String(server.port),
    username: server.username,
    authType: server.authType,
    password: "",
    privateKey: "",
    passphrase: "",
    rootPath: server.rootPath,
    adapterType: server.adapterType,
    enabled: server.enabled,
  };
}

function ServerFields({ form, change, editing }: { form: ServerForm; change: (values: Partial<ServerForm>) => void; editing: boolean }) {
  const credentialRequired = form.adapterType === "REAL" && !editing;
  return (
    <>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <TextField label="Display name" value={form.name} onChange={(event) => change({ name: event.target.value })} required fullWidth />
        <FormControl fullWidth>
          <InputLabel>Connection type</InputLabel>
          <Select
            label="Connection type"
            value={form.adapterType}
            onChange={(event) => change({ adapterType: event.target.value, host: event.target.value === "MOCK" ? "mock.local" : form.host })}
          >
            <MenuItem value="REAL">Real SFTP</MenuItem>
            <MenuItem value="MOCK">Mock SFTP</MenuItem>
          </Select>
        </FormControl>
      </Stack>
      <TextField label="Description" value={form.description} onChange={(event) => change({ description: event.target.value })} fullWidth />
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <TextField label="Host" value={form.host} onChange={(event) => change({ host: event.target.value })} required fullWidth />
        <TextField label="Port" type="number" value={form.port} onChange={(event) => change({ port: event.target.value })} sx={{ width: { xs: "100%", md: 150 } }} />
        <TextField label="Username" value={form.username} onChange={(event) => change({ username: event.target.value })} fullWidth />
      </Stack>
      {form.adapterType === "REAL" && (
        <>
          <FormControl fullWidth>
            <InputLabel>Authentication</InputLabel>
            <Select label="Authentication" value={form.authType} onChange={(event) => change({ authType: event.target.value })}>
              <MenuItem value="PASSWORD">Password</MenuItem>
              <MenuItem value="PRIVATE_KEY">Private key</MenuItem>
            </Select>
          </FormControl>
          {form.authType === "PASSWORD" ? (
            <TextField
              label={editing ? "New password (leave blank to keep current)" : "Password"}
              type="password"
              value={form.password}
              onChange={(event) => change({ password: event.target.value })}
              required={credentialRequired}
              fullWidth
            />
          ) : (
            <Stack spacing={2}>
              <TextField
                label={editing ? "New private key (leave blank to keep current)" : "Private key"}
                multiline
                minRows={5}
                value={form.privateKey}
                onChange={(event) => change({ privateKey: event.target.value })}
                required={credentialRequired}
                fullWidth
              />
              <TextField label="Private key passphrase" type="password" value={form.passphrase} onChange={(event) => change({ passphrase: event.target.value })} fullWidth />
            </Stack>
          )}
          <Alert severity="info">
            The portal connects first, automatically retrieves the server&apos;s SHA-256 host-key fingerprint, and pins it when the server is saved.
          </Alert>
        </>
      )}
      <TextField label="Remote root" value={form.rootPath} onChange={(event) => change({ rootPath: event.target.value })} fullWidth />
    </>
  );
}

function ServersPanel({ servers, done, fail }: { servers: Server[]; done: Done; fail: Fail }) {
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<ServerForm>(blankServerForm);
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Server | null>(null);
  const [editForm, setEditForm] = useState<ServerForm>(blankServerForm);
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState<Server | null>(null);
  const [rotationPassword, setRotationPassword] = useState("");
  const [rotationError, setRotationError] = useState("");
  const [rotatingBusy, setRotatingBusy] = useState(false);
  const [deleting, setDeleting] = useState<Server | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState("");

  function startAdd() {
    setAddForm(blankServerForm());
    setAddError("");
    setAddOpen(true);
    fail("");
  }

  function closeAdd() {
    if (adding) return;
    setAddOpen(false);
    setAddForm(blankServerForm());
    setAddError("");
  }

  function openEdit(server: Server) {
    setEditing(server);
    setEditForm(serverFormFrom(server));
    setEditError("");
    fail("");
  }

  function closeEdit() {
    if (saving) return;
    setEditing(null);
    setEditError("");
    setEditForm(blankServerForm());
  }

  async function addServer(event: FormEvent) {
    event.preventDefault();
    setAddError("");
    setAdding(true);
    try {
      await api("/sftp-servers", { method: "POST", body: JSON.stringify({ ...addForm, port: Number(addForm.port) }) });
      setAdding(false);
      setAddOpen(false);
      setAddForm(blankServerForm());
      await done("SFTP server connected and added");
    } catch (reason) {
      setAddError(errorMessage(reason, "Unable to add SFTP server"));
      setAdding(false);
    }
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setEditError("");
    setSaving(true);
    try {
      await api(`/sftp-servers/${editing.id}`, { method: "PATCH", body: JSON.stringify({ ...editForm, port: Number(editForm.port) }) });
      setSaving(false);
      setEditing(null);
      setEditForm(blankServerForm());
      await done("SFTP server updated");
    } catch (reason) {
      setEditError(errorMessage(reason, "Unable to update SFTP server"));
      setSaving(false);
    }
  }

  async function test(server: Server) {
    setRowBusy(`test:${server.id}`);
    try {
      const result = await api<{ success: boolean; message: string }>(`/sftp-servers/${server.id}/test`, { method: "POST" });
      if (!result.success) throw new Error(result.message);
      await done(`${server.name} connection succeeded`);
    } catch (reason) {
      fail(errorMessage(reason, "Connection test failed"));
    } finally {
      setRowBusy("");
    }
  }

  async function toggle(server: Server) {
    setRowBusy(`toggle:${server.id}`);
    try {
      await api(`/sftp-servers/${server.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...serverFormFrom(server), port: server.port, enabled: !server.enabled }),
      });
      await done(`${server.name} ${server.enabled ? "disabled" : "enabled"}`);
    } catch (reason) {
      fail(errorMessage(reason, "Unable to update server state"));
    } finally {
      setRowBusy("");
    }
  }

  function openRotation(server: Server) {
    setRotating(server);
    setRotationPassword("");
    setRotationError("");
    fail("");
  }

  function closeRotation() {
    if (rotatingBusy) return;
    setRotating(null);
    setRotationPassword("");
    setRotationError("");
  }

  async function rotate(event: FormEvent) {
    event.preventDefault();
    if (!rotating) return;
    setRotationError("");
    setRotatingBusy(true);
    try {
      const name = rotating.name;
      await api(`/sftp-servers/${rotating.id}/rotate-credential`, { method: "POST", body: JSON.stringify({ authType: "PASSWORD", password: rotationPassword }) });
      setRotatingBusy(false);
      setRotating(null);
      setRotationPassword("");
      await done(`${name} credential rotated`);
    } catch (reason) {
      setRotationError(errorMessage(reason, "Unable to rotate credential"));
      setRotatingBusy(false);
    }
  }

  function openDelete(server: Server) {
    setDeleting(server);
    setDeleteError("");
    fail("");
  }

  function closeDelete() {
    if (deletingBusy) return;
    setDeleting(null);
    setDeleteError("");
  }

  async function removeServer() {
    if (!deleting) return;
    const server = deleting;
    setDeleteError("");
    setDeletingBusy(true);
    try {
      await api(`/sftp-servers/${server.id}`, { method: "DELETE" });
      setDeletingBusy(false);
      setDeleting(null);
      await done(`${server.name} and associated configuration deleted`);
    } catch (reason) {
      setDeleteError(errorMessage(reason, "Unable to delete SFTP server"));
      setDeletingBusy(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} justifyContent="space-between">
        <Box>
          <Typography variant="h6">SFTP servers</Typography>
          <Typography color="text.secondary">Connected servers and their pinned host identities.</Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={startAdd} aria-expanded={addOpen}>Add SFTP server</Button>
      </Stack>

      {servers.length === 0 && <Alert severity="info">No SFTP servers are configured yet.</Alert>}
      {servers.map((server) => (
        <Card key={server.id}>
          <CardContent>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
              <Box flex={1}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="h6">{server.name}</Typography>
                  <Chip size="small" label={server.adapterType} />
                  <Chip size="small" color={server.enabled ? "success" : "default"} label={server.enabled ? "Enabled" : "Disabled"} />
                </Stack>
                <Typography color="text.secondary">{server.host}:{server.port} · root {server.rootPath}</Typography>
                {server.hostKeyFingerprint && (
                  <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>Pinned host key: {server.hostKeyFingerprint}</Typography>
                )}
              </Box>
              <Button startIcon={<EditIcon />} aria-label={`Edit ${server.name}`} onClick={() => openEdit(server)}>Edit</Button>
              {server.adapterType === "REAL" && <Button onClick={() => openRotation(server)}>Rotate credential</Button>}
              <Button color={server.enabled ? "warning" : "success"} disabled={Boolean(rowBusy)} onClick={() => toggle(server)}>
                {rowBusy === `toggle:${server.id}` ? <BusyIcon /> : server.enabled ? "Disable" : "Enable"}
              </Button>
              <Button variant="outlined" startIcon={rowBusy === `test:${server.id}` ? <BusyIcon /> : <NetworkCheckIcon />} disabled={Boolean(rowBusy)} onClick={() => test(server)}>
                Test connection
              </Button>
              <Button color="error" startIcon={<DeleteIcon />} disabled={Boolean(rowBusy)} aria-label={`Delete ${server.name}`} onClick={() => openDelete(server)}>
                Delete
              </Button>
            </Stack>
          </CardContent>
        </Card>
      ))}

      <Dialog open={addOpen} onClose={closeAdd} fullWidth maxWidth="md">
        <DialogTitle>Add SFTP server</DialogTitle>
        <Stack component="form" spacing={2} onSubmit={addServer}>
          <DialogContent>
            <Stack spacing={2}>
              <ServerFields form={addForm} change={(values) => setAddForm((current) => ({ ...current, ...values }))} editing={false} />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}>
            <Button type="submit" variant="contained" startIcon={adding ? <BusyIcon /> : <NetworkCheckIcon />} disabled={adding}>
              {adding ? "Connecting…" : "Connect and add server"}
            </Button>
            <Button type="button" onClick={closeAdd} disabled={adding}>Cancel</Button>
          </DialogActions>
          {addError && <Alert severity="error" sx={{ mx: 3, mb: 2 }}>{addError}</Alert>}
        </Stack>
      </Dialog>

      <Dialog open={Boolean(editing)} onClose={closeEdit} fullWidth maxWidth="md">
        <DialogTitle>Edit SFTP server</DialogTitle>
        <Stack component="form" onSubmit={saveEdit}>
          <DialogContent>
            <Stack spacing={2}>
              <ServerFields form={editForm} change={(values) => setEditForm((current) => ({ ...current, ...values }))} editing />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}>
            <Button type="submit" variant="contained" startIcon={saving ? <BusyIcon /> : <NetworkCheckIcon />} disabled={saving}>
              {saving ? "Testing and saving…" : "Test and save changes"}
            </Button>
            <Button type="button" onClick={closeEdit} disabled={saving}>Cancel</Button>
          </DialogActions>
          {editError && <Alert severity="error" sx={{ mx: 3, mb: 2 }}>{editError}</Alert>}
        </Stack>
      </Dialog>

      <Dialog open={Boolean(rotating)} onClose={closeRotation} fullWidth maxWidth="sm">
        <DialogTitle>Rotate {rotating?.name} credential</DialogTitle>
        <Stack component="form" onSubmit={rotate}>
          <DialogContent>
            <TextField autoFocus fullWidth label="New password" type="password" value={rotationPassword} onChange={(event) => setRotationPassword(event.target.value)} />
          </DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}>
            <Button type="submit" variant="contained" startIcon={rotatingBusy ? <BusyIcon /> : undefined} disabled={rotatingBusy || !rotationPassword}>
              {rotatingBusy ? "Rotating…" : "Rotate"}
            </Button>
            <Button type="button" onClick={closeRotation} disabled={rotatingBusy}>Cancel</Button>
          </DialogActions>
          {rotationError && <Alert severity="error" sx={{ mx: 3, mb: 2 }}>{rotationError}</Alert>}
        </Stack>
      </Dialog>

      <Dialog open={Boolean(deleting)} onClose={closeDelete} fullWidth maxWidth="sm">
        <DialogTitle>Delete SFTP server</DialogTitle>
        <DialogContent>
          <Alert severity="warning">
            Deleting <strong>{deleting?.name}</strong> also permanently removes its folder-access grants, tasks, encrypted credential, and unfinished upload-session records. Audit history and files on the remote SFTP server are retained.
          </Alert>
        </DialogContent>
        <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}>
          <Button variant="contained" color="error" startIcon={deletingBusy ? <BusyIcon /> : <DeleteIcon />} disabled={deletingBusy} onClick={() => void removeServer()}>
            {deletingBusy ? "Deleting…" : "Delete server"}
          </Button>
          <Button type="button" onClick={closeDelete} disabled={deletingBusy}>Cancel</Button>
        </DialogActions>
        {deleteError && <Alert severity="error" sx={{ mx: 3, mb: 2 }}>{deleteError}</Alert>}
      </Dialog>
    </Stack>
  );
}

function GrantFields({ form, change, users, groups, servers }: { form: GrantForm; change: (values: Partial<GrantForm>) => void; users: User[]; groups: Group[]; servers: Server[] }) {
  const principals = form.principalType === "USER" ? users : groups;
  return (
    <>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <FormControl fullWidth>
          <InputLabel>Principal type</InputLabel>
          <Select
            label="Principal type"
            value={form.principalType}
            onChange={(event) => {
              const principalType = event.target.value;
              const options = principalType === "USER" ? users : groups;
              change({ principalType, principalId: options[0]?.id || "" });
            }}
          >
            <MenuItem value="USER">User</MenuItem>
            <MenuItem value="GROUP">Group</MenuItem>
          </Select>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel>User or group</InputLabel>
          <Select label="User or group" value={form.principalId} onChange={(event) => change({ principalId: event.target.value })}>
            {principals.map((principal) => (
              <MenuItem key={principal.id} value={principal.id}>{"email" in principal ? principal.email : principal.name}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel>Server</InputLabel>
          <Select label="Server" value={form.serverId} onChange={(event) => change({ serverId: event.target.value })}>
            {servers.map((server) => <MenuItem key={server.id} value={server.id}>{server.name}</MenuItem>)}
          </Select>
        </FormControl>
        <TextField label="Folder path" value={form.path} onChange={(event) => change({ path: event.target.value })} fullWidth />
      </Stack>
      <FormGroup row>
        {permissionOptions.map((permission) => (
          <FormControlLabel
            key={permission}
            control={(
              <Checkbox
                checked={form.permissions.includes(permission)}
                onChange={(_, checked) => change({ permissions: checked ? [...form.permissions, permission] : form.permissions.filter((item) => item !== permission) })}
              />
            )}
            label={permission.replaceAll("_", " ")}
          />
        ))}
        <FormControlLabel control={<Checkbox checked={form.recursive} onChange={(_, recursive) => change({ recursive })} />} label="Include child folders" />
      </FormGroup>
    </>
  );
}

function AccessPanel({ grants, users, groups, servers, done, fail }: { grants: Grant[]; users: User[]; groups: Group[]; servers: Server[]; done: Done; fail: Fail }) {
  const emptyForm = (): GrantForm => ({
    principalType: "USER",
    principalId: users[0]?.id || "",
    serverId: servers[0]?.id || "",
    path: "/",
    permissions: ["LIST", "DOWNLOAD"],
    recursive: true,
  });
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<GrantForm>(emptyForm);
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Grant | null>(null);
  const [editForm, setEditForm] = useState<GrantForm>(emptyForm);
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState("");

  function openAdd() {
    setAddForm(emptyForm());
    setAddError("");
    setAddOpen(true);
    fail("");
  }

  function closeAdd() {
    if (adding) return;
    setAddOpen(false);
    setAddForm(emptyForm());
    setAddError("");
  }

  function openEdit(grant: Grant) {
    setEditing(grant);
    setEditForm({
      principalType: grant.principalType,
      principalId: grant.principalId,
      serverId: grant.serverId,
      path: grant.path,
      permissions: [...grant.permissions],
      recursive: grant.recursive,
    });
    setEditError("");
    fail("");
  }

  function closeEdit() {
    if (saving) return;
    setEditing(null);
    setEditError("");
  }

  async function addGrant(event: FormEvent) {
    event.preventDefault();
    setAddError("");
    setAdding(true);
    try {
      await api("/access-grants", { method: "POST", body: JSON.stringify(addForm) });
      setAdding(false);
      setAddOpen(false);
      setAddForm(emptyForm());
      await done("Folder access granted");
    } catch (reason) {
      setAddError(errorMessage(reason, "Unable to grant folder access"));
      setAdding(false);
    }
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setEditError("");
    setSaving(true);
    try {
      await api(`/access-grants/${editing.id}`, { method: "PATCH", body: JSON.stringify(editForm) });
      setSaving(false);
      setEditing(null);
      await done("Folder access updated");
    } catch (reason) {
      setEditError(errorMessage(reason, "Unable to update folder access"));
      setSaving(false);
    }
  }

  async function remove(grant: Grant) {
    if (!window.confirm("Remove this folder grant?")) return;
    setRemovingId(grant.id);
    try {
      await api(`/access-grants/${grant.id}`, { method: "DELETE" });
      await done("Folder grant removed");
    } catch (reason) {
      fail(errorMessage(reason, "Unable to remove folder grant"));
    } finally {
      setRemovingId("");
    }
  }

  function principalName(grant: Grant) {
    if (grant.principalName) return grant.principalName;
    return grant.principalType === "GROUP"
      ? groups.find((group) => group.id === grant.principalId)?.name || "Unknown group"
      : users.find((user) => user.id === grant.principalId)?.email || "Unknown user";
  }

  function serverName(grant: Grant) {
    return grant.serverName || servers.find((server) => server.id === grant.serverId)?.name || "Unknown server";
  }

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} justifyContent="space-between">
        <Box>
          <Typography variant="h6">Folder access</Typography>
          <Typography color="text.secondary">Grant users and groups access to SFTP folders.</Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd} aria-expanded={addOpen}>Add folder grant</Button>
      </Stack>

      {grants.length === 0 && <Alert severity="info">No folder grants are configured yet.</Alert>}

      {grants.map((grant) => (
        <Card key={grant.id}>
          <CardContent>
            <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} spacing={2}>
              <Box flex={1}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <Chip size="small" label={grant.principalType === "GROUP" ? "Group" : "User"} color={grant.principalType === "GROUP" ? "primary" : "default"} />
                  <Typography variant="h6">{principalName(grant)}</Typography>
                </Stack>
                <Typography color="text.secondary">
                  {serverName(grant)} · {grant.path}{grant.recursive ? " and child folders" : ""}
                </Typography>
                <Typography variant="body2" color="text.secondary">{grant.permissions.join(", ")}</Typography>
              </Box>
              <Button startIcon={<EditIcon />} aria-label={`Edit ${grant.principalType.toLowerCase()} ${principalName(grant)} access`} onClick={() => openEdit(grant)}>Edit</Button>
              <Button color="error" startIcon={removingId === grant.id ? <BusyIcon /> : <DeleteIcon />} disabled={Boolean(removingId)} onClick={() => remove(grant)}>Remove</Button>
            </Stack>
          </CardContent>
        </Card>
      ))}

      <Dialog open={addOpen} onClose={closeAdd} fullWidth maxWidth="lg">
        <DialogTitle>Add folder grant</DialogTitle>
        <Stack component="form" onSubmit={addGrant}>
          <DialogContent>
            <Stack spacing={2}>
              <GrantFields form={addForm} change={(values) => setAddForm((current) => ({ ...current, ...values }))} users={users} groups={groups} servers={servers} />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}>
            <Button
              variant="contained"
              type="submit"
              startIcon={adding ? <BusyIcon /> : undefined}
              disabled={adding || !addForm.principalId || !addForm.serverId || addForm.permissions.length === 0}
            >
              {adding ? "Granting…" : "Grant access"}
            </Button>
            <Button type="button" onClick={closeAdd} disabled={adding}>Cancel</Button>
          </DialogActions>
          {addError && <Alert severity="error" sx={{ mx: 3, mb: 2 }}>{addError}</Alert>}
        </Stack>
      </Dialog>

      <Dialog open={Boolean(editing)} onClose={closeEdit} fullWidth maxWidth="lg">
        <DialogTitle>Edit folder access</DialogTitle>
        <Stack component="form" onSubmit={saveEdit}>
          <DialogContent>
            <Stack spacing={2}>
              <GrantFields form={editForm} change={(values) => setEditForm((current) => ({ ...current, ...values }))} users={users} groups={groups} servers={servers} />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}>
            <Button
              variant="contained"
              type="submit"
              startIcon={saving ? <BusyIcon /> : undefined}
              disabled={saving || !editForm.principalId || !editForm.serverId || editForm.permissions.length === 0}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
            <Button type="button" onClick={closeEdit} disabled={saving}>Cancel</Button>
          </DialogActions>
          {editError && <Alert severity="error" sx={{ mx: 3, mb: 2 }}>{editError}</Alert>}
        </Stack>
      </Dialog>
    </Stack>
  );
}

function GroupFields({ form, change, users }: { form: GroupForm; change: (values: Partial<GroupForm>) => void; users: User[] }) {
  const selectedUsers = users.filter((user) => form.memberIds.includes(user.id));
  return (
    <>
      <TextField label="Group name" value={form.name} onChange={(event) => change({ name: event.target.value })} required />
      <TextField label="Description" value={form.description} onChange={(event) => change({ description: event.target.value })} multiline minRows={2} />
      <Autocomplete
        multiple
        disableCloseOnSelect
        filterSelectedOptions
        limitTags={3}
        options={users}
        value={selectedUsers}
        getOptionLabel={(user) => `${user.displayName} (${user.email})`}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        onChange={(_, selected) => change({ memberIds: selected.map((user) => user.id) })}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Members"
            placeholder={selectedUsers.length ? "Search for another user" : "Search users by name or email"}
            helperText={`${selectedUsers.length} member${selectedUsers.length === 1 ? "" : "s"} selected`}
          />
        )}
      />
    </>
  );
}

function GroupsPanel({ groups, users, done, fail }: { groups: Group[]; users: User[]; done: Done; fail: Fail }) {
  const blankGroup = (): GroupForm => ({ name: "", description: "", memberIds: [] });
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<GroupForm>(blankGroup);
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  const [editForm, setEditForm] = useState<GroupForm>(blankGroup);
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState("");
  const [viewing, setViewing] = useState<Group | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberError, setMemberError] = useState("");
  const [removingMemberId, setRemovingMemberId] = useState("");

  function openCreate() {
    setCreateForm(blankGroup());
    setCreateError("");
    setCreateOpen(true);
    fail("");
  }

  function closeCreate() {
    if (creating) return;
    setCreateOpen(false);
    setCreateForm(blankGroup());
    setCreateError("");
  }

  function openEdit(group: Group) {
    setEditing(group);
    setEditForm({ name: group.name, description: group.description, memberIds: [...group.memberIds] });
    setEditError("");
    fail("");
  }

  function closeEdit() {
    if (saving) return;
    setEditing(null);
    setEditError("");
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setCreateError("");
    setCreating(true);
    try {
      await api("/groups", { method: "POST", body: JSON.stringify(createForm) });
      setCreating(false);
      setCreateOpen(false);
      setCreateForm(blankGroup());
      await done("Group created");
    } catch (reason) {
      setCreateError(errorMessage(reason, "Unable to create group"));
      setCreating(false);
    }
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setEditError("");
    setSaving(true);
    try {
      await api(`/groups/${editing.id}`, { method: "PATCH", body: JSON.stringify(editForm) });
      setSaving(false);
      setEditing(null);
      await done("Group updated");
    } catch (reason) {
      setEditError(errorMessage(reason, "Unable to update group"));
      setSaving(false);
    }
  }

  async function remove(group: Group) {
    if (!window.confirm(`Remove group ${group.name}, its grants, task schedules, and generated work items?`)) return;
    setRemovingId(group.id);
    try {
      await api(`/groups/${group.id}`, { method: "DELETE" });
      await done("Group removed");
    } catch (reason) {
      fail(errorMessage(reason, "Unable to remove group"));
    } finally {
      setRemovingId("");
    }
  }

  function openMembers(group: Group) {
    setViewing(group);
    setMemberSearch("");
    setMemberError("");
    fail("");
  }

  function closeMembers() {
    if (removingMemberId) return;
    setViewing(null);
    setMemberError("");
    setMemberSearch("");
  }

  async function removeMember(userId: string) {
    if (!viewing) return;
    setMemberError("");
    setRemovingMemberId(userId);
    const updatedMembers = viewing.memberIds.filter((memberId) => memberId !== userId);
    try {
      const updated = await api<Group>(`/groups/${viewing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: viewing.name, description: viewing.description, memberIds: updatedMembers }),
      });
      setViewing(updated);
      await done("Group member removed");
    } catch (reason) {
      setMemberError(errorMessage(reason, "Unable to remove group member"));
    } finally {
      setRemovingMemberId("");
    }
  }

  const visibleMembers = users.filter((user) => viewing?.memberIds.includes(user.id))
    .filter((user) => `${user.displayName} ${user.email}`.toLowerCase().includes(memberSearch.trim().toLowerCase()));

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} justifyContent="space-between">
        <Box>
          <Typography variant="h6">Groups</Typography>
          <Typography color="text.secondary">Organize searchable user selections into reusable access groups.</Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate} aria-expanded={createOpen}>Create group</Button>
      </Stack>

      {groups.length === 0 && <Alert severity="info">No groups have been created yet.</Alert>}

      {groups.map((group) => (
        <Card key={group.id}>
          <CardContent>
            <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} spacing={2}>
              <Box flex={1}>
                <Typography variant="h6">{group.name}</Typography>
                <Typography color="text.secondary">{group.description || "No description"}</Typography>
                <Typography variant="body2" color="text.secondary">{group.memberIds.length} member{group.memberIds.length === 1 ? "" : "s"}</Typography>
              </Box>
              <Tooltip title="View group members">
                <IconButton aria-label={`View ${group.name} members`} onClick={() => openMembers(group)}><VisibilityIcon /></IconButton>
              </Tooltip>
              <Button startIcon={<EditIcon />} aria-label={`Edit ${group.name}`} onClick={() => openEdit(group)}>Edit</Button>
              <Button color="error" startIcon={removingId === group.id ? <BusyIcon /> : <DeleteIcon />} disabled={Boolean(removingId)} onClick={() => remove(group)}>Remove</Button>
            </Stack>
          </CardContent>
        </Card>
      ))}

      <Dialog open={createOpen} onClose={closeCreate} fullWidth maxWidth="md">
        <DialogTitle>Create group</DialogTitle>
        <Stack component="form" onSubmit={create}>
          <DialogContent>
            <Stack spacing={2}>
              <GroupFields form={createForm} change={(values) => setCreateForm((current) => ({ ...current, ...values }))} users={users} />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}>
            <Button type="submit" variant="contained" startIcon={creating ? <BusyIcon /> : undefined} disabled={creating || !createForm.name.trim()}>
              {creating ? "Creating…" : "Create group"}
            </Button>
            <Button type="button" onClick={closeCreate} disabled={creating}>Cancel</Button>
          </DialogActions>
          {createError && <Alert severity="error" sx={{ mx: 3, mb: 2 }}>{createError}</Alert>}
        </Stack>
      </Dialog>

      <Dialog open={Boolean(editing)} onClose={closeEdit} fullWidth maxWidth="md">
        <DialogTitle>Edit group</DialogTitle>
        <Stack component="form" onSubmit={saveEdit}>
          <DialogContent>
            <Stack spacing={2}>
              <GroupFields form={editForm} change={(values) => setEditForm((current) => ({ ...current, ...values }))} users={users} />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}>
            <Button type="submit" variant="contained" startIcon={saving ? <BusyIcon /> : undefined} disabled={saving || !editForm.name.trim()}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
            <Button type="button" onClick={closeEdit} disabled={saving}>Cancel</Button>
          </DialogActions>
          {editError && <Alert severity="error" sx={{ mx: 3, mb: 2 }}>{editError}</Alert>}
        </Stack>
      </Dialog>

      <Dialog open={Boolean(viewing)} onClose={closeMembers} fullWidth maxWidth="sm">
        <DialogTitle>{viewing?.name} members</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <TextField label="Search members" value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} />
            {viewing?.memberIds.length === 0 && <Alert severity="info">This group has no members.</Alert>}
            {viewing && viewing.memberIds.length > 0 && visibleMembers.length === 0 && <Alert severity="info">No members match this search.</Alert>}
            {visibleMembers.map((user) => (
              <Card key={user.id} variant="outlined">
                <CardContent sx={{ py: 1.25, "&:last-child": { pb: 1.25 } }}>
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Box flex={1}><Typography fontWeight={700}>{user.displayName}</Typography><Typography variant="body2" color="text.secondary">{user.email}</Typography></Box>
                    <Tooltip title="Remove member"><IconButton color="error" aria-label={`Remove ${user.email} from ${viewing?.name || "group"}`} disabled={Boolean(removingMemberId)} onClick={() => removeMember(user.id)}>{removingMemberId === user.id ? <BusyIcon /> : <DeleteIcon />}</IconButton></Tooltip>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}><Button onClick={closeMembers} disabled={Boolean(removingMemberId)}>Close</Button></DialogActions>
        {memberError && <Alert severity="error" variant="filled" sx={{ mx: 3, mb: 2 }}>{memberError}</Alert>}
      </Dialog>
    </Stack>
  );
}
