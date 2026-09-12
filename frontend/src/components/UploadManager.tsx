"use client";

import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import PauseCircleOutlineIcon from "@mui/icons-material/PauseCircleOutline";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import {
  Alert,
  Box,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { cancelUpload, formatBytes, uploadFormWithProgress } from "@/api/client";

const MAX_CONCURRENT_UPLOADS = 2;

type UploadPhase = "queued" | "uploading" | "paused" | "failed" | "completed" | "cancelling";

export type UploadDestination = {
  serverId: string;
  serverName: string;
  path: string;
};

export type UploadJob = UploadDestination & {
  id: string;
  file: File;
  phase: UploadPhase;
  loaded: number;
  total: number;
  percent: number | null;
  error: string;
  uploadId?: string;
};

type UploadContextValue = {
  jobs: UploadJob[];
  enqueueUploads: (files: File[], destination: UploadDestination) => void;
  pauseUpload: (jobId: string) => void;
  resumeUpload: (jobId: string) => void;
  cancelUploadJob: (jobId: string) => Promise<void>;
  completedByDestination: Record<string, number>;
};

const UploadContext = createContext<UploadContextValue | null>(null);

export function uploadDestinationKey(serverId: string, path: string): string {
  return `${serverId}\u0000${path}`;
}

function localUploadId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useUploads(): UploadContextValue {
  const value = useContext(UploadContext);
  if (!value) throw new Error("useUploads must be used inside UploadProvider");
  return value;
}

export default function UploadProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [completedByDestination, setCompletedByDestination] = useState<Record<string, number>>({});
  const jobsRef = useRef<UploadJob[]>([]);
  const running = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());
  const cancelled = useRef(new Set<string>());
  const completionTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const updateJobs = useCallback((change: (current: UploadJob[]) => UploadJob[]) => {
    const next = change(jobsRef.current);
    jobsRef.current = next;
    setJobs(next);
  }, []);

  const updateJob = useCallback((jobId: string, change: (job: UploadJob) => UploadJob) => {
    updateJobs((current) => current.map((job) => job.id === jobId ? change(job) : job));
  }, [updateJobs]);

  const performUpload = useCallback(async (jobId: string) => {
    const initial = jobsRef.current.find((job) => job.id === jobId);
    if (!initial) return;
    const controller = new AbortController();
    controllers.current.set(jobId, controller);
    updateJob(jobId, (job) => ({ ...job, phase: "uploading", error: "" }));

    const form = new FormData();
    form.set("serverId", initial.serverId);
    form.set("path", initial.path);
    form.set("replace", "false");
    form.set("file", initial.file);

    try {
      await uploadFormWithProgress<{ path: string }>("/files/uploads", form, {
        signal: controller.signal,
        uploadId: initial.uploadId,
        onSession: (uploadId) => {
          if (cancelled.current.has(jobId)) {
            void cancelUpload(uploadId).catch(() => undefined);
            return;
          }
          updateJob(jobId, (job) => ({ ...job, uploadId }));
        },
        onProgress: (progress) => updateJob(jobId, (job) => ({ ...job, ...progress })),
      });
      if (cancelled.current.has(jobId)) return;
      updateJob(jobId, (job) => ({ ...job, phase: "completed", loaded: job.total, percent: 100, error: "" }));
      const destination = uploadDestinationKey(initial.serverId, initial.path);
      setCompletedByDestination((current) => ({ ...current, [destination]: (current[destination] || 0) + 1 }));
      const timer = setTimeout(() => {
        updateJobs((current) => current.filter((job) => job.id !== jobId));
        completionTimers.current.delete(jobId);
      }, 5000);
      completionTimers.current.set(jobId, timer);
    } catch (reason) {
      const current = jobsRef.current.find((job) => job.id === jobId);
      if (!current || current.phase === "paused" || current.phase === "cancelling" || cancelled.current.has(jobId)) return;
      updateJob(jobId, (job) => ({
        ...job,
        phase: "failed",
        error: reason instanceof Error ? reason.message : "Upload failed. Check your connection and retry.",
      }));
    } finally {
      controllers.current.delete(jobId);
      running.current.delete(jobId);
      // Trigger the queue effect after a running slot becomes available.
      updateJobs((current) => [...current]);
    }
  }, [updateJob, updateJobs]);

  useEffect(() => {
    const slots = MAX_CONCURRENT_UPLOADS - running.current.size;
    if (slots <= 0) return;
    const next = jobs.filter((job) => job.phase === "queued" && !running.current.has(job.id)).slice(0, slots);
    next.forEach((job) => {
      running.current.add(job.id);
      void performUpload(job.id);
    });
  }, [jobs, performUpload]);

  useEffect(() => () => {
    controllers.current.forEach((controller) => controller.abort());
    completionTimers.current.forEach((timer) => clearTimeout(timer));
  }, []);

  const enqueueUploads = useCallback((files: File[], destination: UploadDestination) => {
    if (!destination.serverId || files.length === 0) return;
    updateJobs((current) => [
      ...current,
      ...files.map((file): UploadJob => ({
        id: localUploadId(),
        file,
        ...destination,
        phase: "queued",
        loaded: 0,
        total: file.size,
        percent: 0,
        error: "",
      })),
    ]);
  }, [updateJobs]);

  const pauseUpload = useCallback((jobId: string) => {
    const job = jobsRef.current.find((candidate) => candidate.id === jobId);
    if (!job || !["queued", "uploading"].includes(job.phase)) return;
    updateJob(jobId, (current) => ({ ...current, phase: "paused" }));
    controllers.current.get(jobId)?.abort();
  }, [updateJob]);

  const resumeUpload = useCallback((jobId: string) => {
    const job = jobsRef.current.find((candidate) => candidate.id === jobId);
    if (!job || !["paused", "failed"].includes(job.phase)) return;
    updateJob(jobId, (current) => ({ ...current, phase: "queued", error: "" }));
  }, [updateJob]);

  const cancelUploadJob = useCallback(async (jobId: string) => {
    const job = jobsRef.current.find((candidate) => candidate.id === jobId);
    if (!job) return;
    cancelled.current.add(jobId);
    updateJob(jobId, (current) => ({ ...current, phase: "cancelling" }));
    controllers.current.get(jobId)?.abort();
    try {
      if (job.uploadId) await cancelUpload(job.uploadId);
    } finally {
      const timer = completionTimers.current.get(jobId);
      if (timer) clearTimeout(timer);
      completionTimers.current.delete(jobId);
      updateJobs((current) => current.filter((candidate) => candidate.id !== jobId));
    }
  }, [updateJob, updateJobs]);

  return (
    <UploadContext.Provider value={{ jobs, enqueueUploads, pauseUpload, resumeUpload, cancelUploadJob, completedByDestination }}>
      {children}
      <UploadProgressWindow
        jobs={jobs}
        onPause={pauseUpload}
        onResume={resumeUpload}
        onCancel={cancelUploadJob}
      />
    </UploadContext.Provider>
  );
}

