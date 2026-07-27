import { query } from "../db/pool.js";
import type { UserSettings } from "../lib/time.js";

/**
 * Deterministic "best time to post" advisory — computed from the user's OWN
 * published post history (real engagement, not guessed), same doctrine as
 * engagement/heuristics.ts and trends/viral-heuristics.ts. Buckets posts into
 * four dayparts in the user's local timezone and recommends whichever daypart
 * has historically earned the most engagement. Below a minimum sample size it
 * degrades honestly to a general best-practice default rather than pretending
 * to have a personalized read on too little data.
 */

export type Daypart = "early_morning" | "morning" | "afternoon" | "evening" | "night";

const DAYPART_LABEL: Record<Daypart, string> = {
  early_morning: "early morning (5–8am)",
  morning: "late morning (8am–12pm)",
  afternoon: "afternoon (12–5pm)",
  evening: "early evening (5–9pm)",
  night: "night (9pm–5am)",
};

/** Minimum posts in a daypart bucket before its average is trusted. */
const MIN_BUCKET_SAMPLE = 3;
/** Minimum total posts before attempting a personalized read at all. */
const MIN_TOTAL_SAMPLE = 8;

export function daypartForHour(hourLocal: number): Daypart {
  if (hourLocal >= 5 && hourLocal < 8) return "early_morning";
  if (hourLocal >= 8 && hourLocal < 12) return "morning";
  if (hourLocal >= 12 && hourLocal < 17) return "afternoon";
  if (hourLocal >= 17 && hourLocal < 21) return "evening";
  return "night";
}

export interface EngagedPost {
  postedAtMs: number;
  /** likeCount + retweetCount*2 + replyCount*2 — amplification weighted, same
   *  spirit as trends/scoring.ts's engagement weighting. */
  engagement: number;
}

export interface BestWindowResult {
  personalized: boolean;
  daypart: Daypart;
  sampleSize: number;
}

/** Local hour-of-day for a UTC instant, in the given IANA timezone. */
function localHour(ms: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).formatToParts(
      new Date(ms),
    );
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    return h === 24 ? 0 : h;
  } catch {
    return new Date(ms).getUTCHours();
  }
}

/** Pure: bucket posts by daypart, pick the highest-average bucket that clears
 *  the minimum sample. Falls back to a fixed general best-practice default
 *  (late morning — the most commonly cited high-traffic window) when there
 *  isn't enough of the user's own data to trust a personalized read. */
export function computeBestWindow(posts: EngagedPost[], tz: string): BestWindowResult {
  if (posts.length < MIN_TOTAL_SAMPLE) {
    return { personalized: false, daypart: "morning", sampleSize: posts.length };
  }
  const buckets = new Map<Daypart, { total: number; n: number }>();
  for (const p of posts) {
    const dp = daypartForHour(localHour(p.postedAtMs, tz));
    const cur = buckets.get(dp) ?? { total: 0, n: 0 };
    cur.total += p.engagement;
    cur.n += 1;
    buckets.set(dp, cur);
  }
  let best: { daypart: Daypart; avg: number; n: number } | null = null;
  for (const [daypart, { total, n }] of buckets) {
    if (n < MIN_BUCKET_SAMPLE) continue;
    const avg = total / n;
    if (!best || avg > best.avg) best = { daypart, avg, n };
  }
  if (!best) return { personalized: false, daypart: "morning", sampleSize: posts.length };
  return { personalized: true, daypart: best.daypart, sampleSize: posts.length };
}

/** Does `candidateMs` fall inside the recommended daypart, local time? */
export function isInRecommendedWindow(candidateMs: number, tz: string, result: BestWindowResult): boolean {
  return daypartForHour(localHour(candidateMs, tz)) === result.daypart;
}

const engagementWeight = (e: { likeCount?: number; retweetCount?: number; replyCount?: number }) =>
  Math.max(0, e.likeCount ?? 0) + Math.max(0, e.retweetCount ?? 0) * 2 + Math.max(0, e.replyCount ?? 0) * 2;

/** Load the user's own published posts with engagement, for the best-window read. */
async function loadEngagedPosts(userId: string): Promise<EngagedPost[]> {
  const rows = await query<{ captured_at: string; engagement: Record<string, number> | null }>(
    `SELECT captured_at::text, metadata->'engagement' AS engagement
     FROM captures
     WHERE user_id = $1
       AND source IN ('x_import','linkedin_import')
       AND metadata->>'published' = 'true'
       AND metadata->'engagement' IS NOT NULL`,
    [userId],
  );
  return rows
    .map((r) => ({ postedAtMs: new Date(r.captured_at).getTime(), engagement: engagementWeight(r.engagement ?? {}) }))
    .filter((p) => Number.isFinite(p.postedAtMs));
}

/**
 * The advisory line appended to a scheduling confirmation — always present
 * (the ask is "make sure to advise", not "only when it matters"), honest about
 * whether it's personalized or a general default, and never blocks scheduling.
 */
export async function bestTimeAdvisory(userId: string, settings: UserSettings, candidateWhenMs: number): Promise<string> {
  const tz = settings.timezone ?? "UTC";
  const posts = await loadEngagedPosts(userId).catch(() => [] as EngagedPost[]);
  const result = computeBestWindow(posts, tz);
  const label = DAYPART_LABEL[result.daypart];
  const basis = result.personalized
    ? "based on your own posts' engagement"
    : "general best-practice default — post a bit more and I'll personalize this to your own data";

  if (isInRecommendedWindow(candidateWhenMs, tz, result)) {
    return `this lands right in your best window (${label}, ${basis}).`;
  }
  return `heads up: your best window tends to be ${label} (${basis}) — this slot is outside it. keeping it as scheduled, just flagging.`;
}
