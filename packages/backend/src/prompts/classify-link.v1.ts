import type { Prompt } from "./types.js";

export interface ClassifyLinkVars {
  newMemory: string;
  neighbors: Array<{ id: string; content: string }>;
}

/**
 * Given a new memory and its nearest semantic neighbors, decide which are truly
 * related and how. Vector similarity found them; this decides if the relation is real.
 */
export const classifyLink: Prompt<ClassifyLinkVars> = {
  id: "classify-link",
  version: 1,
  tier: "cheap",
  system: `You decide how a NEW thought relates to EXISTING thoughts by the same person.
For each existing thought, classify the relationship:
- extends: the new thought develops, deepens, or adds to the existing one
- contradicts: they cannot both be held sincerely; the new one pushes against the old
- echoes: same underlying idea restated (near-duplicate in substance)
- answers: the new thought answers a question or resolves a tension in the existing one
- none: superficially similar wording but not actually related in substance

Be conservative: "none" is the correct answer for most pairs. Vector search surfaced these
as lexically/semantically close; your job is to reject false neighbors. Also give strength
0.0-1.0 for how strong the relation is.

Respond with ONLY valid JSON:
{"links":[{"id":"<existing id>","type":"extends|contradicts|echoes|answers|none","strength":0.0}]}`,
  render: ({ newMemory, neighbors }) =>
    `NEW thought:\n${newMemory}\n\nEXISTING thoughts:\n${neighbors
      .map((n) => `[${n.id}] ${n.content}`)
      .join("\n")}`,
};
