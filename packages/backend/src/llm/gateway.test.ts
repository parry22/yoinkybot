import { describe, expect, it } from "vitest";
import { extractJson, salvageTruncatedJson, asObject } from "./gateway.js";

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

  it("parses JSON with TRAILING prose after the value", () => {
    expect(extractJson('{"reply":"hey"} \n\nHope that helps!')).toEqual({ reply: "hey" });
  });

  it("parses nested structures with trailing prose (brace inside string)", () => {
    expect(extractJson('{"a":{"b":"x } y"},"c":[1]} extra')).toEqual({ a: { b: "x } y" }, c: [1] });
  });

  it("parses an unterminated code fence", () => {
    expect(extractJson('```json\n{"ok":true}')).toEqual({ ok: true });
  });

  it("drops trailing commas", () => {
    expect(extractJson('{"list":[1,2,],}')).toEqual({ list: [1, 2] });
  });
});

describe("salvageTruncatedJson", () => {
  it("closes a structure truncated mid-string", () => {
    expect(salvageTruncatedJson('{"reply":"the take is')).toEqual({ reply: "the take is" });
  });

  it("degrades a truncated array to its complete items", () => {
    const out = salvageTruncatedJson('{"trends":[{"term":"a"},{"term":"b"},{"ter') as {
      trends: Array<{ term: string }>;
    };
    expect(out.trends.length).toBeGreaterThanOrEqual(2);
    expect(out.trends[0]).toEqual({ term: "a" });
    expect(out.trends[1]).toEqual({ term: "b" });
  });

  it("drops a dangling key with no value", () => {
    expect(salvageTruncatedJson('{"a":1,"b":')).toEqual({ a: 1 });
  });

  it("returns undefined when nothing structured exists", () => {
    expect(salvageTruncatedJson("just prose, no json")).toBeUndefined();
  });

  it("handles fenced truncated output", () => {
    expect(salvageTruncatedJson('```json\n{"fires":true,"reply":"go')).toEqual({
      fires: true,
      reply: "go",
    });
  });
});

describe("asObject", () => {
  it("passes a plain object through untouched", () => {
    expect(asObject({ reply: "hi", tool: null })).toEqual({ reply: "hi", tool: null });
  });

  it("unwraps a single-object array (GLM's [{...}] quirk)", () => {
    expect(asObject([{ reply: "hi", tool: null }])).toEqual({ reply: "hi", tool: null });
  });

  it("merges fields split across array elements", () => {
    expect(asObject([{ reply: "on it" }, { tool: { name: "draft" } }])).toEqual({
      reply: "on it",
      tool: { name: "draft" },
    });
  });

  it("leaves a non-object array alone (caller's safeParse then fails cleanly)", () => {
    expect(asObject(["a", "b"])).toEqual(["a", "b"]);
  });

  it("ignores nested arrays and nulls when merging", () => {
    expect(asObject([{ a: 1 }, null, [1, 2], { b: 2 }])).toEqual({ a: 1, b: 2 });
  });

  it("returns primitives untouched", () => {
    expect(asObject("plain")).toBe("plain");
    expect(asObject(null)).toBe(null);
  });
});
