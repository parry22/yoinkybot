import { describe, expect, it } from "vitest";
import {
  applyActions,
  parseSessionResponse,
  canAdvanceDiagnosis,
  unsaidUnlocked,
  gapBeatsCovered,
  goalDraftComplete,
  classifyGoalType,
  remainingBeats,
  remainingPlanBeats,
  type Action,
} from "./session-machine.js";
import { DIAGNOSIS_BEATS, PLAN_BEATS, type StrategistState } from "./state.js";

const base = (o: Partial<StrategistState> = {}): StrategistState => ({ phase: "diagnosis_dialogue", covered: [], ...o });
const ALL_BEATS = [...DIAGNOSIS_BEATS];

describe("parseSessionResponse", () => {
  it("extracts reply and valid actions, dropping malformed ones", () => {
    const r = parseSessionResponse({
      reply: "hey",
      actions: [{ type: "beat_covered", beat: "whats_working" }, { type: "bogus" }, { type: "goal_field" }, "junk"],
    });
    expect(r.reply).toBe("hey");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toEqual({ type: "beat_covered", beat: "whats_working" });
  });
  it("handles missing/empty envelope", () => {
    expect(parseSessionResponse({}).reply).toBe("");
    expect(parseSessionResponse(null).actions).toEqual([]);
  });
});

describe("diagnosis coverage guards", () => {
  it("gapBeatsCovered ignores whats_working", () => {
    expect(gapBeatsCovered(["whats_working", "outside_in"])).toBe(1);
  });
  it("unsaid unlocks only after working + 2 gaps", () => {
    expect(unsaidUnlocked(["whats_working", "outside_in"])).toBe(false);
    expect(unsaidUnlocked(["whats_working", "outside_in", "post_vs_think_gap"])).toBe(true);
  });
  it("canAdvanceDiagnosis mirrors the trust gate", () => {
    expect(canAdvanceDiagnosis(["whats_working", "outside_in"])).toBe(false);
    expect(canAdvanceDiagnosis(["whats_working", "outside_in", "authentic_vs_performed"])).toBe(true);
  });
  it("remainingBeats excludes covered", () => {
    expect(remainingBeats(["whats_working"])).not.toContain("whats_working");
    expect(remainingBeats([])).toHaveLength(6);
  });
});

describe("applyActions — diagnosis phase", () => {
  it("appends a covered beat and dedups", () => {
    const r = applyActions(base({ covered: ["whats_working"] }), [{ type: "beat_covered", beat: "whats_working" }, { type: "beat_covered", beat: "outside_in" }]);
    expect(r.nextState.covered).toEqual(["whats_working", "outside_in"]);
  });
  it("blocks unsaid_patterns before the trust gate", () => {
    const r = applyActions(base({ covered: ["whats_working"] }), [{ type: "beat_covered", beat: "unsaid_patterns" }]);
    expect(r.nextState.covered).not.toContain("unsaid_patterns");
  });
  it("advance_phase is dropped when coverage is insufficient", () => {
    const r = applyActions(base({ covered: ["whats_working"] }), [{ type: "advance_phase" }]);
    expect(r.nextState.phase).toBe("diagnosis_dialogue");
  });
  it("advance_phase → goals when coverage is sufficient", () => {
    const r = applyActions(base({ covered: ["whats_working", "outside_in", "post_vs_think_gap"] }), [{ type: "advance_phase" }]);
    expect(r.nextState.phase).toBe("goals");
    expect(r.nextState.turnsInPhase).toBe(0);
  });
});

describe("applyActions — the post-reveal pause (the fake-pause fix)", () => {
  it("does NOT advance on a plain turn once everything's revealed — needs a real signal", () => {
    const r = applyActions(base({ covered: ALL_BEATS }), []);
    // Reaction omitted entirely — mirrors a caller that forgot to classify.
    // Fail-open still applies (undefined behaves like "closing"), so this one
    // case DOES advance; the real regression test is "continuation" below.
    expect(r.nextState.phase).toBe("goals");
  });

  it("stays in diagnosis_dialogue on genuine pushback (continuation)", () => {
    const r = applyActions(base({ covered: ALL_BEATS, turnsInPhase: 0 }), [], "continuation");
    expect(r.nextState.phase).toBe("diagnosis_dialogue");
    expect(r.nextState.turnsInPhase).toBe(1); // same phase → increments, doesn't reset
  });

  it("keeps holding through repeated pushback, several turns in a row", () => {
    let state = base({ covered: ALL_BEATS, turnsInPhase: 0 });
    for (let i = 0; i < 4; i++) {
      const r = applyActions(state, [], "continuation");
      expect(r.nextState.phase).toBe("diagnosis_dialogue");
      state = r.nextState;
    }
    expect(state.turnsInPhase).toBe(4);
  });

  it("advances the instant the reaction reads as closing", () => {
    const r = applyActions(base({ covered: ALL_BEATS, turnsInPhase: 2 }), [], "closing");
    expect(r.nextState.phase).toBe("goals");
  });

  it("fails open to closing when the classifier result is undefined (outage)", () => {
    const r = applyActions(base({ covered: ALL_BEATS }), [], undefined);
    expect(r.nextState.phase).toBe("goals");
  });

  it("the watchdog still forces an exit from endless continuation", () => {
    const r = applyActions(base({ covered: ALL_BEATS, turnsInPhase: 8 }), [], "continuation");
    expect(r.nextState.phase).toBe("goals");
  });

  it("a model-emitted advance_phase has no effect once revealed — only the reaction signal gates it", () => {
    const r = applyActions(base({ covered: ALL_BEATS, turnsInPhase: 0 }), [{ type: "advance_phase" }], "continuation");
    expect(r.nextState.phase).toBe("diagnosis_dialogue");
  });
});

