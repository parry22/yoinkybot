import { describe, expect, it } from "vitest";
import { splitForTelegram } from "./bot.js";

describe("splitForTelegram", () => {
  it("returns a short message unchanged", () => {
    expect(splitForTelegram("hello")).toEqual(["hello"]);
  });

  it("never exceeds the cap and covers all content", () => {
    const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i} ${"x".repeat(200)}`).join("\n\n");
    const chunks = splitForTelegram(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    // No content lost (ignoring the join whitespace we split on).
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });

  it("hard-splits a single oversized line with no boundaries", () => {
    const chunks = splitForTelegram("y".repeat(1200), 500);
    expect(chunks).toEqual(["y".repeat(500), "y".repeat(500), "y".repeat(200)]);
  });
});
