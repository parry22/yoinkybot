import { queryOne } from "../db/pool.js";
import { config } from "../config.js";

export type Plan = "free" | "paid" | "founding";

export interface Entitlements {
  plan: Plan;
  /** Hard cap on proactive resurfacings per week. */
  maxResurfacePerWeek: number;
  consistencyChecks: boolean;
  voiceProfile: boolean;
  drafting: boolean;
  macroMatching: boolean;
}

const FREE: Entitlements = {
  plan: "free",
  maxResurfacePerWeek: 1,
  consistencyChecks: false,
  voiceProfile: false,
  drafting: false,
  macroMatching: false,
};

const PAID: Omit<Entitlements, "plan"> = {
  maxResurfacePerWeek: 3,
  consistencyChecks: true,
  voiceProfile: true,
  drafting: true,
  macroMatching: true,
};

/**
 * Telegram ids that bypass the paywall: PAYWALL_WHITELIST (comma-separated) plus
 * ADMIN_TELEGRAM_ID, which is always exempt so the operator never has to upgrade
 * their own account to use the product.
 */
export function whitelistIncludes(
  telegramId: string | null | undefined,
  whitelistCsv: string | undefined,
  adminId: string | undefined,
): boolean {
  if (!telegramId) return false;
  const ids = new Set<string>();
  for (const raw of (whitelistCsv ?? "").split(",")) {
    const t = raw.trim();
    if (t) ids.add(t);
  }
  if (adminId) ids.add(adminId.trim());
  return ids.has(String(telegramId).trim());
}

export function isWhitelisted(telegramId: string | null | undefined): boolean {
  return whitelistIncludes(telegramId, config.PAYWALL_WHITELIST, config.ADMIN_TELEGRAM_ID);
}

/**
 * The single "is this user allowed past the post-diagnosis paywall" check.
 * True when the paywall is off entirely (testing), the user is whitelisted, or
 * they actually hold a paid/founding plan. Used by the upgrade wall so LLM/API
 * work stays blocked for free users after their diagnosis lands.
 */
export async function isPaidOrExempt(user: { id: string; telegram_id: string | null }): Promise<boolean> {
  if (!config.PAYWALL_ENABLED) return true;
  if (isWhitelisted(user.telegram_id)) return true;
  const ent = await entitlementsFor(user.id);
  return ent.plan !== "free";
}

export async function entitlementsFor(userId: string): Promise<Entitlements> {
  // Paywall is off during testing (PAYWALL_ENABLED=false) — everyone gets the
  // full feature set. Flip the flag on to enforce plans; the logic below is ready.
  if (!config.PAYWALL_ENABLED) {
    const sub = await queryOne<{ plan: Plan }>(`SELECT plan FROM subscriptions WHERE user_id = $1`, [userId]);
    return { plan: sub?.plan ?? "free", ...PAID };
  }

  const sub = await queryOne<{ plan: Plan; status: string }>(
    `SELECT plan, status FROM subscriptions WHERE user_id = $1`,
    [userId],
  );
  if (!sub || sub.status !== "active" || sub.plan === "free") return FREE;
  return { plan: sub.plan, ...PAID };
}
