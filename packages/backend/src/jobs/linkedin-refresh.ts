import { query } from "../db/pool.js";
import { isPaidOrExempt } from "../billing/entitlements.js";
import { pullLinkedInProfile } from "../capture/imports/apify-profile.js";
import { createCapture } from "../capture/service.js";
import { runAsUser } from "../byok/context.js";
import { getBoss, QUEUES } from "./boss.js";

interface Target {
  user_id: string;
  handle: string;
  telegram_id: string | null;
}

const MAX_POSTS = 100;
const MIN_AGE_HOURS = 20;

/** Daily public LinkedIn re-pull: keeps reactions/comments/reposts current and
 * adds posts published since connect. It never uses or broadens the member's
 * OAuth grant; Apify reads the already-connected public profile URL. */
export async function handleLinkedInRefresh(): Promise<void> {
  const targets = await query<Target>(
    `SELECT ca.user_id, ca.handle, u.telegram_id
     FROM connected_accounts ca
     JOIN users u ON u.id = ca.user_id
     WHERE ca.platform = 'linkedin' AND ca.status = 'ingested'
       AND (ca.last_refresh_attempt_at IS NULL
            OR ca.last_refresh_attempt_at < now() - make_interval(hours => $1::int))
     ORDER BY ca.last_refresh_attempt_at ASC NULLS FIRST, ca.id ASC`,
    [MIN_AGE_HOURS],
  );

  for (const target of targets) {
    try {
      // This is a paid provider pull and new posts fan out into extraction. Do
      // not run it forever for a lapsed account.
      if (!(await isPaidOrExempt({ id: target.user_id, telegram_id: target.telegram_id }))) continue;
      await runAsUser(target.user_id, () => refreshOne(target));
    } catch (err) {
      console.error(`[linkedin.refresh] failed for ${target.handle} (${target.user_id})`, err);
    } finally {
      await query(
        `UPDATE connected_accounts SET last_refresh_attempt_at = now()
         WHERE user_id = $1 AND platform = 'linkedin'`,
        [target.user_id],
      ).catch(() => {});
    }
  }
}

async function refreshOne(target: Target): Promise<void> {
  const pull = await pullLinkedInProfile(target.handle, MAX_POSTS);
  const posts = pull.posts.filter((post) => post.url && post.text.length >= 20);
  posts.sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
  let updated = 0;
  let added = 0;
  const boss = getBoss();

  for (const post of posts) {
    const clientId = `linkedin:${post.url}`;
    const rows = await query<{ id: string }>(
      `UPDATE captures SET metadata = metadata || $3::jsonb
       WHERE user_id = $1 AND client_id = $2 RETURNING id`,
      [
        target.user_id,
        clientId,
        JSON.stringify({ engagement: post.engagement ?? {}, ...(post.media?.length ? { media: post.media } : {}) }),
      ],
    );
    if (rows.length) {
      updated++;
      continue;
    }
    const { capture, created } = await createCapture({
      userId: target.user_id,
      source: "linkedin_import",
      rawText: post.text,
      capturedAt: post.postedAt,
      clientId,
      metadata: {
        published: true,
        url: post.url,
        engagement: post.engagement ?? {},
        ...(post.media?.length ? { media: post.media } : {}),
      },
      enqueue: false,
    });
    if (created) {
      await boss.send(QUEUES.extract, { captureId: capture.id, userId: target.user_id });
      added++;
    }
  }

  await query(
    `UPDATE connected_accounts SET last_refreshed_at = now(), meta = meta || $2::jsonb
     WHERE user_id = $1 AND platform = 'linkedin'`,
    [target.user_id, JSON.stringify(pull.meta ?? {})],
  );
  console.log(`[linkedin.refresh] ${target.handle}: ${updated} metrics updated, ${added} posts added`);
}
