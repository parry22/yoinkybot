/**
 * The automation cron (§4), mirroring agentTick: fire a few times a day; each
 * enabled + due automation runs once. The per-day gate + atomic run claims make
 * it safe to over-fire. Quiet hours defer the whole run to a later tick (the
 * simplest way to keep an approval DM out of the user's night).
 */
import { query } from "../db/pool.js";
import { inQuietHours, type UserSettings } from "../lib/time.js";
import { enabledAutomations } from "./store.js";
import { runAutomationOnce } from "./run.js";
import type { Automation } from "./types.js";

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Is this automation due right now? At most once per UTC day; weekly honors
 * cadence_meta.days; an optional cadence_meta.hour holds until that hour (UTC —
 * a v1 simplification; quiet hours cover politeness). `manual` is never auto-due.
 */
export function isDue(a: Automation, now: Date = new Date()): boolean {
  if (a.cadence_kind === "manual") return false;
  if (a.last_run_at) {
    const last = new Date(a.last_run_at);
    if (
      last.getUTCFullYear() === now.getUTCFullYear() &&
      last.getUTCMonth() === now.getUTCMonth() &&
      last.getUTCDate() === now.getUTCDate()
    ) {
      return false; // already fired today
    }
  }
  if (a.cadence_kind === "weekly") {
    const days = Array.isArray(a.cadence_meta.days) ? a.cadence_meta.days : [];
    if (days.length > 0 && !days.includes(DOW[now.getUTCDay()]!)) return false;
  }
  const hour = typeof a.cadence_meta.hour === "number" ? a.cadence_meta.hour : null;
  if (hour !== null && now.getUTCHours() < hour) return false;
  return true;
}

async function loadSettings(userId: string): Promise<UserSettings> {
  const row = await query<{ settings: UserSettings }>(`SELECT settings FROM users WHERE id = $1`, [userId]);
  return row[0]?.settings ?? {};
}

export async function handleAutomationTick(): Promise<void> {
  const autos = await enabledAutomations();
  const settingsCache = new Map<string, UserSettings>();
  for (const a of autos) {
    if (!isDue(a)) continue;
    if (a.respect_quiet_hours) {
      let s = settingsCache.get(a.user_id);
      if (!s) {
        s = await loadSettings(a.user_id);
        settingsCache.set(a.user_id, s);
      }
      if (inQuietHours(s)) continue;
    }
    try {
      await runAutomationOnce(a);
    } catch (err) {
      console.error(`automation ${a.id} tick failed`, err);
    }
  }
}
