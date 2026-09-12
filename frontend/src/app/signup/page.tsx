"use client";

import { Alert, Button, Link, Stack, TextField, Typography } from "@mui/material";
import NextLink from "next/link";
import { FormEvent, useState } from "react";
import { api } from "@/api/client";
import PublicShell from "@/components/PublicShell";

export default function SignupPage() {
  const [form, setForm] = useState({ displayName: "", email: "", password: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    try { const result = await api<{ message: string }>("/auth/signup", { method: "POST", body: JSON.stringify(form) }); setMessage(result.message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to submit request"); }
  }
  return <PublicShell title="Request access" subtitle="An administrator must approve your account before you can use SFTP locations."><Stack component="form" spacing={2} onSubmit={submit}>{message && <Alert severity="success">{message}</Alert>}{error && <Alert severity="error">{error}</Alert>}<TextField label="Display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required autoFocus /><TextField label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /><TextField label="Password" type="password" helperText="At least 12 characters" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required inputProps={{ minLength: 12 }} /><Button type="submit" variant="contained" size="large">Submit request</Button><Typography variant="body2" textAlign="center"><Link component={NextLink} href="/login">Back to sign in</Link></Typography></Stack></PublicShell>;
}
