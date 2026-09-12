import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProfilePage from "./page";

const apiMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());

afterEach(cleanup);
vi.mock("@/api/client", () => ({ api: apiMock }));
vi.mock("@/components/AppShell", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: replaceMock }) }));

const user = { id: "signup-generated-user-id", email: "user@gmail.com", displayName: "Mock User", role: "USER", state: "ACTIVE", timezone: "UTC", version: 1 };

describe("Profile and security dialogs", () => {
  beforeEach(() => {
    apiMock.mockReset(); replaceMock.mockReset();
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/auth/me") return { user };
      if (path === "/users/signup-generated-user-id" && init.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ displayName: "Updated User", email: "updated@gmail.com" });
        return { ...user, ...body, version: 2 };
      }
      if (path === "/auth/password/change" && init.method === "POST") return {};
      throw new Error(`Unexpected API request: ${path}`);
    });
  });

  it("keeps forms closed until requested and edits identity by immutable user ID", async () => {
    render(<ProfilePage />);
    expect(await screen.findByText("signup-generated-user-id")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Username / display name" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit account details" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit account details" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Username / display name" }), { target: { value: "Updated User" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Email" }), { target: { value: "updated@gmail.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/users/signup-generated-user-id", expect.objectContaining({ method: "PATCH" })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit account details" })).not.toBeInTheDocument());
    expect(await screen.findByText("Profile updated")).toBeInTheDocument();
    expect(screen.getByText("updated@gmail.com")).toBeInTheDocument();
  });

  it("keeps API errors in the active popup and clears them when a different form opens", async () => {
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/auth/me") return { user };
      if (path === "/users/signup-generated-user-id" && init.method === "PATCH") throw new Error("Email is already in use");
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<ProfilePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit account details" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit account details" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText("Email is already in use")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit account details" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    dialog = await screen.findByRole("dialog", { name: "Change password" });
    expect(within(dialog).queryByText("Email is already in use")).not.toBeInTheDocument();
  });

  it("opens password change in a popup and keeps validation errors inside it", async () => {
    render(<ProfilePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Change password" }));
    const dialog = await screen.findByRole("dialog", { name: "Change password" });
    const passwordInputs = dialog.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect(passwordInputs).toHaveLength(3);
    fireEvent.change(passwordInputs[0], { target: { value: "OldPassword123!" } });
    fireEvent.change(passwordInputs[1], { target: { value: "NewPassword123!" } });
    fireEvent.change(passwordInputs[2], { target: { value: "DifferentPassword123!" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change password" }));
    expect(await within(dialog).findByText("New passwords do not match")).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
  });
});
