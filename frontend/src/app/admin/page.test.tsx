import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminPage from "./page";

const apiMock = vi.hoisted(() => vi.fn());

afterEach(cleanup);

vi.mock("@/api/client", () => ({ api: apiMock }));
vi.mock("@/components/AppShell", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const admin = {
  id: "admin-id",
  email: "admin@gmail.com",
  displayName: "Mock Administrator",
  role: "ADMIN",
  state: "ACTIVE",
  timezone: "UTC",
  version: 1,
};

const server = {
  id: "server-id",
  name: "Mock SFTP",
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

const user = {
  id: "user-id",
  email: "user@gmail.com",
  displayName: "Mock User",
  role: "USER",
  state: "ACTIVE",
  timezone: "UTC",
  version: 1,
};

const group = {
  id: "group-id",
  name: "Finance",
  description: "Finance users",
  memberIds: [user.id],
  version: 1,
};

const grant = {
  id: "grant-id",
  principalType: "GROUP",
  principalId: group.id,
  principalName: group.name,
  serverId: server.id,
  serverName: server.name,
  path: "/finance",
  permissions: ["DOWNLOAD", "LIST"],
  recursive: true,
  version: 1,
};

describe("Admin server feedback", () => {
  beforeEach(() => {
    let createAttempts = 0;
    let created = false;
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/auth/me") return { user: admin };
      if (path === "/users") return { items: [admin] };
      if (path === "/access-grants" || path === "/groups") return { items: [] };
      if (path === "/sftp-servers" && init.method === "POST") {
        createAttempts += 1;
        if (createAttempts === 1) throw new Error("A server with this name already exists");
        created = true;
        return server;
      }
      if (path === "/sftp-servers") return { items: created ? [server] : [] };
      throw new Error(`Unexpected API request: ${path}`);
    });
  });

  it("replaces a failed add message with an intuitive success state after retry", async () => {
    render(<AdminPage />);

    fireEvent.click(await screen.findByRole("tab", { name: "Servers (0)" }));
    fireEvent.click(screen.getByRole("button", { name: "Add SFTP server" }));
    const addDialog = await screen.findByRole("dialog", { name: "Add SFTP server" });
    fireEvent.change(within(addDialog).getByRole("textbox", { name: "Display name" }), { target: { value: "Mock SFTP" } });
    fireEvent.change(within(addDialog).getByRole("textbox", { name: "Host" }), { target: { value: "mock.local" } });
    const passwordInput = addDialog.querySelector<HTMLInputElement>('input[type="password"]');
    expect(passwordInput).not.toBeNull();
    fireEvent.change(passwordInput!, { target: { value: "test-password" } });

    fireEvent.click(screen.getByRole("button", { name: "Connect and add server" }));
    expect(await screen.findByText("A server with this name already exists")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), { target: { value: "Corrected SFTP" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and add server" }));

    await waitFor(() => expect(screen.queryByText("A server with this name already exists")).not.toBeInTheDocument());
    expect(await screen.findByText("SFTP server connected and added")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add SFTP server" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add SFTP server" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Mock SFTP" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Servers (1)" })).toBeInTheDocument();
  });
});

describe("Administration create dialogs", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/auth/me") return { user: admin };
      if (path === "/users") return { items: [admin, user] };
      if (path === "/sftp-servers") return { items: [server] };
      if (path === "/access-grants") return { items: [grant] };
      if (path === "/groups") return { items: [group] };
      throw new Error(`Unexpected API request: ${path}`);
    });
  });

  it("opens folder-grant creation in a dialog", async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Access (1)" }));
    expect(screen.queryByRole("dialog", { name: "Add folder grant" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add folder grant" }));
    expect(await screen.findByRole("dialog", { name: "Add folder grant" })).toBeInTheDocument();
  });

  it("opens group creation in a dialog with searchable multi-select members", async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Groups (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Create group" }));
    const dialog = await screen.findByRole("dialog", { name: "Create group" });
    const memberSearch = within(dialog).getByRole("combobox", { name: "Members" });
    fireEvent.change(memberSearch, { target: { value: "user@gmail" } });
    fireEvent.click(await screen.findByRole("option", { name: "Mock User (user@gmail.com)" }));
    expect(within(dialog).getByText("1 member selected")).toBeInTheDocument();
  });
});

