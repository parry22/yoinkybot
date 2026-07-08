import { describe, expect, it } from "vitest";
import { extractJson } from "./gateway.js";

describe("extractJson", () => {
  it("parses clean JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses fenced JSON", () => {
    expect(extractJson('Here you go:\n```json\n{"facts":[]}\n```')).toEqual({ facts: [] });
  });

  it("parses JSON with leading prose", () => {
    expect(extractJson('Sure! {"answer":"x","cited_memory_ids":[]}')).toEqual({
      answer: "x",
      cited_memory_ids: [],
    });
  });

  it("parses a bare array", () => {
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});
