export interface QuietHours {
  start: string; // "22:00"
  end: string; // "08:00"
  tz?: string; // IANA, e.g. "Asia/Kolkata"
}

export interface UserSettings {
  quiet_hours?: QuietHours;
  resurface_per_week?: number;
  timezone?: string;
  /** Deliver alerts about mentions/comments on the user's own posts (reputation
   *  alerts + reply-draft offers). Default OFF for everyone — only true when the
   *  user explicitly opts in via `/settings mentions on`. */
  mention_alerts?: boolean;
}

/** Minutes since local midnight in the given timezone. */
export function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

function parseHm(s: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins < 24 * 60 ? mins : undefined;
}

/** True when `now` falls inside the user's quiet window (windows may wrap midnight). */
export function inQuietHours(settings: UserSettings, now: Date = new Date()): boolean {
  const qh = settings.quiet_hours;
  if (!qh) return false;
  const start = parseHm(qh.start);
  const end = parseHm(qh.end);
  if (start === undefined || end === undefined) return false;
  const tz = qh.tz ?? settings.timezone ?? "UTC";
  let mins: number;
  try {
    mins = localMinutes(now, tz);
  } catch {
    mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  if (start === end) return false;
  return start < end ? mins >= start && mins < end : mins >= start || mins < end;
}
