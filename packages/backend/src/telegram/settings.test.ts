import { describe, expect, it } from "vitest";
import { parseSettingsCommand, validTimezone } from "./settings.js";

describe("parseSettingsCommand", () => {
  it("bare → show", () => {
    expect(parseSettingsCommand("")).toEqual({ kind: "show" });
  });

  it("quiet hours in common formats", () => {
    expect(parseSettingsCommand("quiet 22:00-08:00")).toEqual({ kind: "quiet", start: "22:00", end: "08:00" });
    expect(parseSettingsCommand("quiet 23:30 to 7:00")).toEqual({ kind: "quiet", start: "23:30", end: "7:00" });
    expect(parseSettingsCommand("quiet off")).toEqual({ kind: "quiet_off" });
  });

  it("timezone validated via Intl", () => {
    expect(parseSettingsCommand("timezone Asia/Kolkata")).toEqual({ kind: "timezone", tz: "Asia/Kolkata" });
    expect(parseSettingsCommand("tz UTC")).toEqual({ kind: "timezone", tz: "UTC" });
    expect(parseSettingsCommand("timezone Mars/Olympus")).toBeNull();
  });

  it("frequency bounded 0-7", () => {
    expect(parseSettingsCommand("frequency 2")).toEqual({ kind: "frequency", perWeek: 2 });
    expect(parseSettingsCommand("freq 0")).toEqual({ kind: "frequency", perWeek: 0 });
    expect(parseSettingsCommand("frequency 9")).toBeNull();
  });

  it("garbage → null", () => {
    expect(parseSettingsCommand("make it louder")).toBeNull();
  });
});

describe("validTimezone", () => {
  it("accepts IANA names, rejects nonsense", () => {
    expect(validTimezone("Asia/Kolkata")).toBe(true);
    expect(validTimezone("not-a-tz")).toBe(false);
  });
});
