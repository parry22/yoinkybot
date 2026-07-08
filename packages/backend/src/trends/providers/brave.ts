import { config } from "../../config.js";
import type { FetchOpts, Trend, TrendProvider } from "../provider.js";

/** News/web-search trends via Brave Search API. ToS-safe fallback provider. */
export const braveProvider: TrendProvider = {
  name: "brave",
  isConfigured: () => !!config.BRAVE_API_KEY,
  async fetchTrends({ themes, limit }: FetchOpts): Promise<Trend[]> {
    const out: Trend[] = [];
    for (const theme of themes.slice(0, 4)) {
      const url = new URL("https://api.search.brave.com/res/v1/news/search");
      url.searchParams.set("q", theme);
      url.searchParams.set("freshness", "pw"); // past week
      url.searchParams.set("count", String(Math.ceil(limit / themes.length) + 1));
      const res = await fetch(url, {
        headers: { "x-subscription-token": config.BRAVE_API_KEY!, accept: "application/json" },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        results?: Array<{ title: string; description?: string; url: string; age?: string }>;
      };
      for (const r of data.results ?? []) {
        out.push({
          externalId: r.url,
          platform: "news",
          topic: r.title,
          summary: (r.description ?? "").slice(0, 400),
          url: r.url,
          observedAt: new Date().toISOString(),
          source: "brave",
        });
      }
    }
    return out.slice(0, limit);
  },
};
