import { describe, expect, it } from "vitest";
import { isDue } from "./tick.js";
import type { Automation } from "./types.js";

const auto = (over: Partial<Automation> = {}): Automation => ({
  id: "a",
  user_id: "u",
  profile_id: "u",
  name: "test",
  source_type: "trend_ride",
  delivery_mode: "approval",
  platform: "x",
  enabled: true,
  cadence_kind: "daily",
  cadence_meta: {},
  respect_quiet_hours: true,
  monthly_cap: 30,
  pillar_scope: null,
  warmup_count: 0,
  last_run_at: null,
  created_at: "",
  updated_at: "",
  ...over,
});

// A fixed clock: 2026-07-23 is a Thursday, 14:00 UTC.
const NOW = new Date("2026-07-23T14:00:00Z");

describe("isDue", () => {
  it("manual automations are never auto-due (run-once only)", () => {
    expect(isDue(auto({ cadence_kind: "manual" }), NOW)).toBe(false);
  });

  it("daily is due when it has never run", () => {
    expect(isDue(auto({ cadence_kind: "daily", last_run_at: null }), NOW)).toBe(true);
  });

  it("daily is NOT due again the same UTC day", () => {
    expect(isDue(auto({ last_run_at: "2026-07-23T02:00:00Z" }), NOW)).toBe(false);
  });

  it("daily is due again the next day", () => {
    expect(isDue(auto({ last_run_at: "2026-07-22T23:00:00Z" }), NOW)).toBe(true);
  });

  it("an hour gate holds until that UTC hour", () => {
    expect(isDue(auto({ cadence_meta: { hour: 18 } }), NOW)).toBe(false); // 14:00 < 18:00
    expect(isDue(auto({ cadence_meta: { hour: 9 } }), NOW)).toBe(true); // 14:00 >= 09:00
  });

  it("weekly fires only on its configured weekday", () => {
    expect(isDue(auto({ cadence_kind: "weekly", cadence_meta: { days: ["thu"] } }), NOW)).toBe(true);
    expect(isDue(auto({ cadence_kind: "weekly", cadence_meta: { days: ["mon", "fri"] } }), NOW)).toBe(false);
  });
});
