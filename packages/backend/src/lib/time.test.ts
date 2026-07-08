import { describe, expect, it } from "vitest";
import { inQuietHours } from "./time.js";

describe("inQuietHours", () => {
  const settings = { quiet_hours: { start: "22:00", end: "08:00", tz: "UTC" } };

  it("inside a midnight-wrapping window", () => {
    expect(inQuietHours(settings, new Date("2026-07-03T23:30:00Z"))).toBe(true);
    expect(inQuietHours(settings, new Date("2026-07-03T03:00:00Z"))).toBe(true);
  });

  it("outside the window", () => {
    expect(inQuietHours(settings, new Date("2026-07-03T12:00:00Z"))).toBe(false);
    expect(inQuietHours(settings, new Date("2026-07-03T08:00:00Z"))).toBe(false);
  });

  it("non-wrapping window", () => {
    const s = { quiet_hours: { start: "09:00", end: "17:00", tz: "UTC" } };
    expect(inQuietHours(s, new Date("2026-07-03T10:00:00Z"))).toBe(true);
    expect(inQuietHours(s, new Date("2026-07-03T18:00:00Z"))).toBe(false);
  });

  it("respects the timezone", () => {
    const ist = { quiet_hours: { start: "22:00", end: "08:00", tz: "Asia/Kolkata" } };
    // 18:00 UTC = 23:30 IST → quiet
    expect(inQuietHours(ist, new Date("2026-07-03T18:00:00Z"))).toBe(true);
    // 09:00 UTC = 14:30 IST → not quiet
    expect(inQuietHours(ist, new Date("2026-07-03T09:00:00Z"))).toBe(false);
  });

  it("no quiet hours configured → never quiet", () => {
    expect(inQuietHours({}, new Date())).toBe(false);
  });

  it("malformed times fail open (deliver rather than silently stall)", () => {
    expect(inQuietHours({ quiet_hours: { start: "bogus", end: "08:00" } }, new Date())).toBe(false);
  });
});
