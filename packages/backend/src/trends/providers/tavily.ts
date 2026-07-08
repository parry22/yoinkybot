import { config } from "../../config.js";
import type { FetchOpts, Trend, TrendProvider } from "../provider.js";

/**
 * News/web-search trends via Tavily. Reuses the same search shape as the
 * original macro-match discourse search. ToS-safe fallback provider.
 */
export const tavilyProvider: TrendProvider = {
  name: "tavily",
  isConfigured: () => !!config.TAVILY_API_KEY,
  async fetchTrends({ themes, limit }: FetchOpts): Promise<Trend[]> {
    const out: Trend[] = [];
    for (const theme of themes.slice(0, 4)) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: config.TAVILY_API_KEY,
          query: theme,
          topic: "news",
          days: 3,
          max_results: Math.ceil(limit / themes.length) + 1,
        }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        results?: Array<{ title: string; content: string; url: string; score?: number }>;
      };
      for (const r of data.results ?? []) {
        out.push({
          externalId: r.url,
          platform: "news",
          topic: r.title,
          summary: r.content.slice(0, 400),
          url: r.url,
          volume: r.score,
          observedAt: new Date().toISOString(),
          source: "tavily",
        });
      }
    }
    return out.slice(0, limit);
  },
};
