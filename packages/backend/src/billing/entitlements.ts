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
