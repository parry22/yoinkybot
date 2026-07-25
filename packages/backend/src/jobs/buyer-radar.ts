/**
 * Recurring Buyer Radar scan — DARK by default (config.BUYER_RADAR_PROACTIVE,
 * off). v1 delivery is pull-only via the web app; this job exists so the
 * proactive path can be turned on per rollout, AFTER the twitterapi.io search
 * budget behaves in prod (it has hit 402 credit errors before). When enabled, it
 * keeps each opted-in user's radar fresh by running scanForUser on a modest
 * cadence. scanForUser enforces the monthly budget itself before any paid call.
 */
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { scanForUser } from "../buyer/scan.js";
import type { BuyerScanNowJob } from "./boss.js";
import { scanBuyerSignals, type ScanResponse } from "../web/buyers-radar.js";

export async function handleBuyerRadar(): Promise<void> {
  if (!config.BUYER_RADAR_ENABLED || !config.BUYER_RADAR_PROACTIVE) return; // ships dark
  if (!config.TWITTERAPI_IO_KEY) return;

  // Opt-in population: only users who have completed the ICP intake.
  const users = await query<{ user_id: string }>(
    `SELECT user_id FROM icp_profiles
     WHERE product_oneliner IS NOT NULL AND buyer_description IS NOT NULL`,
  );
  for (const u of users) {
    try {
      await scanForUser(u.user_id);
    } catch (err) {
      console.error(`buyer radar scan failed for ${u.user_id}`, err);
    }
  }
}

/**
 * On-demand "Scan now", moved off the Vercel request path (docs/INTERNAL §3n).
 *
 * WHY IT HAD TO MOVE: a scan calls composeOutreach per gated candidate, and under
 * `AGENT_RUNTIME_BUYER=sdk` each of those spawns a Claude Code subprocess needing
 * a real filesystem. A Vercel serverless function is not that, so the old
 * synchronous route could not work in SDK mode at all. Running it here also
 * retires a second problem the sync route always had: several paid searches plus
 * a handful of composition loops against a 300s function ceiling.
 *
 * The return value becomes the pg-boss job output, which the web app polls — so
 * the user still gets the same funnel counts and `reason` sentence, just after a
 * poll instead of a held-open request.
 */
export async function handleBuyerScanNow(data: BuyerScanNowJob): Promise<ScanResponse> {
  return scanBuyerSignals(data.userId);
}