function UploadProgressWindow({
  jobs,
  onPause,
  onResume,
  onCancel,
}: {
  jobs: UploadJob[];
  onPause: (jobId: string) => void;
  onResume: (jobId: string) => void;
  onCancel: (jobId: string) => Promise<void>;
}) {
  const [minimized, setMinimized] = useState(false);
  if (jobs.length === 0) return null;

  const activeCount = jobs.filter((job) => job.phase === "uploading").length;
  const completedCount = jobs.filter((job) => job.phase === "completed").length;
  const unfinishedJobs = jobs.filter((job) => job.phase !== "completed");
  const pausableJobs = jobs.filter((job) => ["queued", "uploading"].includes(job.phase));
  const resumableJobs = jobs.filter((job) => ["paused", "failed"].includes(job.phase));
  const totalBytes = jobs.reduce((total, job) => total + job.total, 0);
  const loadedBytes = jobs.reduce((total, job) => total + Math.min(job.loaded, job.total), 0);
  const overallPercent = totalBytes === 0 ? 100 : Math.round((loadedBytes / totalBytes) * 100);
  const summary = activeCount > 0
    ? `${activeCount} active`
    : completedCount === jobs.length
      ? `${completedCount} complete`
      : `${jobs.length - completedCount} pending`;

  const toggleAllUploads = () => {
    if (pausableJobs.length > 0) {
      pausableJobs.forEach((job) => onPause(job.id));
      return;
    }
    resumableJobs.forEach((job) => onResume(job.id));
  };

  const cancelAllUploads = () => {
    void Promise.all(unfinishedJobs.map((job) => onCancel(job.id)));
  };

  return (
    <Paper
      elevation={10}
      aria-label="Background file uploads"
      sx={{
        position: "fixed",
        right: { xs: 8, sm: 24 },
        bottom: { xs: 8, sm: 24 },
        width: { xs: "calc(100vw - 16px)", sm: 420 },
        maxHeight: minimized ? "none" : "min(65vh, 560px)",
        overflowY: minimized ? "hidden" : "auto",
        zIndex: (theme) => theme.zIndex.snackbar,
        p: minimized ? 1 : 2,
        transition: (theme) => theme.transitions.create(["max-height", "padding", "width"]),
      }}
    >
      {minimized ? (
        <Stack direction="row" spacing={{ xs: 0.5, sm: 1 }} alignItems="center" aria-live="polite">
          <CloudUploadOutlinedIcon color="primary" fontSize="small" sx={{ display: { xs: "none", sm: "block" } }} />
          <Typography
            variant="body2"
            fontWeight={700}
            noWrap
            aria-label={`${jobs.length} upload${jobs.length === 1 ? "" : "s"}`}
          >
            <Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>{jobs.length}</Box>
            <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>
              {jobs.length} upload{jobs.length === 1 ? "" : "s"}
            </Box>
          </Typography>
          <LinearProgress
            aria-label="Overall upload progress"
            variant="determinate"
            value={overallPercent}
            color={completedCount === jobs.length ? "success" : "primary"}
            sx={{ flex: 1, minWidth: { xs: 40, sm: 64 }, height: 6, borderRadius: 999 }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 34, textAlign: "right" }}>
            {overallPercent}%
          </Typography>
          {(pausableJobs.length > 0 || resumableJobs.length > 0) && (
            <Tooltip title={pausableJobs.length > 0 ? "Pause all uploads" : "Resume all uploads"}>
              <IconButton
                size="small"
                color={pausableJobs.length > 0 ? "default" : "primary"}
                aria-label={pausableJobs.length > 0 ? "Pause all uploads" : "Resume all uploads"}
                onClick={toggleAllUploads}
              >
                {pausableJobs.length > 0 ? <PauseCircleOutlineIcon /> : <PlayCircleOutlineIcon />}
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Cancel all uploads">
            <span>
              <IconButton
                size="small"
                color="error"
                disabled={unfinishedJobs.length === 0}
                aria-label="Cancel all uploads"
                onClick={cancelAllUploads}
              >
                <CancelOutlinedIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Expand upload progress">
            <IconButton size="small" aria-label="Expand upload progress" aria-expanded={false} onClick={() => setMinimized(false)}>
              <KeyboardArrowUpIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      ) : (
        <>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
            <CloudUploadOutlinedIcon color="primary" />
            <Typography fontWeight={700} flex={1}>File uploads</Typography>
            <Typography variant="caption" color="text.secondary">
              {summary}
            </Typography>
            <Tooltip title="Minimize upload progress">
              <IconButton size="small" aria-label="Minimize upload progress" aria-expanded onClick={() => setMinimized(true)}>
                <KeyboardArrowDownIcon />
              </IconButton>
            </Tooltip>
          </Stack>
          <Stack spacing={1.5} aria-live="polite">
            {jobs.map((job) => (
              <Box key={job.id}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Box flex={1} minWidth={0}>
                    <Typography variant="body2" fontWeight={650} noWrap>{job.file.name}</Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {job.serverName} · {job.path}
                    </Typography>
                  </Box>
                  {["queued", "uploading"].includes(job.phase) && (
                    <Tooltip title="Pause upload">
                      <IconButton size="small" aria-label={`Pause upload ${job.file.name}`} onClick={() => onPause(job.id)}>
                        <PauseCircleOutlineIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  {["paused", "failed"].includes(job.phase) && (
                    <Tooltip title={job.phase === "failed" ? "Retry upload" : "Resume upload"}>
                      <IconButton size="small" color="primary" aria-label={`${job.phase === "failed" ? "Retry" : "Resume"} upload ${job.file.name}`} onClick={() => onResume(job.id)}>
                        <PlayCircleOutlineIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  {job.phase === "completed" ? (
                    <CheckCircleOutlineIcon color="success" aria-label={`${job.file.name} uploaded`} />
                  ) : (
                    <Tooltip title="Cancel upload">
                      <span>
                        <IconButton
                          size="small"
                          color="error"
                          disabled={job.phase === "cancelling"}
                          aria-label={`Cancel upload ${job.file.name}`}
                          onClick={() => void onCancel(job.id)}
                        >
                          <CancelOutlinedIcon />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                </Stack>
                <LinearProgress
                  aria-label={`Upload progress ${job.file.name}`}
                  variant={job.percent === null ? "indeterminate" : "determinate"}
                  value={job.percent ?? undefined}
                  color={job.phase === "failed" ? "error" : job.phase === "completed" ? "success" : "primary"}
                  sx={{ mt: 0.75 }}
                />
                {job.phase === "failed" ? (
                  <Alert severity="error" sx={{ mt: 0.75, py: 0 }}>{job.error}</Alert>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    {uploadStatusText(job)}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        </>
      )}
    </Paper>
  );
}

function uploadStatusText(job: UploadJob): string {
  if (job.phase === "completed") return "Uploaded and verified on SFTP";
  if (job.phase === "paused") return `Paused at ${formatBytes(job.loaded)} of ${formatBytes(job.total)}`;
  if (job.phase === "queued") return "Waiting for an upload slot";
  if (job.phase === "cancelling") return "Cancelling and removing the temporary SFTP object…";
  if (job.percent === 100) return "All bytes verified on SFTP. Finalizing the file…";
  return `Written to SFTP: ${job.percent ?? 0}% (${formatBytes(job.loaded)} of ${formatBytes(job.total)})`;
}
