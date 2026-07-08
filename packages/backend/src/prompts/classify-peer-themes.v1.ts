import type { Prompt } from "./types.js";

export interface ClassifyPeerThemesVars {
  posts: Array<{ index: number; content: string }>;
}

/**
 * Batch theme labeling for a peer's public posts — ONE cheap call per peer per
 * weekly ingest. Deliberately shallow: a broad topical label per post, nothing
 * like the idea/claim/position extraction reserved for the user's own memory.
 * Peers get territory comparison, never a belief graph.
 */
export const classifyPeerThemes: Prompt<ClassifyPeerThemesVars> = {
  id: "classify-peer-themes",
  version: 1,
  tier: "cheap",
  system: `You label posts with broad topical themes for territory comparison. For each numbered post,
give ONE short theme label (2-5 words, lowercase, e.g. "ai developer tools", "founder hiring",
"distribution strategy"). Reuse the same label across posts covering the same territory — the
labels are compared as a set, so consistency matters more than nuance. Do not analyze beliefs,
positions, or voice; topics only.

Respond with ONLY valid JSON: {"themes":[{"index":0,"theme":"..."}]} — one entry per post.`,
  render: ({ posts }) => posts.map((p) => `[${p.index}] ${p.content.slice(0, 400)}`).join("\n\n"),
};
