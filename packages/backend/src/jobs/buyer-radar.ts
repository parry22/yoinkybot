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
