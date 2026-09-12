"use client";

import { Alert, Button, Stack } from "@mui/material";
import { useRouter } from "next/navigation";
import { api } from "@/api/client";
import PublicShell from "@/components/PublicShell";

export default function PendingPage() {
  const router = useRouter();
  return <PublicShell title="Approval pending" subtitle="Your access request has been received."><Stack spacing={2}><Alert severity="info">An administrator must approve your account and assign folder access. Return later and sign in again.</Alert><Button variant="outlined" onClick={async () => { try { await api("/auth/logout", { method: "POST" }); } finally { router.replace("/login"); } }}>Sign out</Button></Stack></PublicShell>;
}
