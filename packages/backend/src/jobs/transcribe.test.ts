import { describe, expect, it } from "vitest";
import { TRANSCRIBE_CLAIMABLE } from "./transcribe.js";

describe("transcription claim idempotency", () => {
  it("only allows claiming from pending, received, or failed", () => {
    expect([...TRANSCRIBE_CLAIMABLE]).toEqual(["pending", "received", "failed"]);
  });

  it("excludes in-flight and terminal states", () => {
    for (const status of ["transcribing", "extracting", "processed", "gating"]) {
      expect(TRANSCRIBE_CLAIMABLE.includes(status as never)).toBe(false);
    }
  });
});
