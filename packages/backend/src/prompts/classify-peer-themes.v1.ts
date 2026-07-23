import type { Prompt } from "./types.js";
import { ALL_TONE_KEYS, TONE_LABEL } from "../strategist/profile.js";

export interface ClassifyPeerThemesVars {
  posts: Array<{ index: number; content: string }>;
}

const toneMenu = ALL_TONE_KEYS.map((k) => `${k}: ${TONE_LABEL[k]}`).join("\n");

/**
 * Batch theme + register labeling for a peer's public posts — ONE cheap call
 * per peer per weekly ingest. Deliberately shallow: a broad topical label plus
 * rhetorical mode and sincerity register (for territory/performance
 * segmentation), nothing like the idea/claim/position extraction or the
 * motive/campaign detection reserved for the user's own memory — peers get
 * territory comparison, never a belief graph, so motive and campaigns don't
 * apply to them (memory/classification.ts, benchmark/peers.ts doctrine).
 */
export const classifyPeerThemes: Prompt<ClassifyPeerThemesVars> = {
  id: "classify-peer-themes",
  version: 2,
  tier: "none",
  system: `You label posts for territory comparison. For each numbered post, give:
1. theme: ONE short topical label (2-5 words, lowercase, e.g. "ai developer tools", "founder
   hiring", "distribution strategy"). Reuse the same label across posts covering the same
   territory — the labels are compared as a set, so consistency matters more than nuance.
2. rhetorical_mode: the single best-fitting key from:
${toneMenu}
3. sincerity_register: sincere | ironic | self_deprecating | absurdist | ambiguous. A shitpost read
   as a sincere take would misrepresent this peer's territory — use ambiguous rather than forcing a
   guess.
Do not analyze beliefs, positions, motive, or voice; this is topic + tone only.

Respond with ONLY valid JSON:
{"themes":[{"index":0,"theme":"...","rhetorical_mode":"...","sincerity_register":"sincere|ironic|self_deprecating|absurdist|ambiguous"}]} — one entry per post.`,
  render: ({ posts }) => posts.map((p) => `[${p.index}] ${p.content.slice(0, 400)}`).join("\n\n"),
};
