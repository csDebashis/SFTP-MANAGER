"use client";

import EditIcon from "@mui/icons-material/Edit";
import LockResetIcon from "@mui/icons-material/LockReset";
import ManageAccountsIcon from "@mui/icons-material/ManageAccounts";
import SecurityIcon from "@mui/icons-material/Security";
import {
  Alert, Box, Button, Card, CardContent, CircularProgress, Dialog,
  DialogActions, DialogContent, DialogTitle, Snackbar, Stack, TextField, Typography,
} from "@mui/material";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/api/client";
import AppShell from "@/components/AppShell";
import type { User } from "@/types";

function message(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loadError, setLoadError] = useState("");
  const [success, setSuccess] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileForm, setProfileForm] = useState({ displayName: "", email: "" });
  const [profileError, setProfileError] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    api<{ user: User }>("/auth/me")
      .then(({ user: currentUser }) => setUser(currentUser))
      .catch((reason) => setLoadError(message(reason, "Unable to load profile")));
  }, []);

  function showSuccess(text: string) {
    setSuccess(text);
    window.setTimeout(() => setSuccess(""), 2000);
  }

  function openProfile() {
    if (!user) return;
    setProfileForm({ displayName: user.displayName, email: user.email });
    setProfileError(""); setLoadError(""); setProfileOpen(true);
  }

  function closeProfile() {
    if (savingProfile) return;
    setProfileOpen(false); setProfileError("");
  }

  function openPassword() {
    setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
    setPasswordError(""); setLoadError(""); setPasswordOpen(true);
  }

  function closePassword() {
    if (savingPassword) return;
    setPasswordOpen(false); setPasswordError("");
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!user) return;
    setProfileError(""); setSavingProfile(true);
    try {
      const updated = await api<User>(`/users/${user.id}`, { method: "PATCH", body: JSON.stringify(profileForm) });
      setUser(updated); setProfileOpen(false); showSuccess("Profile updated");
    } catch (reason) {
      setProfileError(message(reason, "Unable to update profile"));
    } finally { setSavingProfile(false); }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) { setPasswordError("New passwords do not match"); return; }
    setPasswordError(""); setSavingPassword(true);
    try {
      await api("/auth/password/change", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      setPasswordOpen(false); showSuccess("Password changed. Sign in again.");
      window.setTimeout(() => router.replace("/login?passwordChanged=true"), 2000);
    } catch (reason) {
      setPasswordError(message(reason, "Unable to change password"));
    } finally { setSavingPassword(false); }
  }

  return (
    <AppShell title="Profile">
      <Stack spacing={2.5} maxWidth={760}>
        <Box><Typography variant="h4">Profile & security</Typography><Typography color="text.secondary">Manage your portal identity and credentials.</Typography></Box>
        {loadError && <Alert severity="error" variant="filled" onClose={() => setLoadError("")}>{loadError}</Alert>}
        {!user && !loadError ? <CircularProgress aria-label="Loading profile" /> : user && (
          <>
            <Card><CardContent><Stack spacing={2}>
              <Stack direction="row" spacing={1} alignItems="center"><ManageAccountsIcon color="primary" /><Typography variant="h6">Account details</Typography></Stack>
              <Box><Typography variant="caption" color="text.secondary">Display name</Typography><Typography>{user.displayName}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">Email</Typography><Typography>{user.email}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">User ID</Typography><Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{user.id}</Typography></Box>
              <Button variant="contained" startIcon={<EditIcon />} onClick={openProfile} sx={{ alignSelf: "flex-start" }}>Edit account details</Button>
            </Stack></CardContent></Card>
            <Card><CardContent><Stack spacing={2}>
              <Stack direction="row" spacing={1} alignItems="center"><SecurityIcon color="primary" /><Typography variant="h6">Security</Typography></Stack>
              <Typography color="text.secondary">Change your password from a protected dialog. All active sessions are revoked after a successful change.</Typography>
              <Button variant="contained" startIcon={<LockResetIcon />} onClick={openPassword} sx={{ alignSelf: "flex-start" }}>Change password</Button>
            </Stack></CardContent></Card>
          </>
        )}
      </Stack>

      <Dialog open={profileOpen} onClose={closeProfile} fullWidth maxWidth="sm">
        <DialogTitle>Edit account details</DialogTitle>
        <Stack component="form" onSubmit={saveProfile}>
          <DialogContent><Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">User ID: {user?.id}</Typography>
            <TextField autoFocus label="Username / display name" value={profileForm.displayName} onChange={(event) => setProfileForm({ ...profileForm, displayName: event.target.value })} required />
            <TextField label="Email" type="email" autoComplete="email" value={profileForm.email} onChange={(event) => setProfileForm({ ...profileForm, email: event.target.value })} required />
          </Stack></DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}><Button variant="contained" type="submit" disabled={savingProfile || !profileForm.displayName.trim() || !profileForm.email.trim()} startIcon={savingProfile ? <CircularProgress size={18} color="inherit" /> : undefined}>{savingProfile ? "Saving…" : "Save changes"}</Button><Button type="button" onClick={closeProfile} disabled={savingProfile}>Cancel</Button></DialogActions>
          {profileError && <Alert severity="error" variant="filled" sx={{ mx: 3, mb: 2 }}>{profileError}</Alert>}
        </Stack>
      </Dialog>

      <Dialog open={passwordOpen} onClose={closePassword} fullWidth maxWidth="sm">
        <DialogTitle>Change password</DialogTitle>
        <Stack component="form" onSubmit={changePassword}>
          <DialogContent><Stack spacing={2}>
            <TextField autoFocus label="Current password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
            <TextField label="New password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} helperText="At least 12 characters" inputProps={{ minLength: 12 }} required />
            <TextField label="Confirm new password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
          </Stack></DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3 }}><Button variant="contained" type="submit" disabled={savingPassword} startIcon={savingPassword ? <CircularProgress size={18} color="inherit" /> : <LockResetIcon />}>{savingPassword ? "Changing…" : "Change password"}</Button><Button type="button" onClick={closePassword} disabled={savingPassword}>Cancel</Button></DialogActions>
          {passwordError && <Alert severity="error" variant="filled" sx={{ mx: 3, mb: 2 }}>{passwordError}</Alert>}
        </Stack>
      </Dialog>

      <Snackbar open={Boolean(success)} autoHideDuration={2000} onClose={() => setSuccess("")} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}><Alert severity="success" variant="filled" onClose={() => setSuccess("")}>{success}</Alert></Snackbar>
    </AppShell>
  );
}
