import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TasksPage from "./page";

const apiMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/client", () => ({ api: apiMock }));
vi.mock("@/components/AppShell", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
afterEach(cleanup);

const admin = { id: "admin-id", email: "admin@gmail.com", displayName: "Administrator", role: "ADMIN", state: "ACTIVE", timezone: "UTC", version: 1 };
const user = { ...admin, id: "user-id", email: "test@gmail.com", displayName: "Test User", role: "USER" };
const group = { id: "group-id", name: "Settlement team", description: "Shared work", memberIds: [user.id], version: 1 };
const server = { id: "server-id", name: "Finance SFTP", description: "", host: "mock.local", port: 22, username: "mock", authType: "PASSWORD", rootPath: "/", hostKeyFingerprint: "mock-local", adapterType: "MOCK", enabled: true, credentialConfigured: true, version: 1 };
const definition = {
  id: "definition-id", title: "Daily delivery", instructions: "Upload the daily file", enabled: true,
  serverId: server.id, targetPath: "/shared", assigneeType: "USER" as const, assigneeId: user.id, scheduleType: "DAILY" as const,
  startAt: "2026-09-12T09:00:00Z", timezone: "UTC", weekdays: [], dueOffsetMinutes: 60,
  completionMode: "MATCHING_UPLOAD", filenameGlob: "daily-*.csv", fileCheckIntervalMinutes: 10 as const,
  nextRunAt: "2026-09-13T09:00:00Z", lastCheckedAt: "2026-09-12T08:50:00Z", version: 2,
};

function adminApi(definitions = [] as typeof definition[]) {
  let storedDefinitions = definitions;
  apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
    if (path === "/tasks" && !init.method) return { items: [] };
    if (path === "/auth/me") return { user: admin };
    if (path === "/users") return { items: [admin, user] };
    if (path === "/groups") return { items: [group] };
    if (path === "/sftp-servers") return { items: [server] };
    if (path === "/task-definitions" && !init.method) return { items: storedDefinitions };
    if (path === "/task-definitions" && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      storedDefinitions = [{ ...definition, ...body }];
      return storedDefinitions[0];
    }
    if (path === "/task-definitions/definition-id" && init.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      storedDefinitions = [{ ...definition, ...body, version: 3 }];
      return storedDefinitions[0];
    }
    if (path === "/task-definitions/definition-id" && init.method === "DELETE") {
      storedDefinitions = [];
      return undefined;
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
}

describe("Task schedule dialogs", () => {
  beforeEach(() => { apiMock.mockReset(); pushMock.mockReset(); adminApi(); });

  it("opens a modal, offers every repeat option, and creates a scheduled definition", async () => {
    render(<TasksPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add task schedule" }));
    const dialog = await screen.findByRole("dialog", { name: "Add task schedule" });

    fireEvent.mouseDown(within(dialog).getByRole("combobox", { name: "Repeat" }));
    expect(await screen.findByRole("option", { name: "Once" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Daily" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Weekly" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Monthly" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Daily" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Daily delivery" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Target folder" }), { target: { value: "/shared" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/task-definitions", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByText("Task schedule created")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add task schedule" })).not.toBeInTheDocument());
  });

  it("offers configurable folder checks and keeps save failures inside the modal", async () => {
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/tasks") return { items: [] };
      if (path === "/auth/me") return { user: admin };
      if (path === "/users") return { items: [admin, user] };
      if (path === "/groups") return { items: [group] };
      if (path === "/sftp-servers") return { items: [server] };
      if (path === "/task-definitions" && !init.method) return { items: [] };
      if (path === "/task-definitions" && init.method === "POST") throw new Error("Target folder cannot be reached");
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<TasksPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add task schedule" }));
    const dialog = await screen.findByRole("dialog", { name: "Add task schedule" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "File arrival" } });
    fireEvent.mouseDown(within(dialog).getByRole("combobox", { name: "Completion" }));
    fireEvent.click(await screen.findByRole("option", { name: "Matching file in folder" }));
    expect(within(dialog).getByRole("textbox", { name: "Filename pattern" })).toBeRequired();
    fireEvent.mouseDown(within(dialog).getByRole("combobox", { name: "Check folder" }));
    expect(await screen.findByRole("option", { name: "Every 5 minutes" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Every 10 minutes" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Every 30 minutes" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Hourly" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Daily" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Filename pattern" }), { target: { value: "arrival-*.csv" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create schedule" }));
    expect(await within(dialog).findByText("Target folder cannot be reached")).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
  });

  it("shows compact schedule rows, full hover details, and an editable popup", async () => {
    adminApi([definition]);
    render(<TasksPage />);
    expect(await screen.findByRole("table", { name: "Task schedules" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Description" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Schedule" })).toBeInTheDocument();

    fireEvent.mouseOver(screen.getByRole("button", { name: "View Daily delivery schedule details" }));
    expect(await screen.findByText(/Last folder check:/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Daily delivery" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit task schedule" });
    expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveValue("Daily delivery");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Instructions" }), { target: { value: "Updated instructions" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/task-definitions/definition-id", expect.objectContaining({ method: "PATCH" })));
    expect(await screen.findByText("Task schedule updated")).toBeInTheDocument();
  });

  it("can assign to a group and delete a schedule with confirmation", async () => {
    adminApi([definition]);
    render(<TasksPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add task schedule" }));
    const createDialog = await screen.findByRole("dialog", { name: "Add task schedule" });
    fireEvent.mouseDown(within(createDialog).getByRole("combobox", { name: "Assign to" }));
    fireEvent.click(await screen.findByRole("option", { name: "Group" }));
    expect(within(createDialog).getByRole("combobox", { name: "Group" })).toHaveTextContent("Settlement team");
    fireEvent.click(within(createDialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add task schedule" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Delete Daily delivery" }));
    const deleteDialog = await screen.findByRole("dialog", { name: "Delete task schedule" });
    expect(within(deleteDialog).getByText(/removes its generated work items/i)).toBeInTheDocument();
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "Delete schedule" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/task-definitions/definition-id", { method: "DELETE" }));
    expect(await screen.findByText("Task schedule deleted")).toBeInTheDocument();
  });
});

