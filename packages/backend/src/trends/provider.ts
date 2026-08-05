/**
 * Trend provider abstraction. Everything downstream (trend-match, angle offers)
 * consumes a normalized `Trend[]` and never knows or cares which provider
 * produced it - so scraping (Apify), news search (Brave/Tavily), or the official
 * X API are interchangeable and a takedown/ban is a one-line config swap.
 */
export interface Trend {
  externalId: string; // provider-scoped id for dedup (UNIQUE with source)
  platform: "x" | "linkedin" | "web" | "news";
  topic: string;
  summary: string;
  url?: string;
  volume?: number; // normalized popularity signal, when available
  observedAt: string; // ISO-8601
  source: string; // provider name for provenance
}

export interface FetchOpts {
  /** The user-base's interest themes to bias the fetch toward. */
  themes: string[];
  limit: number;
}

export interface TrendProvider {
  name: string;
  /** True when the provider has the credentials/config it needs to run. */
  isConfigured(): boolean;
  fetchTrends(opts: FetchOpts): Promise<Trend[]>;
}
