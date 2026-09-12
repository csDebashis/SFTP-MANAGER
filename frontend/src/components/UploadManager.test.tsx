import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UploadProvider, { useUploads } from "./UploadManager";

const { cancelMock, uploadMock } = vi.hoisted(() => ({ cancelMock: vi.fn(), uploadMock: vi.fn() }));

vi.mock("@/api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/api/client")>();
  return { ...original, cancelUpload: cancelMock, uploadFormWithProgress: uploadMock };
});

afterEach(cleanup);

function UploadHarness() {
  const { enqueueUploads } = useUploads();
  const [page, setPage] = useState("files");
  return (
    <>
      <button onClick={() => enqueueUploads(
        [new File(["one"], "one.txt"), new File(["two"], "two.txt")],
        { serverId: "server-1", serverName: "Finance", path: "/incoming" },
      )}>Add files</button>
      <button onClick={() => setPage("home")}>Navigate</button>
      <span>{page}</span>
    </>
  );
}

describe("background upload manager", () => {
  beforeEach(() => {
    cancelMock.mockReset().mockResolvedValue(undefined);
    uploadMock.mockReset();
  });

  it("keeps multiple uploads running when route content changes", async () => {
    uploadMock.mockImplementation((_path, form, options) => {
      const file = form.get("file") as File;
      options.onSession(`session-${file.name}`);
      options.onProgress({ loaded: 1, total: file.size, percent: 33 });
      return new Promise(() => undefined);
    });

    render(<UploadProvider><UploadHarness /></UploadProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Background file uploads")).toBeInTheDocument();
    expect(screen.getByText("one.txt")).toBeInTheDocument();
    expect(screen.getByText("two.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(screen.getByText("home")).toBeInTheDocument();
    expect(screen.getByText("one.txt")).toBeInTheDocument();
    expect(screen.getByText("two.txt")).toBeInTheDocument();
  });

  it("pauses, resumes from its server session, and cancels uploads independently", async () => {
    uploadMock.mockImplementation((_path, form, options) => {
      const file = form.get("file") as File;
      options.onSession(`session-${file.name}`);
      options.onProgress({ loaded: 1, total: file.size, percent: 33 });
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });

    render(<UploadProvider><UploadHarness /></UploadProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Pause upload one.txt" }));
    expect(await screen.findByText(/Paused at/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume upload one.txt" }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(3));
    expect(uploadMock.mock.calls[2][2].uploadId).toBe("session-one.txt");

    fireEvent.click(screen.getByRole("button", { name: "Cancel upload two.txt" }));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("session-two.txt"));
    await waitFor(() => expect(screen.queryByText("two.txt")).not.toBeInTheDocument());
    expect(screen.getByText("one.txt")).toBeInTheDocument();
  });

  it("minimizes to aggregate progress with pause, resume, cancel, and expand controls", async () => {
    uploadMock.mockImplementation((_path, form, options) => {
      const file = form.get("file") as File;
      options.onSession(`session-${file.name}`);
      options.onProgress({ loaded: 1, total: file.size, percent: 33 });
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });

    render(<UploadProvider><UploadHarness /></UploadProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Minimize upload progress" }));
    expect(screen.getByText("2 uploads")).toBeInTheDocument();
    expect(screen.getByLabelText("Overall upload progress")).toHaveAttribute("aria-valuenow", "33");
    expect(screen.queryByText("one.txt")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause all uploads" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume all uploads" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Resume all uploads" }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(4));

    fireEvent.click(screen.getByRole("button", { name: "Expand upload progress" }));
    expect(screen.getByText("one.txt")).toBeInTheDocument();
    expect(screen.getByText("two.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Minimize upload progress" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel all uploads" }));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("session-one.txt"));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("session-two.txt"));
    await waitFor(() => expect(screen.queryByLabelText("Background file uploads")).not.toBeInTheDocument());
  });
});
