/**
 * custom selector — the govork-style "define it freely" source. There's no
 * external search or LLM here: the user's own brief IS the seed handed to the
 * draft path. Deterministic (returns null only when there's no brief to work
 * from). Cost profile: free_local.
 */
import type { Automation } from "../types.js";
import type { SourceItem } from "./types.js";

export async function selectCustom(_userId: string, automation: Automation): Promise<SourceItem | null> {
  const brief = automation.brief?.trim();
  if (!brief) return null;
  return {
    seed: brief,
    label: "your brief",
    sourceRef: { kind: "custom", brief },
  };
}