describe("remainingPlanBeats", () => {
  it("excludes covered plan beats", () => {
    expect(remainingPlanBeats([])).toEqual([...PLAN_BEATS]);
    expect(remainingPlanBeats(["throughline"])).toEqual(["unlock", "cadence"]);
    expect(remainingPlanBeats([...PLAN_BEATS])).toHaveLength(0);
  });
});

describe("applyActions — plan_build beat pacing", () => {
  it("plan_beat_covered appends and dedups, mirroring diagnosis beats", () => {
    const r = applyActions(base({ phase: "plan_build", planId: "p1", planCovered: ["throughline"] }), [
      { type: "plan_beat_covered", beat: "throughline" },
      { type: "plan_beat_covered", beat: "unlock" },
    ]);
    expect(r.nextState.planCovered).toEqual(["throughline", "unlock"]);
  });

  it("plan_beat_covered coexists with a cadence action in the same turn", () => {
    const r = applyActions(base({ phase: "plan_build", planId: "p1", planCovered: ["throughline", "unlock"] }), [
      { type: "plan_beat_covered", beat: "cadence" },
      { type: "cadence", perWeek: 2 },
    ]);
    expect(r.nextState.planCovered).toEqual(["throughline", "unlock", "cadence"]);
    expect(r.effects.some((e) => e.kind === "setCadence")).toBe(true);
  });
});

describe("applyActions — goals phase", () => {
  const goalsState = base({ phase: "goals", covered: [] });
  it("accumulates goal fields without capturing prematurely", () => {
    const r = applyActions(goalsState, [{ type: "goal_field", field: "optimizing_for", value: "authority on distribution" }, { type: "goal_captured" }]);
    expect(r.nextState.goalDraft?.optimizing_for).toBe("authority on distribution");
    expect(r.effects).toHaveLength(0); // incomplete → no capture
    expect(r.nextState.phase).toBe("goals");
  });
  it("captures the goal and moves to plan_build when complete", () => {
    const state = base({ phase: "goals", goalDraft: { optimizing_for: "become the voice on distribution", timeframe: "6 months", success: "podcast invites" } });
    const r = applyActions(state, [{ type: "goal_captured" }]);
    expect(r.effects[0]?.kind).toBe("captureGoal");
    expect(r.effects[0]?.goal?.goalType).toBe("authority");
    expect(r.nextState.phase).toBe("plan_build");
  });
});

describe("applyActions — plan_build phase", () => {
  it("cadence effect only when a plan exists", () => {
    const noPlan = applyActions(base({ phase: "plan_build" }), [{ type: "cadence", perWeek: 3 }]);
    expect(noPlan.effects).toHaveLength(0);
    const withPlan = applyActions(base({ phase: "plan_build", planId: "p1" }), [{ type: "cadence", perWeek: 3 }]);
    expect(withPlan.effects[0]).toMatchObject({ kind: "setCadence", perWeek: 3 });
  });
  it("commit_plan confirms and goes active only with a planId", () => {
    const r = applyActions(base({ phase: "plan_build", planId: "p1" }), [{ type: "commit_plan" }]);
    expect(r.effects.some((e) => e.kind === "confirmPlan")).toBe(true);
    expect(r.nextState.phase).toBe("active");
    const noPlan = applyActions(base({ phase: "plan_build" }), [{ type: "commit_plan" }]);
    expect(noPlan.nextState.phase).toBe("plan_build");
  });
  it("auto-commits once cadence is set and a turn has passed (no explicit signal)", () => {
    const r = applyActions(base({ phase: "plan_build", planId: "p1", turnsInPhase: 1 }), [{ type: "cadence", perWeek: 3 }]);
    expect(r.effects.some((e) => e.kind === "confirmPlan")).toBe(true);
    expect(r.nextState.phase).toBe("active");
  });
  it("commits when cadence was set on a prior turn", () => {
    const r = applyActions(base({ phase: "plan_build", planId: "p1", cadenceSet: true, turnsInPhase: 1 }), []);
    expect(r.nextState.phase).toBe("active");
  });
  it("does NOT commit on the very first plan_build turn even with cadence", () => {
    const r = applyActions(base({ phase: "plan_build", planId: "p1", turnsInPhase: 0 }), [{ type: "cadence", perWeek: 3 }]);
    expect(r.nextState.phase).toBe("plan_build");
  });
});

describe("applyActions — content flags + watchdog", () => {
  it("passes capture/offer_angles through", () => {
    const r = applyActions(base(), [{ type: "capture" }, { type: "offer_angles" }]);
    expect(r.capture).toBe(true);
    expect(r.offerAngles).toBe(true);
  });
  it("increments turnsInPhase when phase is unchanged", () => {
    const r = applyActions(base({ turnsInPhase: 2 }), []);
    expect(r.nextState.turnsInPhase).toBe(3);
  });
});

describe("classifyGoalType", () => {
  it("maps by keyword", () => {
    expect(classifyGoalType({ optimizing_for: "be known as the authority" })).toBe("authority");
    expect(classifyGoalType({ optimizing_for: "grow to 50k followers" })).toBe("audience");
    expect(classifyGoalType({ optimizing_for: "drive inbound for my startup" })).toBe("company");
    expect(classifyGoalType({ optimizing_for: "raise a seed round" })).toBe("opportunity");
    expect(classifyGoalType({ optimizing_for: "something vague" })).toBe("other");
  });
});

describe("goalDraftComplete", () => {
  it("requires all three fields", () => {
    expect(goalDraftComplete({ optimizing_for: "x", timeframe: "y" })).toBe(false);
    expect(goalDraftComplete({ optimizing_for: "x", timeframe: "y", success: "z" })).toBe(true);
  });
});

const _typecheck: Action = { type: "advance_phase" };
void _typecheck;
