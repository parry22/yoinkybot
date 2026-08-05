import type { Prompt } from "./types.js";

export interface TrendThemesVars {
  /** Stated brand niches + content pillars, when any user has a profile. */
  profileBits: string[];
  /** Memory-map cluster labels, biggest first - often polluted by personal-life chatter. */
  clusterLabels: string[];
  /** Recent active position statements - the professional belief store. */
  positions: string[];
}

/**
 * Distills the user base's PROFESSIONAL territory into short X/LinkedIn search
 * terms for trend discovery. Exists because raw cluster labels proved to be
 * terrible seeds: the biggest clusters are often personal-life topics
 * ("Passport and Flight Issues"), and even on-niche labels are phrases nobody
 * tweets verbatim. Trend search needs the 4-6 words the niche's discourse
 * actually uses.
 */
export const trendThemes: Prompt<TrendThemesVars> = {
  id: "trend-themes",
  version: 1,
  tier: "none",
  system: `You pick X/Twitter search terms that will surface this week's high-engagement
professional discourse for a content creator, given signals about what they work on.

Rules:
- 4 to 6 terms, each 1-3 words, the vocabulary the niche's discourse actually uses
  (e.g. "AI agents", "openai", "design systems") - not full sentences.
- Professional territory ONLY. Ignore personal-life signals (travel, food, visas,
  parties, cities) even if they dominate the input - those are chatter, not niche.
- Prefer broad nouns over narrow phrasings: "AI models" finds a model-launch news
  cycle; "my agent workflow setup" finds nothing.
- Include at least one term naming the niche's key companies/people ONLY if the
  signals clearly orbit them (e.g. "openai" for someone deep in AI discourse).

Respond with ONLY valid JSON: {"themes": ["...", "..."]}`,
  render: ({ profileBits, clusterLabels, positions }) =>
    [
      profileBits.length ? `STATED NICHE / PILLARS:\n${profileBits.map((b) => `- ${b}`).join("\n")}` : "",
      clusterLabels.length ? `MEMORY CLUSTERS (biggest first, may include personal-life noise):\n${clusterLabels.map((l) => `- ${l}`).join("\n")}` : "",
      positions.length ? `RECENT PROFESSIONAL POSITIONS:\n${positions.map((p) => `- ${p}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
};
