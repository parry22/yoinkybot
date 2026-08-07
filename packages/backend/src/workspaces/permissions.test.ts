import { describe, expect, it } from "vitest";
import { assertWorkspaceRole, roleAtLeast, WorkspaceAccessError } from "./permissions.js";

describe("workspace permissions", () => {
  it("allows higher roles to satisfy lower requirements", () => {
    expect(roleAtLeast("owner", "viewer")).toBe(true);
    expect(roleAtLeast("strategist", "editor")).toBe(true);
    expect(roleAtLeast("editor", "strategist")).toBe(false);
  });

  it("denies missing memberships instead of falling back", () => {
    expect(() => assertWorkspaceRole(null, "viewer")).toThrow(WorkspaceAccessError);
  });

  it("denies members below the requested role", () => {
    expect(() => assertWorkspaceRole("contributor", "editor")).toThrow(WorkspaceAccessError);
  });
});

