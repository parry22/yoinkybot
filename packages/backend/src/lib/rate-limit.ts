/**
 * Per-user burst rate limiting for the endpoints that spend real money.
 *
 * This is the layer BELOW the paywall and ABOVE the monthly caps. The paywall
 * (web/lib/entitlements.ts#requirePaid) decides whether you may spend at all;
 * the plan entitlements decide how much you may spend in a month; neither
 * bounds how fast. A paid user — or anyone holding a live session — could fire
 * dozens of concurrent /api/chat/stream or Buyer Radar scans and burn a day of
 * model + twitterapi.io budget in minutes, with the monthly cap only noticing
 * afterwards. This bounds the rate.
 *
 * Fixed-window counter in Postgres (migration 0036), NOT an in-process map: the
 * web app is Vercel functions, so an in-memory counter limits one ephemeral
 * instance rather than one user. The window resets lazily inside the same
 * UPSERT that increments it, so the whole check is one atomic statement — two
 * simultaneous requests can never both read a stale count.
 *
 * Fail-OPEN on a database error. These limits protect the budget, not
 * correctness; a transient Neon blip must not take Compose down for everyone.
 */
import { query } from "../db/pool.js";

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Requests left in the current window (0 when limited). */
  remaining: number;
  /** Seconds until the window resets — what to put in Retry-After. */
  retryAfterSec: number;
}

/**
 * The named buckets. Kept in one place so the limits are reviewable as a set
 * rather than scattered across route files, and so a bucket name can never
 * drift between the route and the table.
 *
 * Sizing rule of thumb: a human doing the thing as fast as they plausibly can,
 * with headroom, then a hard stop well below "this hurts". Each of these is a
 * multi-second, multi-model-call operation, so single-digit-per-minute is
 * generous for a real user and ruinous for a script.
 */
export const RATE_LIMITS = {
  /** Compose / chat turn — several model calls + retrieval per turn. */
  chat: { limit: 12, windowSec: 60 },
  /** One-shot draft (full drafting pipeline). */
  draft: { limit: 8, windowSec: 60 },
  /** Buyer Radar scan: paid twitterapi.io searches + a composition loop each. */
  buyer_scan: { limit: 3, windowSec: 600 },
  /** Manual "run this automation now" — a full agent run. */
  automation_run: { limit: 6, windowSec: 300 },
  /** The Auto Agent setup interview + agent build (model call per turn). */
  automation_interview: { limit: 30, windowSec: 300 },
  /**
   * Trends/virals refresh — Apify + twitterapi.io spend. Looser than the other
   * spend buckets on purpose: this one fires AUTOMATICALLY whenever the
   * Inspiration feed renders empty, so ordinary navigation in and out of the
   * page consumes it. The server-side stale guard already makes repeats cheap
   * no-ops; this bucket only needs to stop a genuine hammer.
   */
  inspiration_refresh: { limit: 8, windowSec: 600 },
  /** Approval verdict; "edit" re-drafts through the model. */
  automation_verdict: { limit: 20, windowSec: 300 },
  /** Media upload → staging (Blob write + probe). */
  media_upload: { limit: 20, windowSec: 300 },
  /** Reply analytics — a paid timeline read. */
  analytics_replies: { limit: 10, windowSec: 300 },
  /**
   * In-app feedback. Every submission fires a Resend email + a Telegram DM to
   * the operator, so this one is anti-spam for OUR inbox, not budget: a slow
   * drip is fine, a flood is not.
   */
  feedback: { limit: 5, windowSec: 3600 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

/**
 * Consume one unit from (user, bucket). Returns ok:false when the window is
 * already full — the caller should answer 429 with `retryAfterSec`.
 *
 * The single statement does all four things: insert-or-find the row, reset the
 * window if it has aged out, increment, and hand back both the new count and
 * the seconds left. `count` in the RETURNING is the value INCLUDING this
 * request, so the check is `count <= limit`.
 */
export async function consumeRateLimit(
  userId: string,
  bucket: RateLimitBucket,
): Promise<RateLimitResult> {
  const rule = RATE_LIMITS[bucket];
  try {
    const rows = await query<{ count: number; age_sec: number }>(
      `INSERT INTO rate_limits (user_id, bucket, window_start, count)
       VALUES ($1, $2, now(), 1)
       ON CONFLICT (user_id, bucket) DO UPDATE SET
         count = CASE
           WHEN rate_limits.window_start < now() - make_interval(secs => $3::double precision)
           THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE
           WHEN rate_limits.window_start < now() - make_interval(secs => $3::double precision)
           THEN now() ELSE rate_limits.window_start END
       RETURNING count, EXTRACT(EPOCH FROM (now() - window_start))::double precision AS age_sec`,
      [userId, bucket, rule.windowSec],
    );
    const row = rows[0];
    if (!row) return { ok: true, remaining: rule.limit - 1, retryAfterSec: 0 };
    const count = Number(row.count);
    const retryAfterSec = Math.max(1, Math.ceil(rule.windowSec - Number(row.age_sec)));
    if (count > rule.limit) return { ok: false, remaining: 0, retryAfterSec };
    return { ok: true, remaining: Math.max(0, rule.limit - count), retryAfterSec };
  } catch (err) {
    // Fail open — see the header comment.
    console.error("rate limit check failed (allowing request)", bucket, err);
    return { ok: true, remaining: rule.limit, retryAfterSec: 0 };
  }
}

/** Human-facing copy for a 429, in Yoinky's register. */
export function rateLimitMessage(retryAfterSec: number): string {
  if (retryAfterSec <= 90) return `easy — you're going faster than I can think. try again in ${Math.ceil(retryAfterSec)}s.`;
  const mins = Math.ceil(retryAfterSec / 60);
  return `you've hit the burst limit on this one. try again in about ${mins} min${mins === 1 ? "" : "s"}.`;
}
