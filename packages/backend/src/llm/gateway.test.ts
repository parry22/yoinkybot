import { describe, expect, it } from "vitest";
import { extractJson, salvageTruncatedJson, asObject, cost, reasoningEffort, hashForCacheKey, routeFor, type RouteEnv } from "./gateway.js";

describe("cost (cached input bills ~6.7x cheaper)", () => {
  it("prices the current OpenRouter frontier model", () => {
    expect(cost("x-ai/grok-4.3", 1_000_000, 0, 1_000_000)).toBeCloseTo(3.75, 6);
  });
  it("splits fresh vs cached input and adds output at the output rate", () => {
    // grok-4.5, priced live from the OpenRouter models API 2026-07-27:
    // $2 in / $0.30 cachedIn / $6 out per 1M. (The cached rate was recorded as
    // $0.50 until then, which UNDER-stated the caching upside.)
    // 1M input of which 500k cached, 100k output:
    //   fresh 500k*2 + cached 500k*0.3 + out 100k*6 = 1_000_000 + 150_000 + 600_000 = 1.75M /1e6
    expect(cost("x-ai/grok-4.5", 1_000_000, 500_000, 100_000)).toBeCloseTo(1.75, 6);
  });
  it("charges full input when nothing is cached", () => {
    expect(cost("grok-4.5", 1_000_000, 0, 0)).toBeCloseTo(2.0, 6);
  });
  it("matches the xAI-direct and OpenRouter ids to the same grok price", () => {
    expect(cost("grok-4.5", 1000, 0, 1000)).toBeCloseTo(cost("x-ai/grok-4.5", 1000, 0, 1000), 9);
  });
  it("falls back to zero for an unknown model (never NaN)", () => {
    expect(cost("mystery-model", 1000, 100, 1000)).toBe(0);
  });
});

describe("routeFor (two-model routing)", () => {
  const env: RouteEnv = {
    cheapRouting: true,
    openRouterKey: "sk-test",
    transport: "openrouter",
    chatModel: "x-ai/grok-4.5",
    cheapModel: "z-ai/glm-4.7-flash",
    xaiModel: "grok-4.5",
  };

  it("frontier stays on the product model", () => {
    expect(routeFor("frontier", env).model).toBe("x-ai/grok-4.5");
  });

  it("every non-frontier tier goes to the cheap model", () => {
    for (const t of ["cheap", "cheap_floor", "none"] as const) {
      expect(routeFor(t, env).model).toBe("z-ai/glm-4.7-flash");
    }
  });

  /**
   * api.x.ai serves Grok and nothing else, so a cheap-tier call routed there
   * would 404. Transport has to follow the tier, not the process-wide setting.
   */
  it("forces the cheap tier onto OpenRouter even when the transport is xai", () => {
    const r = routeFor("cheap", { ...env, transport: "xai" });
    expect(r.xai).toBe(false);
    expect(r.model).toBe("z-ai/glm-4.7-flash");
  });

  it("keeps frontier on xai-direct when that transport is selected", () => {
    const r = routeFor("frontier", { ...env, transport: "xai" });
    expect(r.xai).toBe(true);
    expect(r.model).toBe("grok-4.5");
  });

  it("falls back to the product model when there is no OpenRouter key to route to", () => {
    const r = routeFor("cheap", { ...env, transport: "xai", openRouterKey: undefined });
    expect(r.model).toBe("grok-4.5");
    expect(r.xai).toBe(true);
  });

  it("LLM_CHEAP_ROUTING=false sends everything back to the product model", () => {
    expect(routeFor("cheap", { ...env, cheapRouting: false }).model).toBe("x-ai/grok-4.5");
  });

  it("the cheap model is priced, and far cheaper on both input and output", () => {
    const frontier = cost("x-ai/grok-4.5", 1000, 0, 1000);
    const cheap = cost("z-ai/glm-4.7-flash", 1000, 0, 1000);
    expect(cheap).toBeGreaterThan(0); // priced, not an unknown model silently at $0
    expect(cheap).toBeLessThan(frontier / 5);
  });
});

describe("reasoningEffort", () => {
  it("frontier → high, everything else → low", () => {
    expect(reasoningEffort("frontier")).toBe("high");
    expect(reasoningEffort("cheap")).toBe("low");
    expect(reasoningEffort("cheap_floor")).toBe("low");
    expect(reasoningEffort("none")).toBe("low");
  });
});

describe("hashForCacheKey", () => {
  it("is deterministic, 16 hex chars, and not the raw id", () => {
    const h = hashForCacheKey("user-123");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toBe(hashForCacheKey("user-123"));
    expect(h).not.toContain("user-123");
    expect(hashForCacheKey("user-123")).not.toBe(hashForCacheKey("user-124"));
  });
});

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
