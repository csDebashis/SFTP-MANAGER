import { describe, expect, it } from "vitest";
import { demoCredentialsVisible } from "./deployment";

describe("demoCredentialsVisible", () => {
  it("uses the explicit deployment mode", () => {
    expect(demoCredentialsVisible({ DEPLOYMENT_MODE: "demo", SEED_DEMO_USERS: "false" })).toBe(true);
    expect(demoCredentialsVisible({ DEPLOYMENT_MODE: "production", SEED_DEMO_USERS: "true" })).toBe(false);
  });

  it("keeps compatibility with the existing seed switch", () => {
    expect(demoCredentialsVisible({ SEED_DEMO_USERS: "true" })).toBe(true);
    expect(demoCredentialsVisible({ SEED_DEMO_USERS: "false" })).toBe(false);
    expect(demoCredentialsVisible({})).toBe(true);
  });

  it("fails closed for an unknown explicit mode", () => {
    expect(demoCredentialsVisible({ DEPLOYMENT_MODE: "staging" })).toBe(false);
  });
});