describe("Assigned task prioritization and folder refresh", () => {
  it("sorts and highlights overdue work before recent pending work and can check SFTP", async () => {
    const now = Date.now();
    let taskItems = [
      { id: "older", title: "Older pending", instructions: "", serverId: server.id, serverName: server.name, targetPath: "/older", assigneeType: "USER", assigneeId: user.id, scheduledAt: new Date(now - 60_000).toISOString(), dueAt: new Date(now + 3_600_000).toISOString(), status: "PENDING", completionMode: "MANUAL", fileCheckIntervalMinutes: 5, createdAt: new Date(now - 60_000).toISOString() },
      { id: "overdue", title: "Overdue delivery", instructions: "", serverId: server.id, serverName: server.name, targetPath: "/late", assigneeType: "USER", assigneeId: user.id, scheduledAt: new Date(now - 7_200_000).toISOString(), dueAt: new Date(now - 3_600_000).toISOString(), status: "OVERDUE", completionMode: "MATCHING_UPLOAD", filenameGlob: "late-*.csv", fileCheckIntervalMinutes: 30, createdAt: new Date(now - 120_000).toISOString() },
      { id: "recent", title: "Recent pending", instructions: "", serverId: server.id, serverName: server.name, targetPath: "/recent", assigneeType: "USER", assigneeId: user.id, scheduledAt: new Date(now - 7_200_000).toISOString(), dueAt: new Date(now + 7_200_000).toISOString(), status: "PENDING", completionMode: "MANUAL", fileCheckIntervalMinutes: 5, createdAt: new Date(now).toISOString() },
    ];
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/auth/me") return { user };
      if (path === "/tasks" && !init.method) return { items: taskItems };
      if (path === "/tasks/overdue/check" && init.method === "POST") {
        taskItems = taskItems.map((task) => task.id === "overdue" ? { ...task, lastCheckedAt: new Date().toISOString() } : task);
        return { task: taskItems[1], matched: false };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<TasksPage />);
    const table = await screen.findByRole("table", { name: "Assigned work items" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Overdue delivery")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Recent pending")).toBeInTheDocument();
    expect(rows[0]).toHaveAttribute("data-task-tone", "overdue");
    expect(rows[1]).toHaveAttribute("data-task-tone", "halfway");
    expect(within(rows[1]).getByText("PENDING")).toBeInTheDocument();
    expect(within(rows[1]).queryByText(/half time elapsed/i)).not.toBeInTheDocument();
    expect(within(rows[1]).getByText(/^Due /)).toBeInTheDocument();
    expect(rows[1]).toHaveAccessibleName(/due soon/i);
    expect(within(rows[0]).getByText("Finance SFTP")).toBeInTheDocument();
    expect(within(rows[0]).queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Open folder" }));
    expect(pushMock).toHaveBeenCalledWith("/files?serverId=server-id&path=%2Flate");

    fireEvent.click(within(rows[0]).getByRole("button", { name: "Check folder" }));
    expect(await screen.findByText("Folder checked: no matching file found")).toBeInTheDocument();
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/tasks/overdue/check", { method: "POST" }));
  });
});
