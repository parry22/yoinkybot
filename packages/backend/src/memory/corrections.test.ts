import { describe, expect, it } from "vitest";
import { encodeCorrection, decodeCorrection, CORRECTION_FIELD_VALUES, buildCalibrationNote } from "./corrections.js";

describe("encodeCorrection / decodeCorrection", () => {
  it("round-trips every value for every field", () => {
    for (const field of ["rhetorical_mode", "sincerity_register", "motive"] as const) {
      for (const value of CORRECTION_FIELD_VALUES[field]) {
        const code = encodeCorrection(field, value);
        expect(code).not.toBeNull();
        expect(decodeCorrection(code!)).toEqual({ field, value });
      }
    }
  });

  it("returns null for a value not in the field's list", () => {
    expect(encodeCorrection("sincerity_register", "not-a-real-value")).toBeNull();
  });

  it("stays well under Telegram's 64-byte callback_data limit", () => {
    const uuid = "0123456789ab-cdef-0123-4567-89abcdef0123";
    for (const field of ["rhetorical_mode", "sincerity_register", "motive"] as const) {
      for (const value of CORRECTION_FIELD_VALUES[field]) {
        const code = encodeCorrection(field, value)!;
        const callbackData = `corr:${uuid}:${code}`;
        expect(Buffer.byteLength(callbackData, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });

  it("decode rejects an unknown field code or out-of-range index", () => {
    expect(decodeCorrection("x0")).toBeNull();
    expect(decodeCorrection("s99")).toBeNull();
  });
});

describe("buildCalibrationNote", () => {
  it("returns null with no corrections", () => {
    expect(buildCalibrationNote([])).toBeNull();
  });

  it("names the most-corrected-to value and the count", () => {
    const note = buildCalibrationNote([
      { field: "sincerity_register", corrected_value: "ironic" },
      { field: "sincerity_register", corrected_value: "ironic" },
      { field: "sincerity_register", corrected_value: "absurdist" },
    ]);
    expect(note).toContain("sincerity was corrected 3 times");
    expect(note).toContain('most often to "ironic" (2x)');
  });

  it("covers multiple fields in one note", () => {
    const note = buildCalibrationNote([
      { field: "sincerity_register", corrected_value: "ironic" },
      { field: "motive", corrected_value: "personal_processing" },
    ]);
    expect(note).toContain("sincerity was corrected 1 time");
    expect(note).toContain("motive was corrected 1 time");
  });
});
