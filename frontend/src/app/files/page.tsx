"use client";

import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
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
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Paper,
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

function parentPath(value: string): string {
  const separator = value.lastIndexOf("/");
  return separator <= 0 ? "/" : value.slice(0, separator);
}

function childPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

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
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [moveTarget, setMoveTarget] = useState<FileItem | null>(null);
  const [movePath, setMovePath] = useState("/");
  const [moveListing, setMoveListing] = useState<Listing | null>(null);
  const [moveLoading, setMoveLoading] = useState(false);
  const [movePending, setMovePending] = useState(false);
  const [moveError, setMoveError] = useState("");
  const moveLoadRequest = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const currentRoot = useMemo(
    () => roots
      .filter((root) => root.serverId === serverId && (path === root.path || root.path === "/" || path.startsWith(`${root.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0],
    [roots, serverId, path],
  );
  const moveServerRoots = useMemo(
    () => roots.filter((root) => root.serverId === serverId),
    [roots, serverId],
  );
  const moveRoot = useMemo(
    () => moveServerRoots
      .filter((root) => movePath === root.path || root.path === "/" || movePath.startsWith(`${root.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0],
    [moveServerRoots, movePath],
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
  useEffect(() => {
    if (moveTarget) void loadMoveListing(movePath);
  }, [moveTarget?.path, movePath, serverId]);

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

  function beginRename(item: FileItem) {
    setError("");
    setRenameTarget(item);
    setRenameName(item.name);
    setRenameError("");
  }

  function cancelRename() {
    if (renamePending) return;
    setRenameTarget(null);
    setRenameName("");
    setRenameError("");
  }

  async function saveRename(item: FileItem) {
    const name = renameName.trim();
    if (!name) {
      setRenameError("A file or folder name is required");
      return;
    }
    if (name === item.name || renamePending) return;
    setRenamePending(true);
    setRenameError("");
    try {
      await api("/files/rename", { method: "POST", body: JSON.stringify({ serverId, path: item.path, name }) });
      setRenameTarget(null);
      setRenameName("");
      setMessage("Item renamed");
      await loadListing();
    } catch (reason) {
      setRenameError(reason instanceof Error ? reason.message : "Unable to rename this item");
    } finally {
      setRenamePending(false);
    }
  }

  async function loadMoveListing(destinationFolder: string) {
    const requestNumber = moveLoadRequest.current + 1;
    moveLoadRequest.current = requestNumber;
    setMoveLoading(true);
    setMoveListing(null);
    setMoveError("");
    try {
      const value = await api<Listing>(`/files/list?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(destinationFolder)}`);
      if (requestNumber === moveLoadRequest.current) setMoveListing(value);
    } catch (reason) {
      if (requestNumber === moveLoadRequest.current) {
        setMoveError(reason instanceof Error ? reason.message : "Unable to open this folder");
      }
    } finally {
      if (requestNumber === moveLoadRequest.current) setMoveLoading(false);
    }
  }

  function beginMove(item: FileItem) {
    setError("");
    setMoveTarget(item);
    setMovePath(currentRoot?.path || "/");
    setMoveListing(null);
    setMoveError("");
  }

  function cancelMove() {
    if (movePending) return;
    moveLoadRequest.current += 1;
    setMoveTarget(null);
    setMoveListing(null);
    setMoveError("");
  }

  async function submitMove() {
    if (!moveTarget || movePending) return;
    const destination = childPath(movePath, moveTarget.name);
    setMovePending(true);
    setMoveError("");
    try {
      await api("/files/move", { method: "POST", body: JSON.stringify({ serverId, source: moveTarget.path, destination }) });
      setMoveTarget(null);
      setMoveListing(null);
      setMessage("Item moved");
      await loadListing();
    } catch (reason) {
      setMoveError(reason instanceof Error ? reason.message : "Unable to move this item");
    } finally {
      setMovePending(false);
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
                        {listing.items.map((item) => {
                          const isRenaming = renameTarget?.path === item.path;
                          const renameUnchanged = renameName.trim() === item.name;
                          return (
                            <TableRow key={item.path} hover={!isRenaming}>
                            <TableCell sx={{ minWidth: { xs: 280, md: 380 } }}>
                              {isRenaming ? (
                                <Stack direction="row" spacing={0.75} alignItems="flex-start" aria-busy={renamePending}>
                                  <Box sx={{ pt: 1 }}>
                                    {item.type === "folder" ? <FolderIcon color="primary" /> : <InsertDriveFileIcon color="action" />}
                                  </Box>
                                  <TextField
                                    autoFocus
                                    size="small"
                                    fullWidth
                                    value={renameName}
                                    error={Boolean(renameError)}
                                    helperText={renameError || "Enter to save · Escape to cancel"}
                                    inputProps={{ "aria-label": `New name for ${item.name}` }}
                                    onChange={(event) => {
                                      setRenameName(event.target.value);
                                      if (renameError) setRenameError("");
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        void saveRename(item);
                                      } else if (event.key === "Escape") {
                                        event.preventDefault();
                                        cancelRename();
                                      }
                                    }}
                                  />
                                  <Tooltip title="Save rename">
                                    <span>
                                      <IconButton
                                        color="primary"
                                        aria-label={`Save rename for ${item.name}`}
                                        disabled={renamePending || !renameName.trim() || renameUnchanged}
                                        onClick={() => void saveRename(item)}
                                      >
                                        {renamePending ? <CircularProgress size={20} /> : <CheckIcon />}
                                      </IconButton>
                                    </span>
                                  </Tooltip>
                                  <Tooltip title="Cancel rename">
                                    <span>
                                      <IconButton aria-label={`Cancel rename for ${item.name}`} disabled={renamePending} onClick={cancelRename}>
                                        <CloseIcon />
                                      </IconButton>
                                    </span>
                                  </Tooltip>
                                </Stack>
                              ) : (
                                <Button color="inherit" startIcon={item.type === "folder" ? <FolderIcon color="primary" /> : <InsertDriveFileIcon color="action" />} onClick={() => item.type === "folder" && openPath(item.path)} sx={{ fontWeight: 650 }}>{item.name}</Button>
                              )}
                            </TableCell>
                            <TableCell>{item.type === "file" ? formatBytes(item.size) : "—"}</TableCell>
                            <TableCell>{new Date(item.modifiedAt * 1000).toLocaleString()}</TableCell>
                            <TableCell align="right">
                              <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
                                {item.type === "file" && can("DOWNLOAD") && <Tooltip title="Download"><IconButton aria-label={`Download ${item.name}`} component="a" href={`/api/v1/files/download?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(item.path)}`}><DownloadIcon /></IconButton></Tooltip>}
                                {can("RENAME") && !isRenaming && <Tooltip title="Rename"><IconButton aria-label={`Rename ${item.name}`} disabled={renamePending} onClick={() => beginRename(item)}><EditIcon /></IconButton></Tooltip>}
                                {can("MOVE") && <Tooltip title="Move"><IconButton aria-label={`Move ${item.name}`} disabled={isRenaming} onClick={() => beginMove(item)}><DriveFileMoveIcon /></IconButton></Tooltip>}
                                {can("DELETE") && <Tooltip title="Delete"><IconButton color="error" aria-label={`Delete ${item.name}`} disabled={isRenaming} onClick={() => void remove(item)}><DeleteIcon /></IconButton></Tooltip>}
                              </Box>
                            </TableCell>
                            </TableRow>
                          );
                        })}
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
        <Dialog open={Boolean(moveTarget)} onClose={cancelMove} maxWidth="sm" fullWidth>
          <DialogTitle>{moveTarget ? `Move ${moveTarget.name}` : "Move item"}</DialogTitle>
          <DialogContent>
            {moveTarget && (
              <Stack spacing={2} sx={{ pt: 0.5 }}>
                <Typography color="text.secondary">
                  Choose another folder on <strong>{currentRoot?.serverName || "this SFTP server"}</strong>. The item name will not change.
                </Typography>
                {moveServerRoots.length > 1 && (
                  <FormControl fullWidth>
                    <InputLabel>Accessible location</InputLabel>
                    <Select
                      label="Accessible location"
                      value={moveRoot?.path || movePath}
                      disabled={movePending}
                      onChange={(event) => setMovePath(String(event.target.value))}
                    >
                      {moveServerRoots.map((root) => (
                        <MenuItem key={root.path} value={root.path}>{root.serverName} — {root.path}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}
                <Breadcrumbs aria-label="Move destination path">
                  <Link
                    component="button"
                    underline="hover"
                    disabled={movePending}
                    onClick={() => moveRoot && setMovePath(moveRoot.path)}
                  >
                    {moveRoot?.serverName || currentRoot?.serverName || "SFTP server"} — {moveRoot?.path || "/"}
                  </Link>
                  {movePath.split("/").filter(Boolean).slice((moveRoot?.path || "/").split("/").filter(Boolean).length).map((segment, index) => {
                    const rootSegments = (moveRoot?.path || "/").split("/").filter(Boolean);
                    const relativeSegments = movePath.split("/").filter(Boolean).slice(rootSegments.length, rootSegments.length + index + 1);
                    const destination = `/${[...rootSegments, ...relativeSegments].join("/")}`;
                    return <Link component="button" underline="hover" disabled={movePending} key={destination} onClick={() => setMovePath(destination)}>{segment}</Link>;
                  })}
                </Breadcrumbs>
                <Paper variant="outlined" sx={{ minHeight: 128, maxHeight: 280, overflow: "auto" }}>
                  {moveLoading ? (
                    <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 128 }} role="status" aria-label="Loading destination folders">
                      <CircularProgress size={28} />
                    </Stack>
                  ) : (
                    <List aria-label="Destination folders" disablePadding>
                      {(moveListing?.items || []).filter((item) => item.type === "folder").map((folder) => {
                        const insideMovedFolder = moveTarget.type === "folder"
                          && (folder.path === moveTarget.path || folder.path.startsWith(`${moveTarget.path}/`));
                        return (
                          <ListItemButton
                            key={folder.path}
                            disabled={movePending || insideMovedFolder}
                            aria-label={`Open ${folder.name}`}
                            onClick={() => setMovePath(folder.path)}
                          >
                            <ListItemIcon><FolderIcon color={insideMovedFolder ? "disabled" : "primary"} /></ListItemIcon>
                            <ListItemText primary={folder.name} secondary={insideMovedFolder ? "Cannot move a folder into itself" : folder.path} />
                          </ListItemButton>
                        );
                      })}
                      {!moveLoading && moveListing && moveListing.items.every((item) => item.type !== "folder") && (
                        <Typography color="text.secondary" textAlign="center" sx={{ py: 4, px: 2 }}>No child folders here.</Typography>
                      )}
                    </List>
                  )}
                </Paper>
                <Typography fontWeight={650} aria-live="polite">Destination folder: {movePath}</Typography>
                {parentPath(moveTarget.path) === movePath && (
                  <Typography variant="body2" color="text.secondary">Choose a different folder to move this item.</Typography>
                )}
                {moveError && <Alert severity="error">{moveError}</Alert>}
              </Stack>
            )}
          </DialogContent>
          <DialogActions sx={{ justifyContent: "flex-start", px: 3, pb: 2.5 }}>
            <Button
              variant="contained"
              startIcon={movePending ? <CircularProgress size={18} color="inherit" /> : <DriveFileMoveIcon />}
              disabled={
                !moveTarget
                || moveLoading
                || movePending
                || moveListing?.path !== movePath
                || !moveListing?.permissions.includes(moveTarget.type === "folder" ? "CREATE_FOLDER" : "UPLOAD")
                || parentPath(moveTarget.path) === movePath
                || (moveTarget.type === "folder" && (movePath === moveTarget.path || movePath.startsWith(`${moveTarget.path}/`)))
              }
              onClick={() => void submitMove()}
            >
              {movePending ? "Moving…" : "Move here"}
            </Button>
            <Button disabled={movePending} onClick={cancelMove}>Cancel</Button>
          </DialogActions>
        </Dialog>
        <Snackbar open={Boolean(message)} autoHideDuration={3500} onClose={() => setMessage("")} message={message} />
      </Stack>
    </AppShell>
  );
}
