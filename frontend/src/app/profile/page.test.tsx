import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProfilePage from "./page";

const apiMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());

afterEach(cleanup);

vi.mock("@/api/client", () => ({ api: apiMock }));
vi.mock("@/components/AppShell", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: replaceMock }) }));

const user = {
  id: "signup-generated-user-id",
  email: "user@gmail.com",
  displayName: "Mock User",
  role: "USER",
  state: "ACTIVE",
  timezone: "UTC",
  version: 1,
};

describe("Profile identity editing", () => {
  beforeEach(() => {
    apiMock.mockReset();
    replaceMock.mockReset();
    apiMock.mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/auth/me") return { user };
      if (path === "/users/signup-generated-user-id" && init.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ displayName: "Updated User", email: "updated@gmail.com" });
        return { ...user, ...body, version: 2 };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
  });

  it("updates the signed-in user's name and email by immutable user ID", async () => {
    render(<ProfilePage />);

    expect(await screen.findByText("User ID: signup-generated-user-id")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Username / display name" }), { target: { value: "Updated User" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: "updated@gmail.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/users/signup-generated-user-id",
      expect.objectContaining({ method: "PATCH" }),
    ));
    expect(await screen.findByText("Profile updated")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue("updated@gmail.com");
  });
});
