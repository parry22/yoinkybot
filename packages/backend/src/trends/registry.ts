import { config } from "../config.js";
import type { Trend, TrendProvider, FetchOpts } from "./provider.js";
import { apifyProvider } from "./providers/apify.js";
import { braveProvider } from "./providers/brave.js";
import { tavilyProvider } from "./providers/tavily.js";

const ALL: Record<string, TrendProvider> = {
  apify: apifyProvider,
  brave: braveProvider,
  tavily: tavilyProvider,
};

/**
 * Ordered provider chain: the configured TREND_PROVIDER first, then the rest as
 * fallbacks. A provider that is unconfigured, throws, or returns nothing simply
 * yields to the next — the caller never sees which one answered.
 */
export function providerChain(): TrendProvider[] {
  const preferred = ALL[config.TREND_PROVIDER];
  const rest = Object.values(ALL).filter((p) => p !== preferred);
  return [...(preferred ? [preferred] : []), ...rest].filter((p) => p.isConfigured());
}

export async function fetchTrendsWithFallback(
  opts: FetchOpts,
  providers: TrendProvider[] = providerChain(),
): Promise<{ trends: Trend[]; provider: string | null }> {
  for (const provider of providers) {
    try {
      const trends = await provider.fetchTrends(opts);
      if (trends.length > 0) return { trends, provider: provider.name };
      console.warn(`trend provider ${provider.name} returned nothing, trying next`);
    } catch (err) {
      console.error(`trend provider ${provider.name} failed, trying next`, err);
    }
  }
  return { trends: [], provider: null };
}
