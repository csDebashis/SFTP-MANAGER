import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TasksPage from "./page";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/client", () => ({ api: apiMock }));
vi.mock("@/components/AppShell", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

afterEach(cleanup);

const admin = {
  id: "admin-id",
  email: "admin@gmail.com",
  displayName: "Administrator",
  role: "ADMIN",
  state: "ACTIVE",
  timezone: "UTC",
  version: 1,
};
const user = { ...admin, id: "user-id", email: "user@gmail.com", displayName: "User", role: "USER" };
const server = {
  id: "server-id",
  name: "Finance SFTP",
  description: "",
  host: "mock.local",
  port: 22,
  username: "mock",
  authType: "PASSWORD",
  rootPath: "/",
  hostKeyFingerprint: "mock-local",
  adapterType: "MOCK",
  enabled: true,
  credentialConfigured: true,
  version: 1,
};

describe("Task scheduling", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/tasks" && !init.method) return { items: [] };
      if (path === "/auth/me") return { user: admin };
      if (path === "/users") return { items: [admin, user] };
      if (path === "/sftp-servers") return { items: [server] };
      if (path === "/task-definitions" && !init.method) return { items: [] };
      if (path === "/task-definitions" && init.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.scheduleType).toBe("DAILY");
        expect(body.serverId).toBe("server-id");
        expect(body.assigneeId).toBe("user-id");
        expect(body.targetPath).toBe("/shared");
        expect(body.dueOffsetMinutes).toBe(1440);
        expect(body.startAt).toMatch(/Z$/);
        return { id: "definition-id", ...body, enabled: true, version: 1 };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
  });

  it("offers every repeat option and creates a daily schedule", async () => {
    render(<TasksPage />);

    expect(await screen.findByText("Create task schedule")).toBeInTheDocument();
    const repeat = screen.getByRole("combobox", { name: "Repeat" });
    fireEvent.mouseDown(repeat);
    expect(await screen.findByRole("option", { name: "Once" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Daily" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Weekly" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Monthly" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Daily" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Daily delivery" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Target folder" }), { target: { value: "/shared" } });
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/task-definitions",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(await screen.findByText("Task schedule created")).toBeInTheDocument();
  });

  it("shows filename matching when automatic folder completion is selected", async () => {
    render(<TasksPage />);
    await screen.findByText("Create task schedule");

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Completion" }));
    fireEvent.click(await screen.findByRole("option", { name: "Matching file in folder" }));

    expect(screen.getByRole("textbox", { name: "Filename pattern" })).toBeRequired();
  });
});
