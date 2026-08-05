/**
 * trend_ride selector - the flagship. Reuses the SAME deterministic trend
 * selection as the proactive nudge (`selectEligibleTrends`: niche → buzz → rank),
 * then dedups against trends this automation has already consumed
 * (automation_runs.source_ref.trend_id). No LLM, no moment creation (so it never
 * hides a trend from the proactive `⚡` path). Cost profile: shared_pool.
 */
import { query } from "../../db/pool.js";
import { selectEligibleTrends } from "../../jobs/trend-match.js";
import type { Automation } from "../types.js";
import type { SourceItem } from "./types.js";

export async function selectTrendRide(userId: string, automation: Automation): Promise<SourceItem | null> {
  const ranked = await selectEligibleTrends(userId);
  if (ranked.length === 0) return null;

  const consumed = await query<{ trend_id: string | null }>(
    `SELECT source_ref->>'trend_id' AS trend_id FROM automation_runs
     WHERE automation_id = $1 AND source_ref->>'trend_id' IS NOT NULL`,
    [automation.id],
  );
  const seen = new Set(consumed.map((r) => r.trend_id).filter(Boolean));
  const pick = ranked.find((r) => !seen.has(r.trend.id));
  if (!pick) return null;

  // Seed leads with the user's own nearest position so generateDraft's memory
  // retrieval hits (it declines on empty), then points the draft at the trend -
  // the "anchor to your prior take" moat, for free.
  return {
    seed: `${pick.position.statement}\n\nConnect this to what's surging on X right now: ${pick.trend.topic}.`,
    label: pick.trend.topic,
    sourceRef: {
      trend_id: pick.trend.id,
      source_url: pick.trend.url,
      source_note: pick.whyNow,
      buzz: pick.buzz,
    },
  };
}
