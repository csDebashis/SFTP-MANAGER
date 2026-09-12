import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ThemeProvider from "@/theme/ThemeProvider";
import PublicShell from "./PublicShell";

describe("PublicShell", () => {
  it("renders the product and supplied content", () => {
    render(<ThemeProvider><PublicShell title="Sign in" subtitle="Use your account"><button>Continue</button></PublicShell></ThemeProvider>);
    expect(screen.getByRole("heading", { name: "SFTP Manager" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });
});
