import { query, queryOne } from "../db/pool.js";
import { dmChannel } from "../telegram/bot.js";
import { ensureWriteAuth, markWriteAuthDead, publish, publishConfigured } from "../social/publish.js";
import { mediaForPost, uploadMediaFor } from "../social/media.js";
import { getBoss, QUEUES } from "./boss.js";
import type { Platform } from "../lib/types.js";
import type { ScheduledPostJob } from "./boss.js";

/**
 * Fires when a scheduled post comes due (enqueued with startAfter = its time).
 * Claims the row atomically (pending → publishing) so a cancel that landed in
 * the meantime, or a duplicate delivery, can't double-post. Then publishes and
 * DMs the user the outcome - a permalink on success, the real reason on failure
 * (most often: the account isn't connected for posting yet).
 *
 * The DM is best-effort, not the contract: dmChannel().say() no-ops for a user
 * with no telegram_id, which is every web-only user. Every terminal state is
 * therefore also written to the row (`status` + `error`) and the Scheduled screen
 * shows recently failed posts with that error - see scheduling/service.ts#listScheduled.
 */
export async function handleScheduledPost(job: ScheduledPostJob): Promise<void> {
  // Atomic claim: only the transition out of 'pending' wins. A canceled or
  // already-claimed row returns nothing and we stop. The attempt counter is what
  // bounds the reaper below - see reapStuckPublishing.
  const post = await queryOne<{ platform: Platform; content: string }>(
    `UPDATE scheduled_posts
        SET status = 'publishing', publish_attempts = publish_attempts + 1, updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING platform, content`,
    [job.scheduledPostId, job.userId],
  );
  if (!post) return; // canceled, missing, or already handled

  const platform: Platform = post.platform;
  const channel = dmChannel(job.userId);
  const label = platform === "x" ? "X" : "LinkedIn";

  const fail = async (reason: string) => {
    await query(`UPDATE scheduled_posts SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [
      job.scheduledPostId,
      reason,
    ]);
  };
  /** Release the claim so the post stays retryable. Only for genuinely transient
   *  conditions - anything the user has to act on must go through `fail`, or a
   *  broken post loops until it runs out of attempts. */
  const releaseClaim = async (reason: string) => {
    await query(`UPDATE scheduled_posts SET status = 'pending', error = $2, updated_at = now() WHERE id = $1`, [
      job.scheduledPostId,
      reason,
    ]);
  };

  if (!(await publishConfigured(platform, job.userId))) {
    await fail(`${label} posting isn't configured on this instance`);
    await channel.say(`couldn't post your scheduled ${label} update - posting isn't set up on my end yet.`);
    return;
  }

  // Renew the token if it's expired or about to be. Until this existed the
  // publisher used whatever access token was stored at connect time, which for X
  // is dead after ~2 hours - so a post scheduled for tomorrow reliably 401'd.
  const resolved = await ensureWriteAuth(job.userId, platform);
  if (!resolved.ok) {
    if (resolved.reason === "refresh_failed") {
      // The token endpoint was unreachable, not the credential rejected. Put the
      // post back and rethrow so pg-boss applies the queue's retry/backoff,
      // rather than burning the post on X having a bad minute.
      await releaseClaim(resolved.detail);
      throw new Error(resolved.detail);
    }
    await fail(resolved.detail);
    await channel.say(
      resolved.reason === "needs_reauth"
        ? `heads up - your scheduled ${label} post didn't go out. your ${label} connection expired and i can't renew it, ` +
            `so you'll need to reconnect ${label} for posting. the post is still saved.`
        : `heads up - your scheduled ${label} post didn't go out. your ${label} account isn't connected for posting yet, ` +
            `so i can only draft, not publish. connect it and i'll be able to ship these for you.`,
    );
    return;
  }
  const auth = resolved.auth;

  // Media goes up first and separately: the platform wants ids on the post call,
  // and a video can take minutes to transcode. A media failure fails the whole
  // post rather than quietly publishing the text alone - someone who attached a
  // chart meant the chart to be part of the point.
  const media = await mediaForPost(job.scheduledPostId).catch(() => []);
  let mediaIds: string[] = [];
  if (media.length > 0) {
    const uploaded = await uploadMediaFor(auth, platform, media);
    if (!uploaded.ok) {
      // A 401 mid-upload means the token died between the refresh and the upload
      // (revoked, or app access pulled). Say the actionable thing, not "upload
      // failed", and drop the credential so nothing else retries against it.
      if (uploaded.authExpired) await markWriteAuthDead(job.userId, platform);
      const reason = uploaded.authExpired
        ? `${label} rejected the upload - the connection expired, reconnect ${label} to publish`
        : (uploaded.error ?? "media upload failed");
      await fail(reason);
      await channel.say(
        `your scheduled ${label} post didn't go out - i couldn't upload the ${media.length === 1 ? "attachment" : "attachments"}: ${reason}`,
      );
      return;
    }
    mediaIds = uploaded.mediaIds;
  }

  const result = await publish(auth, platform, post.content, mediaIds, media);
  if (!result.ok) {
    if (result.authExpired) await markWriteAuthDead(job.userId, platform);
    const reason = result.authExpired
      ? `${label} connection expired - reconnect ${label} to publish`
      : (result.error ?? "unknown publish error");
    await fail(reason);
    await channel.say(`your scheduled ${label} post didn't go through: ${reason}`);
    return;
  }

  const published=await queryOne<{workspace_id:string|null;content_asset_id:string|null}>(
    `UPDATE scheduled_posts SET status = 'published', external_id = $2, external_url = $3,
            published_at = now(), error = NULL, updated_at = now()
     WHERE id = $1 RETURNING workspace_id,content_asset_id`,
    [job.scheduledPostId, result.externalId ?? null, result.url ?? null],
  );
  if(published?.workspace_id&&published.content_asset_id){
    await query(`UPDATE content_assets SET status='published',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status='scheduled'`,[published.content_asset_id,published.workspace_id]);
    await query(`INSERT INTO workspace_audit_logs (workspace_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,'publication.published','publication',$3,jsonb_build_object('asset_id',$4::text,'external_url',$5::text))`,[published.workspace_id,job.userId,job.scheduledPostId,published.content_asset_id,result.url??null]);
  }
  await channel.say(`✅ posted to ${label}${result.url ? `:\n${result.url}` : "."}`);
}

/**
 * How long a row may sit in 'publishing' before we assume the run that claimed it
 * is gone. Must be comfortably longer than the queue's expiry (boss.ts sets 20
 * minutes for posts.scheduled) so a slow-but-alive publish - a big video's
 * transcode poll alone budgets 5 minutes - is never reaped out from under itself
 * and double-posted.
 */
const STUCK_AFTER_MINUTES = 30;

/**
 * Give up after this many claims. A post that crashes the worker every time it
 * runs would otherwise bounce between 'publishing' and 'pending' forever.
 */
const MAX_PUBLISH_ATTEMPTS = 3;

/**
 * Return posts stranded in 'publishing' to the queue (or fail them honestly).
 *
 * THE BUG THIS FIXES: handleScheduledPost claims the row before it does any
 * work, and every retry path requires status='pending'. If the process died - or
 * pg-boss expired the job - between the claim and a terminal write, the retry's
 * claim matched nothing, so the row sat at 'publishing' with `error` NULL
 * forever: no post, no DM, no failure the user could see, and the slot silently
 * consumed. That was reachable in ordinary use, since a video's transcode poll
 * alone could outlast the queue's old 10-minute expiry.
 *
 * Recovery re-sends the pg-boss job rather than only flipping the status,
 * because the job that stranded the row is by definition gone - a 'pending' row
 * with nothing queued behind it would never fire again.
 *
 * Safe on a single-instance backend (docs/INTERNAL.md): the only writer racing
 * this is the publish handler itself, and the 30-minute threshold puts the
 * reclaim far outside any live run's window.
 */
export async function reapStuckPublishing(): Promise<void> {
  const rows = await query<{ id: string; user_id: string; status: string; platform: Platform }>(
    `UPDATE scheduled_posts
        SET status = CASE WHEN publish_attempts >= $2::int THEN 'failed' ELSE 'pending' END,
            error = CASE WHEN publish_attempts >= $2::int
                         THEN 'publishing stalled and didn''t recover after ' || $2::int || ' attempts'
                         ELSE error END,
            updated_at = now()
      WHERE status = 'publishing'
        AND updated_at < now() - make_interval(mins => $1::int)
      RETURNING id, user_id, status, platform`,
    [STUCK_AFTER_MINUTES, MAX_PUBLISH_ATTEMPTS],
  );
  if (rows.length === 0) return;

  for (const row of rows) {
    const label = row.platform === "x" ? "X" : "LinkedIn";
    if (row.status === "pending") {
      console.warn(`scheduled post ${row.id} was stuck in publishing - requeued`);
      // startAfter is deliberately omitted: it's already overdue.
      await getBoss()
        .send(QUEUES.scheduledPost, { scheduledPostId: row.id, userId: row.user_id })
        .catch((err) => console.error(`failed to requeue stuck scheduled post ${row.id}`, err));
      continue;
    }
    console.error(`scheduled post ${row.id} gave up after ${MAX_PUBLISH_ATTEMPTS} publish attempts`);
    await dmChannel(row.user_id)
      .say(
        `your scheduled ${label} post kept stalling mid-publish, so i've stopped retrying it. ` +
          `it's marked failed on your Scheduled screen - re-queue it there when you want another go.`,
      )
      .catch(() => {});
  }
}
