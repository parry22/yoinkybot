import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema, assertFullySupported } from "./json-schema.js";
import { toolsFromSchema, qualify } from "./mcp-tools.js";
import { beatFor } from "./chat-turn.js";

/**
 * Guards the two mechanical translations the adapter depends on. Both are the
 * kind of thing that fails silently in production — a dropped `required`, or a
 * tool that never gets exposed — so they are asserted against the REAL feature
 * schemas rather than toy ones.
 */

// Mirrors of the five live output schemas (kept structural, not imported, so a
// prompt refactor cannot make this test vacuous by changing what it imports).
const consistencyResult = z.object({
  resolution: z.enum(["intentional_evolution", "catch_it", "no_conflict"]).catch("no_conflict"),
  position_id: z.string().nullish(),
  prior_statement: z.string().catch(""),
  date: z.string().catch(""),
  source: z.string().catch(""),
  explanation: z.string().catch(""),
  confidence: z.number().min(0).max(1).catch(0),
});

const trendTake = z.object({
  fires: z.boolean().catch(false),
  reply: z.string().catch(""),
  source_url: z.string().nullish(),
  source_note: z.string().catch(""),
  embedded_draft: z.string().nullish(),
  angle: z.string().catch(""),
  cited_memory_ids: z.array(z.string()).catch([]),
  confidence: z.number().min(0).max(1).catch(0),
});

const replyDraft = z.object({
  intro: z.string().min(1),
  draft: z.string().min(1),
  cited_memory_ids: z.array(z.string()).catch([]),
  distribution_rationale: z.string().catch(""),
});

describe("zodToJsonSchema", () => {
  it("marks .catch() fields optional but keeps genuinely required ones", () => {
    const s = zodToJsonSchema(replyDraft);
    // intro/draft have no .catch() → the model must supply them.
    expect(s.required).toEqual(["intro", "draft"]);
    expect((s.properties as any).intro).toMatchObject({ type: "string", minLength: 1 });
    // .catch([]) → omittable, so absent from required.
    expect(s.required).not.toContain("cited_memory_ids");
  });

  it("emits no required array when every field is omittable", () => {
    const s = zodToJsonSchema(trendTake);
    expect(s.required).toBeUndefined();
    expect(s.additionalProperties).toBe(false);
  });

  it("carries enum values and numeric bounds through .catch()", () => {
    const s = zodToJsonSchema(consistencyResult);
    expect((s.properties as any).resolution).toEqual({
      type: "string",
      enum: ["intentional_evolution", "catch_it", "no_conflict"],
    });
    expect((s.properties as any).confidence).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
  });

  it("renders .nullish() as a nullable type rather than dropping it", () => {
    const s = zodToJsonSchema(trendTake);
    expect((s.properties as any).source_url).toEqual({ type: ["string", "null"] });
  });

  it("handles arrays and nested objects", () => {
    const s = zodToJsonSchema(z.object({ items: z.array(z.object({ id: z.string() })) }));
    expect((s.properties as any).items.type).toBe("array");
    expect((s.properties as any).items.items.properties.id).toEqual({ type: "string" });
  });

  it("accepts every construct the live schemas use (drift guard)", () => {
    for (const s of [consistencyResult, trendTake, replyDraft]) {
      expect(() => assertFullySupported(s)).not.toThrow();
    }
  });

  it("assertFullySupported throws on a construct the converter would flatten", () => {
    expect(() => assertFullySupported(z.object({ when: z.date() }))).toThrow(/unsupported/i);
  });
});

describe("toolsFromSchema", () => {
  const union = z.discriminatedUnion("name", [
    z.object({ name: z.literal("search_more_positions"), query: z.string().min(1) }),
    z.object({ name: z.literal("get_position_context"), position_id: z.string().min(1) }),
    z.object({ name: z.literal("search_memory"), query: z.string().min(1) }),
  ]);

  it("derives one tool per union member that has an executor", () => {
    const { derived } = toolsFromSchema(union, {
      search_more_positions: async () => "a",
      get_position_context: async () => "b",
      search_memory: async () => "c",
    });
    expect(derived.map((d) => d.name)).toEqual([
      "search_more_positions",
      "get_position_context",
      "search_memory",
    ]);
  });

  it("qualifies names as mcp__yoinky__<tool> — hooks match on this, not the bare name", () => {
    const { derived } = toolsFromSchema(union, { search_memory: async () => "c" });
    expect(derived).toHaveLength(1);
    expect(derived[0].qualifiedName).toBe("mcp__yoinky__search_memory");
    expect(qualify("search_memory")).toBe("mcp__yoinky__search_memory");
  });

  it("skips members with no executor rather than exposing a tool that must fail", () => {
    const { derived } = toolsFromSchema(union, { search_memory: async () => "c" });
    expect(derived.map((d) => d.name)).toEqual(["search_memory"]);
  });

  it("accepts a single bare object schema (one-tool loop)", () => {
    const single = z.object({ name: z.literal("only"), q: z.string() });
    const { derived } = toolsFromSchema(single, { only: async () => "x" });
    expect(derived.map((d) => d.name)).toEqual(["only"]);
  });
});

describe("beatFor (chat never goes silent)", () => {
  it("prefers the model's own narration when there is any", () => {
    expect(beatFor("search_memory", "lemme dig that up", "")).toBe("lemme dig that up");
  });

  it("falls back to a tool-specific line when the model narrates nothing", () => {
    // This is the real case: under structured output grok emits no text at all,
    // so without this a multi-tool turn is silent until the final reply.
    expect(beatFor("search_memory", "", "")).toBe("checking what you've told me");
    expect(beatFor("draft_post", "", "")).toBe("on it, drafting that now");
  });

  it("has a beat for every tool in chatToolSchema", async () => {
    const { chatToolSchema } = await import("../telegram/chat-tools.js");
    const names = (chatToolSchema as any)._def.options.map(
      (o: any) => o._def.shape().name._def.value as string,
    );
    for (const n of names) {
      // A new chat tool must not silently inherit the generic line.
      expect(beatFor(n, "", ""), `no TOOL_BEATS entry for "${n}"`).not.toBe("on it, one sec");
    }
  });

  it("does not say the same line twice in a row", () => {
    const first = beatFor("search_memory", "", "");
    expect(beatFor("search_memory", "", first)).toBe("still on it");
  });

  it("still covers an unknown tool rather than returning empty", () => {
    expect(beatFor("some_future_tool", "", "")).toBe("on it, one sec");
  });
});
