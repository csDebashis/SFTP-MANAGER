"use client";

import LockResetIcon from "@mui/icons-material/LockReset";
import ManageAccountsIcon from "@mui/icons-material/ManageAccounts";
import { Alert, Box, Button, Card, CardContent, CircularProgress, Snackbar, Stack, TextField, Typography } from "@mui/material";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/api/client";
import AppShell from "@/components/AppShell";
import type { User } from "@/types";

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [profileForm, setProfileForm] = useState({ displayName: "", email: "" });
  const [profileError, setProfileError] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");

  useEffect(() => {
    api<{ user: User }>("/auth/me")
      .then(({ user: currentUser }) => {
        setUser(currentUser);
        setProfileForm({ displayName: currentUser.displayName, email: currentUser.email });
      })
      .catch((reason) => setProfileError(reason instanceof Error ? reason.message : "Unable to load profile"));
  }, []);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!user) return;
    setProfileError("");
    setSavingProfile(true);
    try {
      const updated = await api<User>(`/users/${user.id}`, { method: "PATCH", body: JSON.stringify(profileForm) });
      setUser(updated);
      setProfileForm({ displayName: updated.displayName, email: updated.email });
      setProfileMessage("Profile updated");
    } catch (reason) {
      setProfileError(reason instanceof Error ? reason.message : "Unable to update profile");
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match");
      return;
    }
    setPasswordError("");
    try {
      await api("/auth/password/change", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      router.replace("/login?passwordChanged=true");
    } catch (reason) {
      setPasswordError(reason instanceof Error ? reason.message : "Unable to change password");
    }
  }

  return (
    <AppShell title="Profile">
      <Stack spacing={2.5} maxWidth={640}>
        <Box>
          <Typography variant="h4">Profile & security</Typography>
          <Typography color="text.secondary">Manage your portal identity and credentials.</Typography>
        </Box>
        <Card>
          <CardContent>
            <Stack component="form" spacing={2} onSubmit={saveProfile}>
              <Stack direction="row" spacing={1} alignItems="center">
                <ManageAccountsIcon color="primary" />
                <Typography variant="h6">Account details</Typography>
              </Stack>
              {!user && !profileError ? <CircularProgress size={24} aria-label="Loading profile" /> : (
                <>
                  <Typography variant="body2" color="text.secondary">User ID: {user?.id}</Typography>
                  <TextField label="Username / display name" value={profileForm.displayName} onChange={(event) => setProfileForm({ ...profileForm, displayName: event.target.value })} required />
                  <TextField label="Email" type="email" autoComplete="email" value={profileForm.email} onChange={(event) => setProfileForm({ ...profileForm, email: event.target.value })} required />
                  <Button variant="contained" type="submit" disabled={savingProfile || !profileForm.displayName.trim() || !profileForm.email.trim()} sx={{ alignSelf: "flex-start" }} startIcon={savingProfile ? <CircularProgress size={18} color="inherit" /> : undefined}>
                    {savingProfile ? "Saving…" : "Save profile"}
                  </Button>
                </>
              )}
              {profileError && <Alert severity="error" onClose={() => setProfileError("")}>{profileError}</Alert>}
            </Stack>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Stack component="form" spacing={2} onSubmit={changePassword}>
              <Stack direction="row" spacing={1} alignItems="center"><LockResetIcon color="primary" /><Typography variant="h6">Change password</Typography></Stack>
              <TextField label="Current password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
              <TextField label="New password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} helperText="At least 12 characters" inputProps={{ minLength: 12 }} required />
              <TextField label="Confirm new password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
              <Button variant="contained" type="submit" sx={{ alignSelf: "flex-start" }}>Change password</Button>
              {passwordError && <Alert severity="error" onClose={() => setPasswordError("")}>{passwordError}</Alert>}
            </Stack>
          </CardContent>
        </Card>
        <Snackbar open={Boolean(profileMessage)} autoHideDuration={2000} onClose={() => setProfileMessage("")} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
          <Alert severity="success" variant="filled" onClose={() => setProfileMessage("")} sx={{ width: "100%" }}>{profileMessage}</Alert>
        </Snackbar>
      </Stack>
    </AppShell>
  );
}