describe("Administration edit dialogs", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  function initialData(path: string) {
    if (path === "/auth/me") return { user: admin };
    if (path === "/users") return { items: [admin, user] };
    if (path === "/sftp-servers") return { items: [server] };
    if (path === "/access-grants") return { items: [grant] };
    if (path === "/groups") return { items: [group] };
    return undefined;
  }

  it("identifies the group and server on an access row and keeps edit errors inside its modal", async () => {
    let patchAttempts = 0;
    let resolveRetry!: (value: unknown) => void;
    apiMock.mockImplementation((path: string, init: RequestInit = {}) => {
      const initial = initialData(path);
      if (initial && init.method !== "PATCH") return Promise.resolve(initial);
      if (path === "/access-grants/grant-id" && init.method === "PATCH") {
        patchAttempts += 1;
        if (patchAttempts === 1) return Promise.reject(new Error("Folder path is unavailable"));
        return new Promise((resolve) => { resolveRetry = resolve; });
      }
      return Promise.reject(new Error(`Unexpected API request: ${path}`));
    });

    render(<AdminPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Access (1)" }));

    expect(screen.getByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("Mock SFTP · /finance and child folders")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit group Finance access" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit folder access" });
    const dialogButtons = within(dialog).getAllByRole("button");
    expect(dialogButtons.at(-2)).toHaveTextContent("Save changes");
    expect(dialogButtons.at(-1)).toHaveTextContent("Cancel");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(await within(dialog).findByText("Folder path is unavailable")).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(within(dialog).queryByText("Folder path is unavailable")).not.toBeInTheDocument();

    await act(async () => { resolveRetry(grant); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit folder access" })).not.toBeInTheDocument());
    expect(await screen.findByText("Folder access updated")).toBeInTheDocument();
  });

  it("opens user, server, and group edits in dedicated modal forms", async () => {
    apiMock.mockImplementation(async (path: string) => {
      const initial = initialData(path);
      if (initial) return initial;
      throw new Error(`Unexpected API request: ${path}`);
    });

    render(<AdminPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit admin@gmail.com" }));
    expect(await screen.findByRole("dialog", { name: "Edit user" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit user" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "Servers (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Mock SFTP" }));
    expect(await screen.findByRole("dialog", { name: "Edit SFTP server" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit SFTP server" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "Groups (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Finance" }));
    expect(await screen.findByRole("dialog", { name: "Edit group" })).toBeInTheDocument();
  });

  it("updates a user's display name and email through the generated user ID", async () => {
    let storedUser = user;
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/auth/me") return { user: admin };
      if (path === "/users/user-id" && init.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        storedUser = { ...storedUser, displayName: body.displayName, email: body.email, version: 2 };
        return storedUser;
      }
      if (path === "/users") return { items: [admin, storedUser] };
      if (path === "/sftp-servers") return { items: [server] };
      if (path === "/access-grants") return { items: [grant] };
      if (path === "/groups") return { items: [group] };
      throw new Error(`Unexpected API request: ${path}`);
    });

    render(<AdminPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit user@gmail.com" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit user" });
    expect(within(dialog).getByText("User ID: user-id")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Display name" }), { target: { value: "Renamed User" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Email" }), { target: { value: "renamed@gmail.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/users/user-id", expect.objectContaining({ method: "PATCH" })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit user" })).not.toBeInTheDocument());
    expect(await screen.findByText("Renamed User")).toBeInTheDocument();
    expect(screen.getByText("renamed@gmail.com · USER")).toBeInTheDocument();
    expect(screen.getByText("renamed@gmail.com updated")).toBeInTheDocument();
  });
});

describe("Administration server deletion", () => {
  it("confirms and refreshes servers and associated access after a cascade delete", async () => {
    let deleted = false;
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/auth/me") return { user: admin };
      if (path === "/users") return { items: [admin, user] };
      if (path === "/groups") return { items: [group] };
      if (path === "/sftp-servers/server-id" && init.method === "DELETE") {
        deleted = true;
        return undefined;
      }
      if (path === "/sftp-servers") return { items: deleted ? [] : [server] };
      if (path === "/access-grants") return { items: deleted ? [] : [grant] };
      throw new Error(`Unexpected API request: ${path}`);
    });

    render(<AdminPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Servers (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Mock SFTP" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete SFTP server" });
    expect(within(dialog).getByText(/folder-access grants, tasks, encrypted credential/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete server" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/sftp-servers/server-id", { method: "DELETE" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete SFTP server" })).not.toBeInTheDocument());
    expect(await screen.findByText("Mock SFTP and associated configuration deleted")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Servers (0)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Access (0)" })).toBeInTheDocument();
  });
});
