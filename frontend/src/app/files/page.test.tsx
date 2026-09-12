import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FilesPage from "./page";

const { apiMock, enqueueMock } = vi.hoisted(() => ({ apiMock: vi.fn(), enqueueMock: vi.fn() }));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/api/client")>();
  return { ...original, api: apiMock };
});
vi.mock("@/components/UploadManager", () => ({
  uploadDestinationKey: (serverId: string, path: string) => `${serverId}:${path}`,
  useUploads: () => ({ enqueueUploads: enqueueMock, completedByDestination: {} }),
}));
vi.mock("@/components/AppShell", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("file upload selection", () => {
  beforeEach(() => {
    apiMock.mockReset();
    enqueueMock.mockReset();
    apiMock.mockImplementation((path: string) => {
      if (path === "/files/roots") {
        return Promise.resolve({
          items: [{ serverId: "server-1", serverName: "Finance SFTP", path: "/", permissions: ["LIST", "UPLOAD"] }],
        });
      }
      if (path.startsWith("/files/list")) {
        return Promise.resolve({ path: "/", permissions: ["LIST", "UPLOAD"], items: [] });
      }
      return Promise.resolve({});
    });
  });

  it("enqueues every file dropped into the visible folder", async () => {
    render(<FilesPage />);
    const dropZone = await screen.findByTestId("upload-drop-zone");
    await screen.findByText("Drag and drop files into this folder");
    const first = new File(["first"], "first.csv", { type: "text/csv" });
    const second = new File(["second"], "second.csv", { type: "text/csv" });

    fireEvent.dragEnter(dropZone);
    expect(screen.getByText("Drop to upload into /")).toBeInTheDocument();
    fireEvent.drop(dropZone, { dataTransfer: { files: [first, second] } });

    expect(enqueueMock).toHaveBeenCalledWith(
      [first, second],
      { serverId: "server-1", serverName: "Finance SFTP", path: "/" },
    );
  });

  it("accepts multiple files from the picker", async () => {
    const { container } = render(<FilesPage />);
    await screen.findByTestId("upload-drop-zone");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const first = new File(["one"], "one.txt", { type: "text/plain" });
    const second = new File(["two"], "two.txt", { type: "text/plain" });

    expect(input).toHaveAttribute("multiple");
    fireEvent.change(input!, { target: { files: [first, second] } });

    expect(enqueueMock).toHaveBeenCalledWith(
      [first, second],
      { serverId: "server-1", serverName: "Finance SFTP", path: "/" },
    );
  });
});

describe("inline file and folder rename", () => {
  beforeEach(() => {
    apiMock.mockReset();
    enqueueMock.mockReset();
    apiMock.mockImplementation((requestPath: string) => {
      if (requestPath === "/files/roots") {
        return Promise.resolve({
          items: [{ serverId: "server-1", serverName: "Finance SFTP", path: "/", permissions: ["LIST", "RENAME"] }],
        });
      }
      if (requestPath.startsWith("/files/list")) {
        return Promise.resolve({
          path: "/",
          permissions: ["LIST", "RENAME"],
          items: [{ name: "report.csv", path: "/report.csv", type: "file", size: 12, modifiedAt: 1_700_000_000 }],
        });
      }
      return Promise.resolve({});
    });
  });

  it("edits the filename in its table row and saves with Enter", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    render(<FilesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Rename report.csv" }));

    expect(promptSpy).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox", { name: "New name for report.csv" });
    expect(input).toHaveValue("report.csv");
    fireEvent.change(input, { target: { value: "final-report.csv" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/files/rename",
      { method: "POST", body: JSON.stringify({ serverId: "server-1", path: "/report.csv", name: "final-report.csv" }) },
    ));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "New name for report.csv" })).not.toBeInTheDocument());
    expect(screen.getByText("Item renamed")).toBeInTheDocument();
    promptSpy.mockRestore();
  });

  it("cancels with Escape without calling the rename API", async () => {
    render(<FilesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename report.csv" }));
    const input = screen.getByRole("textbox", { name: "New name for report.csv" });

    fireEvent.change(input, { target: { value: "cancelled.csv" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "New name for report.csv" })).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith("/files/rename", expect.anything());
  });

  it("keeps a readable API error with the active inline editor", async () => {
    apiMock.mockImplementation((requestPath: string) => {
      if (requestPath === "/files/roots") {
        return Promise.resolve({
          items: [{ serverId: "server-1", serverName: "Finance SFTP", path: "/", permissions: ["LIST", "RENAME"] }],
        });
      }
      if (requestPath.startsWith("/files/list")) {
        return Promise.resolve({
          path: "/",
          permissions: ["LIST", "RENAME"],
          items: [{ name: "report.csv", path: "/report.csv", type: "file", size: 12, modifiedAt: 1_700_000_000 }],
        });
      }
      if (requestPath === "/files/rename") return Promise.reject(new Error("A file with this name already exists"));
      return Promise.resolve({});
    });
    render(<FilesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename report.csv" }));
    const input = screen.getByRole("textbox", { name: "New name for report.csv" });

    fireEvent.change(input, { target: { value: "existing.csv" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("A file with this name already exists")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "New name for report.csv" })).toHaveValue("existing.csv");
  });
});

