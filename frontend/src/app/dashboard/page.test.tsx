import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "./page";

const apiMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/client", () => ({ api: apiMock }));
vi.mock("@/components/AppShell", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const task = (changes: Record<string, unknown>) => ({
  id: "task-id",
  title: "Pending delivery",
  instructions: "Wait for the expected file",
  serverId: "server-id",
  targetPath: "/incoming",
  assigneeId: "user-id",
  dueAt: "2026-09-14T10:00:00Z",
  status: "PENDING",
  completionMode: "MANUAL",
  fileCheckIntervalMinutes: 5,
  createdAt: "2026-09-12T08:00:00Z",
  ...changes,
});

describe("Dashboard task urgency", () => {
  beforeEach(() => {
    apiMock.mockReset();
    pushMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
  });

  it("renders priority order, urgency colors, and refreshes an external-file task", async () => {
    const overdue = task({ id: "overdue", title: "Overdue delivery", status: "OVERDUE", dueAt: "2026-09-11T10:00:00Z" });
    const dueSoon = task({
      id: "matching",
      title: "External delivery",
      dueAt: "2026-09-12T11:00:00Z",
      completionMode: "MATCHING_UPLOAD",
      filenameGlob: "arrival-*.csv",
      lastCheckedAt: "2026-09-12T09:55:00Z",
    });
    const dashboard = { tasks: [overdue, dueSoon], roots: [], recentActivity: [], pendingApprovals: 0 };
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/dashboard") return dashboard;
      if (path === "/tasks/matching/check" && init.method === "POST") return { task: dueSoon, matched: false };
      throw new Error(`Unexpected API request: ${path}`);
    });

    render(<DashboardPage />);

    const overdueTitle = await screen.findByRole("heading", { name: "Overdue delivery" });
    const externalTitle = screen.getByRole("heading", { name: "External delivery" });
    expect(overdueTitle.compareDocumentPosition(externalTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(overdueTitle.closest(".MuiCard-root")).toHaveAttribute("data-task-tone", "overdue");
    expect(externalTitle.closest(".MuiCard-root")).toHaveAttribute("data-task-tone", "due-soon");

    fireEvent.click(within(externalTitle.closest(".MuiCard-root")!).getByRole("button", { name: "Check folder" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/tasks/matching/check", { method: "POST" }));
    expect(await screen.findByText("Folder checked: no matching file found")).toBeInTheDocument();
    expect(apiMock.mock.calls.filter(([path]) => path === "/dashboard")).toHaveLength(2);
  });
});
