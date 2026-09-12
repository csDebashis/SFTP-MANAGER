"use client";

import CreateNewFolderIcon from "@mui/icons-material/CreateNewFolder";
import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import DriveFileMoveIcon from "@mui/icons-material/DriveFileMove";
import EditIcon from "@mui/icons-material/Edit";
import FolderIcon from "@mui/icons-material/Folder";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";
import UploadIcon from "@mui/icons-material/Upload";
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  Link,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useSearchParams } from "next/navigation";
import { Suspense, type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, formatBytes } from "@/api/client";
import AppShell from "@/components/AppShell";
import { uploadDestinationKey, useUploads } from "@/components/UploadManager";
import type { FileItem, Root } from "@/types";

type Listing = { path: string; permissions: string[]; items: FileItem[] };

export default function FilesPage() {
  return (
    <Suspense fallback={<AppShell title="Files"><CircularProgress /></AppShell>}>
      <FileExplorer />
    </Suspense>
  );
}

function FileExplorer() {
  const params = useSearchParams();
  const { enqueueUploads, completedByDestination } = useUploads();
  const [roots, setRoots] = useState<Root[]>([]);
  const [serverId, setServerId] = useState(params.get("serverId") || "");
  const [path, setPath] = useState(params.get("path") || "/");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [folderDialog, setFolderDialog] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const currentRoot = useMemo(
    () => roots
      .filter((root) => root.serverId === serverId && (path === root.path || root.path === "/" || path.startsWith(`${root.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0],
    [roots, serverId, path],
  );

  async function loadRoots() {
    try {
      const value = await api<{ items: Root[] }>("/files/roots");
      setRoots(value.items);
      if (!serverId && value.items[0]) {
        setServerId(value.items[0].serverId);
        setPath(value.items[0].path);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load folders");
    }
  }

  async function loadListing() {
    if (!serverId) return;
    setListing(null);
    setError("");
    try {
      setListing(await api<Listing>(`/files/list?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(path)}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load folder");
    }
  }

  useEffect(() => { void loadRoots(); }, []);
  const uploadCompletionVersion = completedByDestination[uploadDestinationKey(serverId, path)] || 0;
  useEffect(() => { void loadListing(); }, [serverId, path, uploadCompletionVersion]);

  const can = (permission: string) => Boolean(listing?.permissions.includes(permission));
  const crumbs = path.split("/").filter(Boolean);
  const openPath = (next: string) => {
    setPath(next);
    window.history.replaceState(null, "", `/files?serverId=${serverId}&path=${encodeURIComponent(next)}`);
  };

  function selectFiles(files: File[]) {
    if (!files.length || !serverId) return;
    enqueueUploads(files, { serverId, serverName: currentRoot?.serverName || "SFTP server", path });
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (!can("UPLOAD")) return;
    selectFiles(Array.from(event.dataTransfer.files));
  }

  async function createFolder() {
    try {
      await api("/files/folders", { method: "POST", body: JSON.stringify({ serverId, parent: path, name: folderName }) });
      setFolderDialog(false);
      setFolderName("");
      setMessage("Folder created");
      await loadListing();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to create folder");
    }
  }

  async function rename(item: FileItem) {
    const name = window.prompt("New name", item.name);
    if (!name || name === item.name) return;
    try {
      await api("/files/rename", { method: "POST", body: JSON.stringify({ serverId, path: item.path, name }) });
      setMessage("Item renamed");
      await loadListing();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Rename failed");
    }
  }

  async function move(item: FileItem) {
    const destination = window.prompt("Destination absolute path", item.path);
    if (!destination || destination === item.path) return;
    try {
      await api("/files/move", { method: "POST", body: JSON.stringify({ serverId, source: item.path, destination }) });
      setMessage("Item moved");
      await loadListing();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Move failed");
    }
  }

  async function remove(item: FileItem) {
    if (!window.confirm(`Delete ${item.name}?${item.type === "folder" ? " The folder must be empty." : ""}`)) return;
    try {
      await api(`/files/item?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(item.path)}`, { method: "DELETE" });
      setMessage("Item deleted");
      await loadListing();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Delete failed");
    }
  }

  return (
    <AppShell title="Files">
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="h4">SFTP files</Typography>
          <Typography color="text.secondary">Browse and manage only the locations assigned to you.</Typography>
        </Box>

        {error && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}
        {roots.length === 0 ? <Alert severity="info">No SFTP folders are assigned to this account.</Alert> : (
          <>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }}>
              <FormControl sx={{ minWidth: 260 }}>
                <InputLabel>Access root</InputLabel>
                <Select
                  label="Access root"
                  value={`${serverId}|${currentRoot?.path || path}`}
                  onChange={(event) => {
                    const [nextServer, ...parts] = String(event.target.value).split("|");
                    setServerId(nextServer);
                    setPath(parts.join("|"));
                  }}
                >
                  {roots.map((root) => <MenuItem value={`${root.serverId}|${root.path}`} key={`${root.serverId}:${root.path}`}>{root.serverName} — {root.path}</MenuItem>)}
                </Select>
              </FormControl>
              <Box flex={1} />
              <Button variant="outlined" startIcon={<CreateNewFolderIcon />} disabled={!can("CREATE_FOLDER")} onClick={() => setFolderDialog(true)}>New folder</Button>
              <Button variant="contained" startIcon={<UploadIcon />} disabled={!can("UPLOAD")} onClick={() => fileInput.current?.click()}>Upload files</Button>
              <input
                ref={fileInput}
                hidden
                type="file"
                multiple
                onChange={(event) => {
                  const selected = Array.from(event.target.files || []);
                  event.target.value = "";
                  selectFiles(selected);
                }}
              />
            </Stack>

            <Card
              data-testid="upload-drop-zone"
              aria-label={can("UPLOAD") ? "Folder contents and upload drop zone" : "Folder contents"}
              onDragEnter={(event) => {
                if (!can("UPLOAD")) return;
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => {
                if (!can("UPLOAD")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
              }}
              onDrop={handleDrop}
              sx={{
                outline: dragActive ? "3px dashed" : "none",
                outlineColor: "primary.main",
                outlineOffset: dragActive ? 2 : 0,
                bgcolor: dragActive ? "action.hover" : "background.paper",
                transition: "outline-color 150ms ease, background-color 150ms ease",
              }}
            >
              <CardContent>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} sx={{ mb: 2 }}>
                  <Breadcrumbs aria-label="Folder path" sx={{ flex: 1 }}>
                    <Link component="button" underline="hover" onClick={() => currentRoot && openPath(currentRoot.path)}>{currentRoot?.serverName || "Root"}</Link>
                    {crumbs.map((crumb, index) => {
                      const target = `/${crumbs.slice(0, index + 1).join("/")}`;
                      const allowed = !currentRoot || currentRoot.path === "/" || target.length >= currentRoot.path.length;
                      return allowed && <Link component="button" underline="hover" key={target} onClick={() => openPath(target)}>{crumb}</Link>;
                    })}
                  </Breadcrumbs>
                  {can("UPLOAD") && (
                    <Stack direction="row" spacing={0.75} alignItems="center" color={dragActive ? "primary.main" : "text.secondary"}>
                      <UploadIcon fontSize="small" />
                      <Typography variant="body2" fontWeight={dragActive ? 700 : 500}>
                        {dragActive ? `Drop to upload into ${path}` : "Drag and drop files into this folder"}
                      </Typography>
                    </Stack>
                  )}
                </Stack>
                {!listing ? <CircularProgress /> : (
                  <TableContainer>
                    <Table aria-label="SFTP directory">
                      <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Size</TableCell><TableCell>Modified</TableCell><TableCell align="right">Actions</TableCell></TableRow></TableHead>
                      <TableBody>
                        {listing.items.length === 0 && <TableRow><TableCell colSpan={4}><Typography color="text.secondary" textAlign="center" py={4}>This folder is empty.</Typography></TableCell></TableRow>}
                        {listing.items.map((item) => (
                          <TableRow key={item.path} hover>
                            <TableCell><Button color="inherit" startIcon={item.type === "folder" ? <FolderIcon color="primary" /> : <InsertDriveFileIcon color="action" />} onClick={() => item.type === "folder" && openPath(item.path)} sx={{ fontWeight: 650 }}>{item.name}</Button></TableCell>
                            <TableCell>{item.type === "file" ? formatBytes(item.size) : "—"}</TableCell>
                            <TableCell>{new Date(item.modifiedAt * 1000).toLocaleString()}</TableCell>
                            <TableCell align="right">
                              <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
                                {item.type === "file" && can("DOWNLOAD") && <Tooltip title="Download"><IconButton aria-label={`Download ${item.name}`} component="a" href={`/api/v1/files/download?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(item.path)}`}><DownloadIcon /></IconButton></Tooltip>}
                                {can("RENAME") && <Tooltip title="Rename"><IconButton aria-label={`Rename ${item.name}`} onClick={() => void rename(item)}><EditIcon /></IconButton></Tooltip>}
                                {can("MOVE") && <Tooltip title="Move"><IconButton aria-label={`Move ${item.name}`} onClick={() => void move(item)}><DriveFileMoveIcon /></IconButton></Tooltip>}
                                {can("DELETE") && <Tooltip title="Delete"><IconButton color="error" aria-label={`Delete ${item.name}`} onClick={() => void remove(item)}><DeleteIcon /></IconButton></Tooltip>}
                              </Box>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <Dialog open={folderDialog} onClose={() => setFolderDialog(false)}>
          <DialogTitle>Create folder</DialogTitle>
          <DialogContent><TextField autoFocus margin="dense" label="Folder name" fullWidth value={folderName} onChange={(event) => setFolderName(event.target.value)} /></DialogContent>
          <DialogActions><Button onClick={() => setFolderDialog(false)}>Cancel</Button><Button variant="contained" onClick={() => void createFolder()} disabled={!folderName.trim()}>Create</Button></DialogActions>
        </Dialog>
        <Snackbar open={Boolean(message)} autoHideDuration={3500} onClose={() => setMessage("")} message={message} />
      </Stack>
    </AppShell>
  );
}