describe("same-server move folder picker", () => {
  beforeEach(() => {
    apiMock.mockReset();
    enqueueMock.mockReset();
    apiMock.mockImplementation((requestPath: string) => {
      if (requestPath === "/files/roots") {
        return Promise.resolve({
          items: [{ serverId: "server-1", serverName: "Finance SFTP", path: "/", permissions: ["LIST", "MOVE", "UPLOAD"] }],
        });
      }
      if (requestPath.includes("path=%2Farchive")) {
        return Promise.resolve({ path: "/archive", permissions: ["LIST", "UPLOAD"], items: [] });
      }
      if (requestPath.startsWith("/files/list")) {
        return Promise.resolve({
          path: "/",
          permissions: ["LIST", "MOVE", "UPLOAD"],
          items: [
            { name: "archive", path: "/archive", type: "folder", size: 0, modifiedAt: 1_700_000_000 },
            { name: "report.csv", path: "/report.csv", type: "file", size: 12, modifiedAt: 1_700_000_000 },
          ],
        });
      }
      return Promise.resolve({});
    });
  });

  it("selects a destination folder in a popup and moves the item without a browser prompt", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    render(<FilesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Move report.csv" }));

    expect(promptSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Move report.csv" });
    expect(dialog).toHaveTextContent("Finance SFTP");
    expect(dialog).toHaveTextContent("Destination folder: /");
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: "Open archive" }));

    expect(await screen.findByText("Destination folder: /archive")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/files/move",
      { method: "POST", body: JSON.stringify({ serverId: "server-1", source: "/report.csv", destination: "/archive/report.csv" }) },
    ));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Move report.csv" })).not.toBeInTheDocument());
    expect(screen.getByText("Item moved")).toBeInTheDocument();
  });

  it("keeps move failures highlighted inside the destination popup", async () => {
    apiMock.mockImplementation((requestPath: string) => {
      if (requestPath === "/files/roots") {
        return Promise.resolve({
          items: [{ serverId: "server-1", serverName: "Finance SFTP", path: "/", permissions: ["LIST", "MOVE", "UPLOAD"] }],
        });
      }
      if (requestPath.includes("path=%2Farchive")) {
        return Promise.resolve({ path: "/archive", permissions: ["LIST", "UPLOAD"], items: [] });
      }
      if (requestPath.startsWith("/files/list")) {
        return Promise.resolve({
          path: "/",
          permissions: ["LIST", "MOVE", "UPLOAD"],
          items: [
            { name: "archive", path: "/archive", type: "folder", size: 0, modifiedAt: 1_700_000_000 },
            { name: "report.csv", path: "/report.csv", type: "file", size: 12, modifiedAt: 1_700_000_000 },
          ],
        });
      }
      if (requestPath === "/files/move") return Promise.reject(new Error("A file with this name already exists"));
      return Promise.resolve({});
    });
    render(<FilesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Move report.csv" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open archive" }));
    await screen.findByText("Destination folder: /archive");

    fireEvent.click(screen.getByRole("button", { name: "Move here" }));

    const dialog = screen.getByRole("dialog", { name: "Move report.csv" });
    expect(await screen.findByText("A file with this name already exists")).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
  });
});
