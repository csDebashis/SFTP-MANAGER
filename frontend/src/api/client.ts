export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;

  if (isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (typeof payload.detail === "string") return payload.detail;

  if (Array.isArray(payload.detail)) {
    const messages = payload.detail.flatMap((item) => {
      if (!isRecord(item) || typeof item.msg !== "string") return [];
      const location = Array.isArray(item.loc)
        ? item.loc.filter((part) => part !== "body").map(String).join(".")
        : "";
      return [location ? `${location}: ${item.msg}` : item.msg];
    });
    if (messages.length) return messages.join("; ");
  }

  return fallback;
}

function csrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.split("; ").find((part) => part.startsWith("sftp_csrf="));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : "";
}

export type UploadProgress = {
  loaded: number;
  total: number;
  percent: number | null;
};

type UploadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  onSession?: (uploadId: string) => void;
  uploadId?: string;
};

type UploadSession = {
  uploadId: string;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  chunkSize: number;
  status: "ACTIVE" | "COMPLETED";
  targetPath?: string | null;
};

function requiredFormText(body: FormData, name: string): string {
  const value = body.get(name);
  if (typeof value !== "string" || !value) throw new ApiError(422, `Missing upload ${name}`);
  return value;
}

async function uploadResponse<T>(response: Response, fallback: string): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) throw new ApiError(response.status, responseErrorMessage(payload, fallback));
  return payload as T;
}

/**
 * Upload in bounded requests. Progress advances only after the API confirms that
 * the corresponding byte range was written and size-verified on the SFTP server.
 */
export async function uploadFormWithProgress<T>(_path: string, body: FormData, options: UploadOptions = {}): Promise<T> {
  const fileValue = body.get("file");
  if (!(fileValue instanceof File)) throw new ApiError(422, "An upload file is required");
  const file = fileValue;
  const serverId = requiredFormText(body, "serverId");
  const destinationPath = requiredFormText(body, "path");
  const replace = body.get("replace") === "true";

  try {
    let session = options.uploadId
      ? await api<UploadSession>(`/files/uploads/${encodeURIComponent(options.uploadId)}`)
      : await api<UploadSession>("/files/uploads", {
          method: "POST",
          body: JSON.stringify({ serverId, path: destinationPath, fileName: file.name, size: file.size, replace }),
        });
    options.onSession?.(session.uploadId);

    if (session.status === "COMPLETED" && session.targetPath) {
      options.onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
      return { path: session.targetPath } as T;
    }
    if (session.totalBytes !== file.size) throw new ApiError(409, "The selected file does not match the resumable upload");

    let acknowledged = session.receivedBytes;
    options.onProgress?.({
      loaded: acknowledged,
      total: file.size,
      percent: file.size === 0 ? 100 : Math.min(100, Math.round(acknowledged * 100 / file.size)),
    });
    while (acknowledged < file.size) {
      const chunk = file.slice(acknowledged, Math.min(file.size, acknowledged + session.chunkSize));
      const response = await fetch(`/api/v1/files/uploads/${encodeURIComponent(session.uploadId)}/content`, {
        method: "PUT",
        body: chunk,
        credentials: "include",
        cache: "no-store",
        signal: options.signal,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-CSRF-Token": csrfToken(),
          "X-Upload-Offset": String(acknowledged),
        },
      });
      session = await uploadResponse<UploadSession>(response, `Upload failed (${response.status})`);
      if (session.receivedBytes <= acknowledged) throw new ApiError(502, "SFTP server did not acknowledge upload progress");
      acknowledged = session.receivedBytes;
      options.onProgress?.({
        loaded: acknowledged,
        total: file.size,
        percent: file.size === 0 ? 100 : Math.min(100, Math.round(acknowledged * 100 / file.size)),
      });
    }
    return await api<T>(`/files/uploads/${encodeURIComponent(session.uploadId)}/complete`, { method: "POST" });
  } catch (reason) {
    if (reason instanceof ApiError) throw reason;
    if (options.signal?.aborted || (reason instanceof DOMException && reason.name === "AbortError")) {
      throw new ApiError(0, "Upload cancelled. You can retry when ready.");
    }
    throw new ApiError(0, "Upload was interrupted by a network problem. Retry to resume from the bytes already written to SFTP.");
  }
}

export async function cancelUpload(uploadId: string): Promise<void> {
  await api(`/files/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" });
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("X-CSRF-Token", csrfToken());
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: "include", cache: "no-store" });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      message = responseErrorMessage(payload, message);
    } catch {}
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}
