/**
 * Recurring Buyer Radar scan - DARK by default (config.BUYER_RADAR_PROACTIVE,
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
import { runAsUser } from "../byok/context.js";

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
      // BYOK: everything under here resolves this user's own scraper key
      // (byok/context.ts). Wrapping the per-user loop body is what makes the
      // whole ingestion/search tree below inherit it without threading an id.
      await runAsUser(u.user_id, () => scanForUser(u.user_id));
    } catch (err) {
      console.error(`buyer radar scan failed for ${u.user_id}`, err);
    }
  }
}

/**
 * On-demand "Scan now", moved off the Vercel request path (docs/INTERNAL §3n).
 *
 * WHY IT HAD TO MOVE: a scan climbs a widening ladder of paid X searches, then
 * embeds every candidate it kept. That is minutes of work against a 300s Vercel
 * function ceiling, and the ladder makes the worst case longer, not shorter.
 * Running it as a job also means an impatient refresh can't buy a second scan.
 *
 * The return value becomes the pg-boss job output, which the web app polls - so
 * the user still gets the same funnel counts and `reason` sentence, just after a
 * poll instead of a held-open request.
 */
export async function handleBuyerScanNow(data: BuyerScanNowJob): Promise<ScanResponse> {
  // Jobs do not inherit the web request's AsyncLocalStorage context. Restore it
  // here so a Lifetime scan uses that customer's scraper key.
  return runAsUser(data.userId, () => scanBuyerSignals(data.userId));
}
