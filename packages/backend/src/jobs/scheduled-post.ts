import { query, queryOne } from "../db/pool.js";
import { dmChannel } from "../telegram/bot.js";
import { publish, publishConfigured, resolveWriteAuth } from "../social/publish.js";
import { mediaForPost, uploadMediaFor } from "../social/media.js";
import type { Platform } from "../lib/types.js";
import type { ScheduledPostJob } from "./boss.js";

/**
 * Fires when a scheduled post comes due (enqueued with startAfter = its time).
 * Claims the row atomically (pending → publishing) so a cancel that landed in
 * the meantime, or a duplicate delivery, can't double-post. Then publishes and
 * DMs the user the outcome — a permalink on success, the real reason on failure
 * (most often: the account isn't connected for posting yet).
 */
export async function handleScheduledPost(job: ScheduledPostJob): Promise<void> {
  // Atomic claim: only the transition out of 'pending' wins. A canceled or
  // already-claimed row returns nothing and we stop.
  const post = await queryOne<{ platform: Platform; content: string }>(
    `UPDATE scheduled_posts SET status = 'publishing', updated_at = now()
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

  if (!publishConfigured(platform)) {
    await fail(`${label} posting isn't configured on this instance`);
    await channel.say(`couldn't post your scheduled ${label} update — posting isn't set up on my end yet.`);
    return;
  }

  const auth = await resolveWriteAuth(job.userId, platform);
  if (!auth) {
    await fail(`${label} not connected for posting`);
    await channel.say(
      `heads up — your scheduled ${label} post didn't go out. your ${label} account isn't connected for posting yet, ` +
        `so i can only draft, not publish. connect it and i'll be able to ship these for you.`,
    );
    return;
  }

  // Media goes up first and separately: the platform wants ids on the post call,
  // and a video can take minutes to transcode. A media failure fails the whole
  // post rather than quietly publishing the text alone — someone who attached a
  // chart meant the chart to be part of the point.
  const media = await mediaForPost(job.scheduledPostId).catch(() => []);
  let mediaIds: string[] = [];
  if (media.length > 0) {
    const uploaded = await uploadMediaFor(auth, platform, media);
    if (!uploaded.ok) {
      await fail(uploaded.error ?? "media upload failed");
      await channel.say(
        `your scheduled ${label} post didn't go out — i couldn't upload the ${media.length === 1 ? "attachment" : "attachments"}: ${uploaded.error ?? "unknown error"}`,
      );
      return;
    }
    mediaIds = uploaded.mediaIds;
  }

  const result = await publish(auth, platform, post.content, mediaIds);
  if (!result.ok) {
    await fail(result.error ?? "unknown publish error");
    await channel.say(`your scheduled ${label} post didn't go through: ${result.error ?? "unknown error"}`);
    return;
  }

  await query(
    `UPDATE scheduled_posts SET status = 'published', external_id = $2, external_url = $3,
            published_at = now(), error = NULL, updated_at = now()
     WHERE id = $1`,
    [job.scheduledPostId, result.externalId ?? null, result.url ?? null],
  );
  await channel.say(`✅ posted to ${label}${result.url ? `:\n${result.url}` : "."}`);
}
