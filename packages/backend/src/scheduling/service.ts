import { getBoss, QUEUES } from "../jobs/boss.js";
import { query, queryOne } from "../db/pool.js";
import type { Platform } from "../lib/types.js";

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
}

/** Queue a post for publishing at `scheduledFor`. Rejects past/invalid times. */
export async function schedulePost(
  userId: string,
  input: { platform: Platform; content: string; scheduledFor: Date; draftId?: string },
): Promise<ScheduleResult> {
  const content = input.content.trim();
  if (!content) return { ok: false, reason: "nothing to post" };
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

  const row = await queryOne<{ id: string }>(
    `INSERT INTO scheduled_posts (user_id, platform, content, draft_id, scheduled_for)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [userId, input.platform, content, input.draftId ?? null, when.toISOString()],
  );
  if (!row) return { ok: false, reason: "couldn't save that" };

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
