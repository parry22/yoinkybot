import { queryOne } from "../db/pool.js";
import { inQuietHours, type UserSettings } from "../lib/time.js";
import { entitlementsFor } from "../billing/entitlements.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Never deliver two proactive DMs closer together than this. */
const MIN_GAP_MS = 36 * 60 * 60 * 1000;

/**
 * One shared proactive-delivery budget across ALL DM types (resurface,
 * angle_offer, trend_match, reply_draft, nudge). Prevents independent jobs from
 * each DMing the user up to the per-week cap and drowning them. Consistency
 * flags are excluded - they're user-initiated (web), not proactive.
 * Progress reports are excluded - they have their own 14-day gate.
 */
// trend_take is NOT here (2026-07-14): trends have their OWN cadence (own daily
// band + a min-gap, in jobs/trend-match.ts). Folding them into the shared weekly
// cap meant own-content resurfacings exhausted the budget and real trends - the
// thing users actually ask for - got "weekly cap reached" and never fired.
export const PROACTIVE_TYPES = ["resurface", "angle_offer", "trend_match", "reply_draft", "performance_alert", "nudge"];

export interface CadenceDecision {
  ok: boolean;
  reason?: string;
}

export async function canDeliverProactive(
  userId: string,
  settings: UserSettings,
  now: Date = new Date(),
): Promise<CadenceDecision> {
  if (inQuietHours(settings, now)) return { ok: false, reason: "quiet hours" };

  const ent = await entitlementsFor(userId);
  const perWeek = Math.min(settings.resurface_per_week ?? ent.maxResurfacePerWeek, ent.maxResurfacePerWeek);
  if (perWeek <= 0) return { ok: false, reason: "weekly cap is zero" };

  // The cold-start first touch is budget-exempt (it's the minimum viable
  // presence, not a bonus message) but still anchors spacing, so the next
  // regular delivery doesn't land right on its heels.
  const recent = await queryOne<{ count: string; last: string | null }>(
    `SELECT count(*) FILTER (
       WHERE COALESCE(payload->>'cold_start', 'false') <> 'true'
         AND COALESCE(payload->>'kind', '') <> 'cold_start'
     )::text AS count,
     max(delivered_at)::text AS last
     FROM surfacings
     WHERE user_id = $1 AND type = ANY($2) AND delivered_at > now() - interval '7 days'`,
    [userId, PROACTIVE_TYPES],
  );
  const weekCount = Number(recent?.count ?? 0);
  if (weekCount >= perWeek) return { ok: false, reason: "weekly cap reached" };

  const lastAt = recent?.last ? new Date(recent.last).getTime() : 0;
  // Spread deliveries across the week rather than bunching them.
  const requiredGap = Math.max(MIN_GAP_MS, WEEK_MS / (perWeek + 1));
  if (now.getTime() - lastAt < requiredGap) return { ok: false, reason: "too soon since last delivery" };

  return { ok: true };
}
