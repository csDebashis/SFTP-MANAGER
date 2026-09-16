"use client";

import { Alert, Button, Link, Stack, TextField, Typography } from "@mui/material";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { api } from "@/api/client";
import PublicShell from "@/components/PublicShell";
import type { User } from "@/types";

type LoginFormProps = {
  showDemoCredentials: boolean;
};

export default function LoginForm({ showDemoCredentials }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      router.replace(result.user.state === "ACTIVE" ? "/dashboard" : "/pending");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicShell title="Welcome back" subtitle="Sign in to manage your authorized SFTP locations.">
      <Stack component="form" spacing={2} onSubmit={submit}>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoFocus
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <Button type="submit" variant="contained" size="large" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <Typography variant="body2" textAlign="center">
          Need an account? <Link component={NextLink} href="/signup">Request access</Link>
        </Typography>
        {showDemoCredentials && (
          <Alert severity="info" aria-label="Demo login credentials">
            <strong>Demo administrator:</strong> admin@example.com / Admin123!Secure
            <br />
            <strong>Demo user:</strong> user@example.com / User123!Secure
          </Alert>
        )}
      </Stack>
    </PublicShell>
  );
}
