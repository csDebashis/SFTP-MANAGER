import FolderSharedIcon from "@mui/icons-material/FolderShared";
import { Box, Container, Paper, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

export default function PublicShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 2, background: "linear-gradient(135deg,#eef4ff,#f4fbf8)" }}>
      <Container maxWidth="sm">
        <Paper elevation={0} sx={{ p: { xs: 3, sm: 5 }, border: "1px solid", borderColor: "divider", borderRadius: 4 }}>
          <Stack spacing={3}>
            <Stack direction="row" spacing={1.5} alignItems="center"><FolderSharedIcon color="primary" fontSize="large" /><Typography variant="h5">SFTP Manager</Typography></Stack>
            <Box><Typography variant="h4" gutterBottom>{title}</Typography><Typography color="text.secondary">{subtitle}</Typography></Box>
            {children}
          </Stack>
        </Paper>
      </Container>
    </Box>
  );
}
