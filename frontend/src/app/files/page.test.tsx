import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

afterEach(cleanup);

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
