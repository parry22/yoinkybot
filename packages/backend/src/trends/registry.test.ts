import { describe, expect, it } from "vitest";
import { fetchTrendsWithFallback } from "./registry.js";
import type { Trend, TrendProvider } from "./provider.js";

const trend = (source: string): Trend => ({
  externalId: "e1",
  platform: "x",
  topic: "t",
  summary: "s",
  observedAt: new Date().toISOString(),
  source,
});

function provider(name: string, behavior: "ok" | "empty" | "throws"): TrendProvider {
  return {
    name,
    isConfigured: () => true,
    fetchTrends: async () => {
      if (behavior === "throws") throw new Error(`${name} down`);
      return behavior === "ok" ? [trend(name)] : [];
    },
  };
}

describe("fetchTrendsWithFallback", () => {
  const opts = { themes: ["startups"], limit: 5 };

  it("uses the first provider when it succeeds", async () => {
    const res = await fetchTrendsWithFallback(opts, [provider("apify", "ok"), provider("brave", "ok")]);
    expect(res.provider).toBe("apify");
  });

  it("falls through a throwing provider to the next", async () => {
    const res = await fetchTrendsWithFallback(opts, [provider("apify", "throws"), provider("brave", "ok")]);
    expect(res.provider).toBe("brave");
    expect(res.trends).toHaveLength(1);
  });

  it("falls through an empty provider to the next", async () => {
    const res = await fetchTrendsWithFallback(opts, [provider("apify", "empty"), provider("tavily", "ok")]);
    expect(res.provider).toBe("tavily");
  });

  it("returns empty (not an error) when every provider fails", async () => {
    const res = await fetchTrendsWithFallback(opts, [provider("a", "throws"), provider("b", "empty")]);
    expect(res.provider).toBeNull();
    expect(res.trends).toEqual([]);
  });
});
