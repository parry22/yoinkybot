/**
 * The automation cron (§4), mirroring agentTick: fire a few times a day; each
 * enabled + due automation runs once. The per-day gate + atomic run claims make
 * it safe to over-fire. Quiet hours defer the whole run to a later tick (the
 * simplest way to keep an approval DM out of the user's night).
 */
import { query } from "../db/pool.js";
import { inQuietHours, type UserSettings } from "../lib/time.js";
import { casualize } from "../prompts/style.js";
import { dmChannel } from "../telegram/bot.js";
import { enabledAutomations, expireStaleApprovals } from "./store.js";
import { runAutomationOnce } from "./run.js";
import type { Automation } from "./types.js";

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * The cron interval this tick is scheduled on - every 3 hours, on the hour
 * (jobs/workers.ts, QUEUES.automationTick). Keep in step with that schedule:
 * LAST_TICK_HOUR_UTC below is derived from it.
 */
const TICK_INTERVAL_HOURS = 3;

/**
 * The latest UTC hour a tick can ever observe. With a 3-hourly cron the last run
 * of the day starts at 21:00, so `now.getUTCHours()` never exceeds 21 inside this
 * function.
 *
 * THE BUG THIS ENCODES. The hour gate was a bare
 * `if (now.getUTCHours() < hour) return false`. For hour 22 or 23 that test is
 * true at every single tick - 21 < 22 - so those automations never ran, ever, and
 * the next day's date check then reset them to un-run. Nothing logged it; the
 * automation simply sat enabled and silent forever. `hour` came straight from the
 * web form with no validation, so 22 and 23 were both reachable and both dead.
 */
const LAST_TICK_HOUR_UTC = 24 - TICK_INTERVAL_HOURS;

/** The largest hour a user may configure. Mirrored by web/automations.ts's validation. */
export const MAX_CADENCE_HOUR = 23;

/**
 * The hour gate, resolved against what the cron can actually see. A configured
 * hour later than the day's final tick is clamped to that tick rather than
 * silently never firing: an automation set to 22:00 UTC runs at the 21:00 tick,
 * up to an hour early, which is the honest degradation. Returns null when no
 * usable hour is configured.
 */
export function effectiveHourGate(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const hour = Math.min(Math.max(0, Math.trunc(raw)), MAX_CADENCE_HOUR);
  return Math.min(hour, LAST_TICK_HOUR_UTC);
}

/**
 * Is this automation due right now? At most once per UTC day; weekly honors
 * cadence_meta.days; an optional cadence_meta.hour holds until that hour (UTC -
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
  const hour = effectiveHourGate(a.cadence_meta.hour);
  if (hour !== null && now.getUTCHours() < hour) return false;
  return true;
}

async function loadSettings(userId: string): Promise<UserSettings> {
  const row = await query<{ settings: UserSettings }>(`SELECT settings FROM users WHERE id = $1`, [userId]);
  return row[0]?.settings ?? {};
}

/**
 * How long an approval card stays live. Long enough to survive a weekend away,
 * short enough that a Growth user's five monthly slots aren't held hostage by
 * drafts they were never going to answer. Also a content judgement: a draft built
 * off a trend three days ago is stale anyway, so posting it late is worse than
 * not posting it.
 */
const APPROVAL_TTL_HOURS = 72;

/**
 * Age out unanswered approvals and tell the user it happened. Runs at the top of
 * every tick - before anything is judged due, so the released quota is visible to
 * this same tick's cap checks rather than the next one.
 *
 * The DM is the whole point of doing this loudly. The failure mode being fixed is
 * SILENT: the cap fills with untouched drafts and the agent just stops, with no
 * message and nothing on screen explaining why. Best-effort per user - a Telegram
 * send that fails (or a user with no Telegram at all; the web Approvals inbox
 * shows the expired verdict either way) must not stop the sweep.
 */
async function reapStaleApprovals(): Promise<void> {
  let expired: Awaited<ReturnType<typeof expireStaleApprovals>>;
  try {
    expired = await expireStaleApprovals(APPROVAL_TTL_HOURS);
  } catch (err) {
    console.error("automation approval reaper failed", err);
    return;
  }
  if (expired.length === 0) return;

  // One DM per user, not per run: three expiries at once is one piece of news.
  const byUser = new Map<string, string[]>();
  for (const run of expired) {
    const names = byUser.get(run.user_id) ?? [];
    names.push(run.automation_name);
    byUser.set(run.user_id, names);
  }
  console.log(`[automation.tick] expired ${expired.length} unanswered approval(s) across ${byUser.size} user(s)`);

  for (const [userId, names] of byUser) {
    const unique = [...new Set(names)];
    const which = unique.length === 1 ? `your "${unique[0]}" draft` : `${names.length} drafts (${unique.join(", ")})`;
    await dmChannel(userId)
      .say(
        casualize(
          `⏳ ${which} sat waiting for your yes/no for ${APPROVAL_TTL_HOURS} hours, so I let ${names.length === 1 ? "it" : "them"} go. ` +
            `Nothing was posted, and ${names.length === 1 ? "the slot is" : "the slots are"} back on your monthly Auto Agent count.`,
        ),
      )
      .catch(() => {});
  }
}

export async function handleAutomationTick(): Promise<void> {
  await reapStaleApprovals();

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
