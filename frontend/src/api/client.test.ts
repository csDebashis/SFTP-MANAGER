import { afterEach, describe, expect, it, vi } from "vitest";
import { api, formatBytes, uploadFormWithProgress } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("formatBytes", () => {
  it("formats bytes and larger values", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("api errors", () => {
  it("turns FastAPI validation details into a readable field message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        detail: [{ loc: ["body", "path"], msg: "Value error, Path must be absolute", type: "value_error" }],
      }),
    }));

    await expect(api("/access-grants/grant-id", { method: "PATCH", body: "{}" }))
      .rejects.toThrow("path: Value error, Path must be absolute");
  });
});

describe("progress uploads", () => {
  const response = (payload: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });

  it("reports only SFTP-acknowledged progress and includes CSRF protection", async () => {
    document.cookie = "sftp_csrf=csrf-test";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ uploadId: "upload-1", receivedBytes: 0, totalBytes: 10, percent: 0, chunkSize: 5, status: "ACTIVE" }, 201))
      .mockResolvedValueOnce(response({ uploadId: "upload-1", receivedBytes: 5, totalBytes: 10, percent: 50, chunkSize: 5, status: "ACTIVE" }))
      .mockResolvedValueOnce(response({ uploadId: "upload-1", receivedBytes: 10, totalBytes: 10, percent: 100, chunkSize: 5, status: "ACTIVE" }))
      .mockResolvedValueOnce(response({ path: "/report.csv" }));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    const form = new FormData();
    form.set("serverId", "server-1");
    form.set("path", "/incoming");
    form.set("replace", "false");
    form.set("file", new File(["0123456789"], "report.csv"));

    await expect(uploadFormWithProgress<{ path: string }>("/files/uploads", form, { onProgress: progress }))
      .resolves.toEqual({ path: "/report.csv" });

    expect(progress).toHaveBeenNthCalledWith(1, { loaded: 0, total: 10, percent: 0 });
    expect(progress).toHaveBeenCalledWith({ loaded: 5, total: 10, percent: 50 });
    expect(progress).toHaveBeenLastCalledWith({ loaded: 10, total: 10, percent: 100 });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/files/uploads/upload-1/content");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "PUT",
      credentials: "include",
      headers: expect.objectContaining({ "X-CSRF-Token": "csrf-test", "X-Upload-Offset": "0" }),
    });
  });

  it("returns a retryable message when the network connection fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ uploadId: "upload-1", receivedBytes: 0, totalBytes: 7, percent: 0, chunkSize: 5, status: "ACTIVE" }, 201))
      .mockRejectedValueOnce(new TypeError("network failed")));
    const form = new FormData();
    form.set("serverId", "server-1");
    form.set("path", "/incoming");
    form.set("file", new File(["content"], "report.csv"));

    await expect(uploadFormWithProgress("/files/uploads", form))
      .rejects.toThrow("Upload was interrupted by a network problem. Retry to resume from the bytes already written to SFTP.");
  });
});
