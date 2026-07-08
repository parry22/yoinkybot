import { queryOne } from "../db/pool.js";
import { inQuietHours, type UserSettings } from "../lib/time.js";
import { entitlementsFor } from "../billing/entitlements.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Never deliver two proactive DMs closer together than this. */
const MIN_GAP_MS = 36 * 60 * 60 * 1000;

/**
 * One shared proactive-delivery budget across ALL DM types (resurface,
 * angle_offer, trend_match, reply_draft). Prevents independent jobs from each
 * DMing the user up to the per-week cap and drowning them. Consistency
 * flags are excluded — they're user-initiated (web), not proactive.
 * Progress reports are excluded — they have their own 14-day gate.
 */
const PROACTIVE_TYPES = ["resurface", "angle_offer", "trend_match", "reply_draft", "performance_alert"];

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

  const recent = await queryOne<{ count: string; last: string | null }>(
    `SELECT count(*)::text AS count, max(delivered_at)::text AS last
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
