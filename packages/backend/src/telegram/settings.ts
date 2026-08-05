import { query, queryOne } from "../db/pool.js";
import type { UserSettings } from "../lib/time.js";

/**
 * User-facing controls for how the strategist behaves around their life.
 * The cadence gate has always READ quiet hours/timezone - until this command
 * nothing could WRITE them, which meant proactive DMs at 3am were possible.
 */

export type SettingsCommand =
  | { kind: "show" }
  | { kind: "quiet"; start: string; end: string }
  | { kind: "quiet_off" }
  | { kind: "timezone"; tz: string }
  | { kind: "frequency"; perWeek: number }
  | { kind: "mentions"; on: boolean };

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseSettingsCommand(arg: string): SettingsCommand | null {
  const t = arg.trim();
  if (!t) return { kind: "show" };

  const quiet = t.match(/^quiet\s+(\d{1,2}:\d{2})\s*(?:-|\u2013|\u2014|to)\s*(\d{1,2}:\d{2})$/i);
  if (quiet?.[1] && quiet[2]) return { kind: "quiet", start: quiet[1], end: quiet[2] };
  if (/^quiet\s+off$/i.test(t)) return { kind: "quiet_off" };

  const tz = t.match(/^(?:timezone|tz)\s+(\S+)$/i);
  if (tz?.[1]) return validTimezone(tz[1]) ? { kind: "timezone", tz: tz[1] } : null;

  const freq = t.match(/^(?:frequency|freq)\s+(\d{1,2})$/i);
  if (freq?.[1]) {
    const n = Number(freq[1]);
    if (n >= 0 && n <= 7) return { kind: "frequency", perWeek: n };
  }

  const mentions = t.match(/^mentions?\s+(on|off)$/i);
  if (mentions?.[1]) return { kind: "mentions", on: mentions[1].toLowerCase() === "on" };
  return null;
}

export const SETTINGS_USAGE =
  "How I work around your life:\n" +
  "/settings quiet 22:00-08:00  - no proactive messages in that window\n" +
  "/settings quiet off\n" +
  "/settings timezone Asia/Kolkata  - so quiet hours mean YOUR hours\n" +
  "/settings frequency 2  - max proactive messages per week (0-7)\n" +
  "/settings mentions off  - stop alerts about comments/mentions on your posts";

export async function applySettings(userId: string, cmd: SettingsCommand): Promise<string> {
  const row = await queryOne<{ settings: UserSettings }>(`SELECT settings FROM users WHERE id = $1`, [userId]);
  const s: UserSettings = { ...(row?.settings ?? {}) };

  switch (cmd.kind) {
    case "show": {
      const lines = [
        `Quiet hours: ${s.quiet_hours ? `${s.quiet_hours.start}-${s.quiet_hours.end} (${s.quiet_hours.tz ?? s.timezone ?? "UTC"})` : "off - I could message you at any hour"}`,
        `Timezone: ${s.timezone ?? "not set (assuming UTC)"}`,
        `Proactive frequency: ${s.resurface_per_week ?? "plan default"} per week`,
        `Mention/comment alerts: ${s.mention_alerts === true ? "on" : "off (default)"}`,
      ];
      return `${lines.join("\n")}\n\n${SETTINGS_USAGE}`;
    }
    case "quiet":
      s.quiet_hours = { start: cmd.start, end: cmd.end, tz: s.timezone };
      break;
    case "quiet_off":
      delete s.quiet_hours;
      break;
    case "timezone":
      s.timezone = cmd.tz;
      if (s.quiet_hours) s.quiet_hours.tz = cmd.tz;
      break;
    case "frequency":
      s.resurface_per_week = cmd.perWeek;
      break;
    case "mentions":
      s.mention_alerts = cmd.on;
      break;
  }
  await query(`UPDATE users SET settings = $2 WHERE id = $1`, [userId, JSON.stringify(s)]);

  switch (cmd.kind) {
    case "quiet":
      return `Quiet hours set: ${cmd.start}-${cmd.end}${s.timezone ? ` in ${s.timezone}` : " - set /settings timezone so this means your local hours, not UTC"}.`;
    case "quiet_off":
      return "Quiet hours off.";
    case "timezone":
      return `Timezone set to ${cmd.tz}.${s.quiet_hours ? " Quiet hours now follow it." : ""}`;
    case "frequency":
      return cmd.perWeek === 0
        ? "Proactive messages off. I'll only speak when you talk to me (reports still come)."
        : `Capped at ${cmd.perWeek} proactive message${cmd.perWeek === 1 ? "" : "s"} a week.`;
    case "mentions":
      return cmd.on
        ? "Mention alerts on - I'll flag notable comments on your posts and offer replies."
        : "Mention alerts off - I won't surface comments/mentions on your posts anymore.";
    default:
      return "";
  }
}
