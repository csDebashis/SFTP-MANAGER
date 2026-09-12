"use client";

import AdminPanelSettingsIcon from "@mui/icons-material/AdminPanelSettings";
import AssignmentIcon from "@mui/icons-material/Assignment";
import DashboardIcon from "@mui/icons-material/Dashboard";
import FolderIcon from "@mui/icons-material/Folder";
import HistoryIcon from "@mui/icons-material/History";
import LogoutIcon from "@mui/icons-material/Logout";
import MenuIcon from "@mui/icons-material/Menu";
import PersonIcon from "@mui/icons-material/Person";
import { Alert, AppBar, Avatar, Box, CircularProgress, Divider, Drawer, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Stack, Toolbar, Typography } from "@mui/material";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { api, ApiError } from "@/api/client";
import type { User } from "@/types";

const drawerWidth = 248;

export default function AppShell({ children, title, requiredRole }: { children: ReactNode; title: string; requiredRole?: User["role"] }) {
  const [user, setUser] = useState<User | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    api<{ user: User }>("/auth/me").then((value) => {
      if (value.user.state !== "ACTIVE") router.replace("/pending");
      else setUser(value.user);
    }).catch((error) => { if (error instanceof ApiError && error.status === 401) router.replace("/login"); });
  }, [router]);

  if (!user) return <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center" }}><CircularProgress aria-label="Loading account" /></Box>;

  const links = [
    { href: "/dashboard", label: "Home", icon: <DashboardIcon /> },
    { href: "/files", label: "Files", icon: <FolderIcon /> },
    { href: "/tasks", label: "Tasks", icon: <AssignmentIcon /> },
    { href: "/audit", label: user.role === "ADMIN" || user.role === "AUDITOR" ? "Audit" : "My activity", icon: <HistoryIcon /> },
    { href: "/profile", label: "Profile", icon: <PersonIcon /> },
    ...(user.role === "ADMIN" ? [{ href: "/admin", label: "Admin", icon: <AdminPanelSettingsIcon /> }] : []),
  ];
  const drawer = (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Toolbar><Typography variant="h6" fontWeight={800} color="primary">SFTP Manager</Typography></Toolbar><Divider />
      <List sx={{ px: 1 }}>{links.map((link) => <ListItemButton key={link.href} selected={pathname === link.href} onClick={() => { router.push(link.href); setMobileOpen(false); }} sx={{ borderRadius: 2, mb: .5 }}><ListItemIcon>{link.icon}</ListItemIcon><ListItemText primary={link.label} /></ListItemButton>)}</List>
      <Box sx={{ mt: "auto", p: 2 }}><Divider sx={{ mb: 2 }} /><Stack direction="row" spacing={1.5} alignItems="center"><Avatar>{user.displayName[0]}</Avatar><Box minWidth={0} flex={1}><Typography variant="body2" fontWeight={700} noWrap>{user.displayName}</Typography><Typography variant="caption" color="text.secondary">{user.role}</Typography></Box><IconButton aria-label="Sign out" onClick={async () => { await api("/auth/logout", { method: "POST" }); router.replace("/login"); }}><LogoutIcon /></IconButton></Stack></Box>
    </Box>
  );
  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar position="fixed" color="inherit" elevation={0} sx={{ borderBottom: "1px solid", borderColor: "divider", zIndex: (theme) => theme.zIndex.drawer + 1 }}><Toolbar><IconButton sx={{ display: { md: "none" }, mr: 1 }} onClick={() => setMobileOpen(true)} aria-label="Open navigation"><MenuIcon /></IconButton><Typography variant="h6" fontWeight={750}>{title}</Typography></Toolbar></AppBar>
      <Drawer variant="permanent" sx={{ width: drawerWidth, display: { xs: "none", md: "block" }, "& .MuiDrawer-paper": { width: drawerWidth } }}>{drawer}</Drawer>
      <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} sx={{ display: { md: "none" }, "& .MuiDrawer-paper": { width: drawerWidth } }}>{drawer}</Drawer>
      <Box component="main" sx={{ flex: 1, minWidth: 0, p: { xs: 2, sm: 3 }, pt: { xs: 11, sm: 12 }, ml: { md: 0 } }}>
        {requiredRole && user.role !== requiredRole
          ? <Alert severity="error">You do not have permission to open this page.</Alert>
          : children}
      </Box>
    </Box>
  );
}
