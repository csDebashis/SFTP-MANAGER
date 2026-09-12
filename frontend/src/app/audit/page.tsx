"use client";

import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import AppShell from "@/components/AppShell";
import type { AuditEvent } from "@/types";

function stringDetail(event: AuditEvent, key: string): string {
  const value = event.detail[key];
  return typeof value === "string" ? value : "";
}

function permissionDetail(event: AuditEvent): string {
  const value = event.detail.permissions;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join(", ") : "";
}

function resourceSummary(event: AuditEvent): string {
  const principal = stringDetail(event, "principalName");
  if (principal) {
    const principalType = stringDetail(event, "principalType").toLowerCase();
    const permissions = permissionDetail(event);
    return `${principalType === "group" ? "Group" : "User"}: ${principal}${permissions ? ` · ${permissions}` : ""}`;
  }
  if (event.itemName) return `${event.resourceType === "file" ? "File" : "Item"}: ${event.itemName}`;
  return `${event.resourceType.replaceAll("_", " ")}${event.resourceId ? ` · ${event.resourceId}` : ""}`;
}

function RequestDetails({ event }: { event: AuditEvent }) {
  return (
    <Tooltip
      arrow
      placement="left"
      title={(
        <Stack spacing={0.5} sx={{ maxWidth: 420, p: 0.5 }}>
          <Typography variant="caption"><strong>Request ID:</strong> {event.requestId}</Typography>
          {event.resourceId && <Typography variant="caption"><strong>Resource ID:</strong> {event.resourceId}</Typography>}
          {event.sourceIp && <Typography variant="caption"><strong>Source IP:</strong> {event.sourceIp}</Typography>}
          {event.clientDetails && <Typography variant="caption"><strong>Client:</strong> {event.clientDetails}</Typography>}
        </Stack>
      )}
    >
      <IconButton size="small" aria-label={`Request details for ${event.action.replaceAll("_", " ")}`}>
        <InfoOutlinedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ items: AuditEvent[] }>("/audit-events?limit=200")
      .then((value) => setEvents(value.items))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load audit events"));
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!events || !normalized) return events || [];
    return events.filter((event) => [
      event.action,
      event.actorDisplay,
      event.serverName,
      event.path,
      event.itemName,
      stringDetail(event, "principalName"),
      permissionDetail(event),
    ].some((value) => value?.toLowerCase().includes(normalized)));
  }, [events, query]);

  return (
    <AppShell title="Audit activity">
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="h4">Audit activity</Typography>
          <Typography color="text.secondary">Review who performed each action, the affected resource, server, folder, and time.</Typography>
        </Box>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField label="Filter by action, user, server, file, folder, or access subject" value={query} onChange={(event) => setQuery(event.target.value)} />
        {events === null ? <CircularProgress /> : (
          <Stack spacing={1.5}>
            {filtered.length === 0 && <Alert severity="info">No matching events.</Alert>}
            {filtered.map((event) => (
              <Card key={event.id}>
                <CardContent>
                  <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ md: "center" }}>
                    <Box flex={1} minWidth={0}>
                      <Typography fontWeight={750}>{event.action.replaceAll("_", " ")}</Typography>
                      <Typography variant="body2">Performed by {event.actorDisplay}</Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                        {resourceSummary(event)}
                      </Typography>
                      {(event.serverName || event.serverId || event.folderPath) && (
                        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                          Server: {event.serverName || event.serverId || "Unknown"}{event.folderPath ? ` · Folder: ${event.folderPath}` : ""}
                        </Typography>
                      )}
                    </Box>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                      <Chip label={event.outcome} size="small" color={event.outcome === "SUCCESS" ? "success" : event.outcome === "DENIED" ? "warning" : "error"} />
                      <Typography variant="caption" color="text.secondary">{new Date(event.timestamp).toLocaleString()}</Typography>
                      <RequestDetails event={event} />
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        )}
      </Stack>
    </AppShell>
  );
}
