import { describe, expect, it } from "vitest";
import { nextSlot, specToAutomationInput, describeSpec, EMPTY_SPEC, BRIEF_MAX, type AgentSpec } from "./interview.js";

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({ ...EMPTY_SPEC, ...over });

const full = (): AgentSpec =>
  spec({
    purpose: "keep me visible on pricing",
    postTypes: ["hot take", "teardown"],
    angles: ["saas pricing", "positioning"],
    hooks: ["blunt claim", "a number"],
    source: "trend_ride",
    cadence: "daily",
    delivery: "approval",
    name: "Pricing takes",
  });

describe("nextSlot (code owns the interview order, not the model)", () => {
  it("opens on purpose", () => {
    expect(nextSlot(EMPTY_SPEC)?.key).toBe("purpose");
  });

  // The order matters: the three writing slots come before the operational ones,
  // because they are what decide whether the agent's output is any good.
  it("asks the writing slots before cadence and delivery", () => {
    expect(nextSlot(spec({ purpose: "x" }))?.key).toBe("postTypes");
    expect(nextSlot(spec({ purpose: "x", postTypes: ["hot take"] }))?.key).toBe("angles");
    expect(nextSlot(spec({ purpose: "x", postTypes: ["a"], angles: ["b"] }))?.key).toBe("hooks");
    expect(nextSlot(spec({ purpose: "x", postTypes: ["a"], angles: ["b"], hooks: ["c"] }))?.key).toBe("source");
  });

  it("treats an empty list as unanswered", () => {
    expect(nextSlot(spec({ purpose: "x", postTypes: [] }))?.key).toBe("postTypes");
  });

  it("never asks for a name — it's inferred, not interviewed", () => {
    const keys: string[] = [];
    let s = EMPTY_SPEC;
    for (let i = 0; i < 20; i++) {
      const slot = nextSlot(s);
      if (!slot) break;
      keys.push(String(slot.key));
      // Fill it and move on.
      s = { ...s, [slot.key]: Array.isArray(s[slot.key]) ? ["filled"] : "filled" } as AgentSpec;
    }
    expect(keys).not.toContain("name");
  });

  it("is complete once every asked slot is filled", () => {
    expect(nextSlot(full())).toBeNull();
  });

  it("stays incomplete when only the operational slots are missing", () => {
    expect(nextSlot(spec({ ...full(), cadence: null }))?.key).toBe("cadence");
  });
});

describe("specToAutomationInput", () => {
  it("folds the writing slots into the brief the draft path actually reads", () => {
    const input = specToAutomationInput(full());
    expect(input.brief).toContain("keep me visible on pricing");
    expect(input.brief).toContain("hot take");
    expect(input.brief).toContain("saas pricing");
    expect(input.brief).toContain("blunt claim");
  });

  it("carries the config slots straight through", () => {
    const input = specToAutomationInput(full());
    expect(input.sourceType).toBe("trend_ride");
    expect(input.cadenceKind).toBe("daily");
    expect(input.deliveryMode).toBe("approval");
    expect(input.name).toBe("Pricing takes");
  });

  it("uses the angles as the pillar scope, so the run pipeline can constrain the seed", () => {
    expect(specToAutomationInput(full()).pillarScope).toEqual(["saas pricing", "positioning"]);
  });

  it("falls back to safe defaults rather than producing an unbuildable input", () => {
    const input = specToAutomationInput(EMPTY_SPEC);
    expect(input.sourceType).toBe("custom");
    expect(input.deliveryMode).toBe("approval");
    expect(input.cadenceKind).toBe("daily");
    expect(input.name).toBe("Auto agent");
    expect(input.pillarScope).toBeNull();
  });

  it("names the agent from its purpose when no name was inferred", () => {
    expect(specToAutomationInput(spec({ ...full(), name: null })).name).toBe("keep me visible on pricing");
  });

  it("keeps the brief inside the column ceiling", () => {
    const long = specToAutomationInput(
      spec({
        purpose: "x".repeat(3000),
        postTypes: ["a"],
        angles: ["b"],
        hooks: ["c"],
      }),
    );
    expect(long.brief.length).toBeLessThanOrEqual(BRIEF_MAX);
  });
});

describe("describeSpec", () => {
  it("reads as a sentence about what was built", () => {
    const text = describeSpec(full());
    expect(text).toContain("hot take");
    expect(text).toContain("saas pricing");
    expect(text).toContain("checks daily");
    expect(text).toContain("asks you first");
  });

  it("says so when the agent posts unattended", () => {
    expect(describeSpec(spec({ ...full(), delivery: "auto" }))).toContain("posts on its own");
  });

  it("degrades without throwing on an empty spec", () => {
    expect(() => describeSpec(EMPTY_SPEC)).not.toThrow();
  });
});
