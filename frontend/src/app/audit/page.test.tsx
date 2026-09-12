import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuditPage from "./page";

const apiMock = vi.hoisted(() => vi.fn());

afterEach(cleanup);

vi.mock("@/api/client", () => ({ api: apiMock }));
vi.mock("@/components/AppShell", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const uploadEvent = {
  id: "audit-1",
  timestamp: "2026-09-11T12:00:00Z",
  requestId: "request-123",
  actorId: "user-id",
  actorDisplay: "user@gmail.com",
  action: "FILE_UPLOAD",
  resourceType: "file",
  resourceId: null,
  serverId: "server-id",
  serverName: "Finance SFTP",
  path: "/incoming/report.csv",
  itemName: "report.csv",
  folderPath: "/incoming",
  outcome: "SUCCESS",
  sourceIp: "203.0.113.42",
  clientDetails: "Audit Browser/1.0",
  detail: {},
};

describe("Audit activity details", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("shows request metadata supplied to the administrative audit view", async () => {
    apiMock.mockResolvedValue({ items: [uploadEvent] });
    render(<AuditPage />);

    expect(await screen.findByText("Performed by user@gmail.com")).toBeInTheDocument();
    expect(screen.getByText("File: report.csv")).toBeInTheDocument();
    expect(screen.getByText("Server: Finance SFTP · Folder: /incoming")).toBeInTheDocument();
    expect(screen.queryByText(/203\.0\.113\.42/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Audit Browser\/1\.0/)).not.toBeInTheDocument();

    fireEvent.mouseOver(screen.getByRole("button", { name: "Request details for FILE UPLOAD" }));
    expect(await screen.findByText(/request-123/)).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.42/)).toBeInTheDocument();
    expect(screen.getByText(/Audit Browser\/1\.0/)).toBeInTheDocument();
  });

  it("does not expose request metadata when the activity API omits it", async () => {
    const userEvent = { ...uploadEvent, sourceIp: undefined, clientDetails: undefined };
    apiMock.mockResolvedValue({ items: [userEvent] });
    render(<AuditPage />);

    await screen.findByText("Performed by user@gmail.com");
    fireEvent.mouseOver(screen.getByRole("button", { name: "Request details for FILE UPLOAD" }));
    expect(await screen.findByText(/request-123/)).toBeInTheDocument();
    expect(screen.queryByText(/203\.0\.113\.42/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Audit Browser\/1\.0/)).not.toBeInTheDocument();
  });
});
