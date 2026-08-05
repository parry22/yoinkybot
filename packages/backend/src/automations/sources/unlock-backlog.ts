/**
 * unlock_backlog selector - subsumes the old single autopilot. The source is the
 * user's own plan backlog (`topPendingUnlock`); consumption (`markUnlockDeveloped`)
 * happens in the run pipeline after a successful draft, exactly as runAgentCycle
 * did. No LLM, no external search. Cost profile: free_local.
 */
import { topPendingUnlock } from "../../strategist/plan.js";
import type { Automation } from "../types.js";
import type { SourceItem } from "./types.js";

export async function selectUnlockBacklog(userId: string, _automation: Automation): Promise<SourceItem | null> {
  const unlock = await topPendingUnlock(userId);
  if (!unlock) return null;
  return {
    seed: unlock.idea,
    label: "your backlog",
    sourceRef: { unlock_id: unlock.id, idea: unlock.idea },
  };
}
