import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginForm from "./LoginForm";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

afterEach(cleanup);

describe("LoginForm", () => {
  it("starts with empty credential fields and shows usable demo accounts in demo mode", () => {
    render(<LoginForm showDemoCredentials />);

    expect(screen.getByRole("textbox", { name: /Email/ })).toHaveValue("");
    expect(document.querySelector('input[type="password"]')).toHaveValue("");
    expect(screen.getByLabelText("Demo login credentials")).toHaveTextContent(
      "admin@example.com / Admin123!Secure",
    );
    expect(screen.getByLabelText("Demo login credentials")).toHaveTextContent(
      "user@example.com / User123!Secure",
    );
  });

  it("does not expose demo accounts in production mode", () => {
    render(<LoginForm showDemoCredentials={false} />);

    expect(screen.queryByLabelText("Demo login credentials")).not.toBeInTheDocument();
    expect(screen.queryByText(/Admin123!Secure/)).not.toBeInTheDocument();
    expect(screen.queryByText(/User123!Secure/)).not.toBeInTheDocument();
  });
});
