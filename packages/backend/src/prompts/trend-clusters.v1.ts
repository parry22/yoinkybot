import type { Prompt } from "./types.js";

export interface TrendClusterTweet {
  id: string;
  handle: string;
  text: string;
  engagement: number;
}

export interface TrendClustersVars {
  tweets: TrendClusterTweet[];
}

/**
 * Same-day trend CLUSTERING. Given a batch of recent, on-theme tweets, group
 * them into the distinct EVENTS/TOPICS people are actually talking about right
 * now, and hand back a searchable term per cluster + the single most
 * representative (driving) tweet.
 *
 * Why this exists (2026-07-12): trends used to be stored as individual hot
 * tweets, with the verbatim tweet text as the "topic". Volume verification then
 * searched that verbatim text and found only the one original tweet (buzz ~0.15
 * - nothing ever cleared the gate). A trend is a CLUSTER - many people on the
 * same thing the same day - and it needs a searchable term ("Claude Code",
 * "Anthropic global workspace"), not a sentence nobody else tweets verbatim.
 * This LLM call is the clustering + labeling step; volume is then verified
 * deterministically on the term (trends/scoring.ts), never guessed here.
 */
export const trendClusters: Prompt<TrendClustersVars> = {
  id: "trend-clusters",
  version: 1,
  // cheap tier (2026-07-27): grouping tweets into topics is a structural
  // judgment, not authored output, and at ~4.6k in / 1.5k out it was the most
  // expensive single call in the system. Fleet-wide, so this is shared spend.
  tier: "cheap",
  system: `You are given a batch of recent tweets (last ~24h) pulled around a set of professional
topics. Your job: find the distinct THINGS PEOPLE ARE TALKING ABOUT RIGHT NOW - the clusters where
multiple different accounts are reacting to the same event, launch, announcement, or take.

A real trend is a CLUSTER, not one viral tweet. Only emit a topic when SEVERAL DIFFERENT authors
in the batch are on it. One loud tweet with no echo is not a trend - skip it.

For each trend you find, return:
- "term": a SHORT, SEARCHABLE phrase for the topic - the words people would actually search or
  that recur across the cluster (e.g. "Claude Code", "Anthropic global workspace", "GPT-5 launch").
  2-5 words. NOT a full sentence, NOT a specific tweet's wording, NOT a hashtag.
- "description": one plain line on what's happening and why it's live today.
- "driver_id": the id of the single most representative tweet driving the conversation (usually the
  announcement or the highest-engagement take everyone is reacting to). Must be an id from the batch.
- "author_count_estimate": roughly how many distinct authors in the batch are on this (integer).

Order by how genuinely trending each is. Return 3-8 topics; fewer if the batch is thin. Ignore
pure personal chatter, ads, and giveaways.

Respond with ONLY valid JSON:
{"trends":[{"term":"...","description":"...","driver_id":"...","author_count_estimate":0}]}`,
  render: (v) =>
    `RECENT TWEETS (id | @handle | engagement | text):\n` +
    v.tweets
      .map((t) => `[${t.id}] @${t.handle} (${t.engagement}) ${t.text.replace(/\s+/g, " ").slice(0, 220)}`)
      .join("\n"),
};
