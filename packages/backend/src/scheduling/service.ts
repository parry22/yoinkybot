import { getBoss, QUEUES } from "../jobs/boss.js";
import { query, queryOne } from "../db/pool.js";
import type { Platform } from "../lib/types.js";
import { entitlementsFor, withinCap, remainingFor } from "../billing/entitlements.js";
import { attachMediaToPost } from "../social/media.js";

/**
 * A link ANYWHERE in a scheduled post's body is refused outright — not stripped,
 * not warned-and-allowed. Both platforms' algorithms suppress reach on posts
 * that route traffic off-platform (the same reach doctrine already baked into
 * REACH_PRINCIPLES for generated drafts — see prompts/style.ts — but a scheduled
 * post can also be raw pasted text that never went through drafting, so it needs
 * its own hard gate here). Matches http(s):// URLs and bare www./domain-style
 * links; a stray "e.g." or a version number like "5.2" won't false-positive.
 */
const LINK_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|io|co|net|org|xyz|app|dev|ai|me|so)\b\S*/i;

export function containsLink(text: string): boolean {
  return LINK_RE.test(text);
}

/**
 * The scheduling layer. Queuing a post inserts a row and hands pg-boss a job
 * with startAfter = the target time (pg-boss accepts an absolute Date), so the
 * scheduler is the queue we already run — no cron polling. The job re-reads
 * status at fire time, so cancel is a pure status flip here (scheduled-post.ts).
 */

export interface ScheduledPost {
  id: string;
  platform: Platform;
  content: string;
  scheduled_for: string;
  status: "pending" | "publishing" | "published" | "failed" | "canceled";
  external_url: string | null;
  error: string | null;
}

export interface ScheduleResult {
  ok: boolean;
  id?: string;
  reason?: string;
  /** True when the rejection was the per-plan monthly cap (web maps this to 429 + upgrade). */
  capReached?: boolean;
}

/** Queue a post for publishing at `scheduledFor`. Rejects past/invalid times. */
export async function schedulePost(
  userId: string,
  input: {
    platform: Platform;
    content: string;
    scheduledFor: Date;
    draftId?: string;
    /** Staged scheduled_post_media ids to bind to this post once it exists. */
    mediaIds?: string[];
  },
): Promise<ScheduleResult> {
  const content = input.content.trim();
  const mediaIds = input.mediaIds ?? [];
  // A post carrying media needs no text — an image on its own is a valid tweet.
  if (!content && mediaIds.length === 0) return { ok: false, reason: "nothing to post" };
  if (containsLink(content)) {
    return {
      ok: false,
      reason: "links aren't allowed in scheduled posts — they tank reach on both platforms. drop the link and post it as the first reply once this goes out",
    };
  }
  const when = input.scheduledFor;
  if (Number.isNaN(when.getTime())) return { ok: false, reason: "couldn't read that time" };
  // A small grace window absorbs clock skew / "post it now" phrasing.
  if (when.getTime() < Date.now() - 60_000) return { ok: false, reason: "that time is in the past" };

  // Per-plan monthly cap (Growth = 30/mo, Scale = unlimited). Checked centrally
  // here so web, the Telegram schedule tool, and automation auto-scheduling all
  // inherit it. Scale's null cap never blocks. The `CAP_REACHED:` prefix lets the
  // web boundary map this to a 429 + upgrade CTA (other reasons stay 400).
  const ent = await entitlementsFor(userId);
  if (!withinCap(await monthlyScheduledCount(userId), ent.scheduledPostsPerMonth)) {
    return {
      ok: false,
      capReached: true,
      reason: `you've used all ${ent.scheduledPostsPerMonth} scheduled posts this month — upgrade to Scale for unlimited.`,
    };
  }

  const row = await queryOne<{ id: string }>(
    `INSERT INTO scheduled_posts (user_id, platform, content, draft_id, scheduled_for)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [userId, input.platform, content, input.draftId ?? null, when.toISOString()],
  );
  if (!row) return { ok: false, reason: "couldn't save that" };

  // Bind staged uploads before the job is queued, so the publisher can never
  // fire against a post whose attachments haven't been claimed yet.
  if (mediaIds.length > 0) {
    const attached = await attachMediaToPost(userId, row.id, mediaIds);
    if (attached !== mediaIds.length) {
      // Ownership/staging mismatch — roll the post back rather than publish a
      // post that silently lost an attachment.
      await query(`DELETE FROM scheduled_posts WHERE id = $1`, [row.id]);
      return { ok: false, reason: "those attachments are no longer available — re-upload them" };
    }
  }

  const jobId = await getBoss().send(
    QUEUES.scheduledPost,
    { scheduledPostId: row.id, userId },
    { startAfter: when },
  );
  await query(`UPDATE scheduled_posts SET job_id = $2 WHERE id = $1`, [row.id, jobId]);
  return { ok: true, id: row.id };
}

/** The user's still-pending scheduled posts, soonest first. */
export async function listScheduled(userId: string): Promise<ScheduledPost[]> {
  return query<ScheduledPost>(
    `SELECT id, platform, content, scheduled_for::text, status, external_url, error
     FROM scheduled_posts
     WHERE user_id = $1 AND status = 'pending'
     ORDER BY scheduled_for ASC
     LIMIT 25`,
    [userId],
  );
}

/** Posts scheduled this calendar month (canceled ones don't count — canceling
 *  frees the slot; failed/published still consume it). Drives the monthly cap. */
export async function monthlyScheduledCount(userId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM scheduled_posts
     WHERE user_id = $1 AND status <> 'canceled' AND created_at >= date_trunc('month', now())`,
    [userId],
  );
  return Number(row?.n ?? 0);
}

export interface ScheduledStatus {
  used: number;
  /** null = unlimited (Scale). */
  cap: number | null;
  /** null = unlimited. */
  remaining: number | null;
}

/** Monthly scheduling usage for the current plan — for the Scheduled screen. */
export async function scheduledStatus(userId: string): Promise<ScheduledStatus> {
  const ent = await entitlementsFor(userId);
  const used = await monthlyScheduledCount(userId);
  return { used, cap: ent.scheduledPostsPerMonth, remaining: remainingFor(used, ent.scheduledPostsPerMonth) };
}

/** Cancel a pending scheduled post. The due job re-checks status, so this alone
 *  is enough to stop it — no need to reach into pg-boss. */
export async function cancelScheduled(userId: string, id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE scheduled_posts SET status = 'canceled', updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING id`,
    [id, userId],
  );
  return !!row;
}
