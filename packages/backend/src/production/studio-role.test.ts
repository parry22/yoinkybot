import { describe, expect, it } from "vitest";
import { roleAtLeast } from "../workspaces/permissions.js";

describe("Studio editor gate", () => {
  it("requires at least editor role for generation paths", () => {
    expect(roleAtLeast("editor", "editor")).toBe(true);
    expect(roleAtLeast("contributor", "editor")).toBe(false);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(roleAtLeast("strategist", "editor")).toBe(true);
    expect(roleAtLeast("admin", "editor")).toBe(true);
  });
});
