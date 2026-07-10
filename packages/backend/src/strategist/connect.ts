import { query, queryOne, withTransaction } from "../db/pool.js";
import { getBoss, QUEUES, type IngestProfileJob } from "../jobs/boss.js";
import { createCapture } from "../capture/service.js";
import { pullXProfile, pullLinkedInProfile } from "../capture/imports/apify-profile.js";
import { applyRecencyWindow } from "../capture/imports/x.js";
import { sendTelegram } from "../telegram/bot.js";

export type Platform = "x" | "linkedin";

// Recent history is what the diagnosis is about — a year-deep scrape mostly
// buys extraction time, not insight. 90 days, floored at 40 posts (the read
// needs ~30-40 to not be thin), capped at 120 so ingest time stays predictable.
const INGEST_WINDOW_DAYS = 90;
const INGEST_MIN_POSTS = 40;
const INGEST_MAX_POSTS = 120;

/**
 * Honest wall-clock estimate for reading N posts: extraction + embedding/link
 * jobs run ~4-wide at roughly a second per post per stage, plus the diagnosis
 * generation and reveal at the end. Exported for the connect-time ETA message.
 */
export function estimateIngestMinutes(postCount: number): number {
  return Math.max(1, Math.ceil((postCount + 40) / 60));
}

/**
 * A fresh connect must REPLACE the prior imported corpus for this platform, not
 * pile new posts on top of stale ones. This is what makes a diagnosis reflect
 * the actual scraped profile: it clears any earlier scrape of a different handle
 * AND the /demo seed (which lands as x_import), while leaving the user's own
 * hand-typed Telegram thoughts and the other platform untouched. Positions
 * derived solely from the cleared memories go too (they're a derived layer the
 * fresh extraction rebuilds). Run before inserting the new posts.
 */
async function replaceImportedCorpus(userId: string, source: "x_import" | "linkedin_import"): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `DELETE FROM memories
       WHERE user_id = $1
         AND capture_id IN (SELECT id FROM captures WHERE user_id = $1 AND source = $2)
       RETURNING id`,
      [userId, source],
    );
    const memIds = rows.map((r) => r.id);
    if (memIds.length) {
      // Drop positions whose evidence came from the memories we just removed.
      await client.query(`DELETE FROM positions WHERE user_id = $1 AND source_memory_ids && $2::uuid[]`, [
        userId,
        memIds,
      ]);
    }
    await client.query(`DELETE FROM captures WHERE user_id = $1 AND source = $2`, [userId, source]);
  });
}

/**
 * Kick off connecting a public account. Upserts the connected_accounts row and
 * enqueues the (slow) ingestion job; returns immediately so the UI can poll status.
 */
export async function startConnect(userId: string, platform: Platform, handle: string): Promise<string> {
  const account = await queryOne<{ id: string }>(
    `INSERT INTO connected_accounts (user_id, platform, handle, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (user_id, platform)
     DO UPDATE SET handle = EXCLUDED.handle, status = 'pending'
     RETURNING id`,
    [userId, platform, handle],
  );
  await getBoss().send(QUEUES.ingestProfile, { accountId: account!.id, userId });
  return account!.id;
}

/**
 * Ingest a connected account's full public history. Each post becomes an
 * immutable capture (marked published, so it feeds the voice profile) and flows
 * through the standard extraction pipeline — their public history IS their brand
 * memory. When done, advances the user to the 'connected' stage and triggers the
 * diagnosis readiness check.
 */
export async function handleIngestProfile(job: IngestProfileJob): Promise<void> {
  const account = await queryOne<{ id: string; platform: Platform; handle: string }>(
    `UPDATE connected_accounts SET status = 'ingesting' WHERE id = $1 RETURNING id, platform, handle`,
    [job.accountId],
  );
  if (!account) return;
  const source = account.platform === "x" ? "x_import" : "linkedin_import";
  const label = account.platform === "x" ? "X" : "LinkedIn";
  const shown = account.platform === "x" ? `@${account.handle}` : account.handle;

  try {
    const pull =
      account.platform === "x"
        ? await pullXProfile(account.handle, INGEST_MAX_POSTS + 40, {
            sinceDays: INGEST_WINDOW_DAYS,
            minPosts: INGEST_MIN_POSTS,
          })
        : await pullLinkedInProfile(account.handle);

    const usable = applyRecencyWindow(
      pull.posts.filter((p) => p.text.length >= 20),
      { days: INGEST_WINDOW_DAYS, minPosts: INGEST_MIN_POSTS, maxPosts: INGEST_MAX_POSTS },
    );
    if (usable.length === 0) {
      // Nothing came back — don't wipe what they already have. Tell them why.
      await query(`UPDATE connected_accounts SET status = 'failed' WHERE id = $1`, [account.id]);
      await sendTelegram(
        job.userId,
        `couldn't pull any posts from ${shown} on ${label}. two usual reasons: the handle's off, ` +
          `or the account's private/has almost nothing public. double-check the handle and try connecting again, ` +
          `or send me a few of your actual takes and i'll work from those.`,
      );
      return;
    }

    // The pull is done, so the post count — and therefore the reading time —
    // is now a fact, not a guess. Tell them before the silent stretch starts.
    const eta = estimateIngestMinutes(usable.length);
    await sendTelegram(
      job.userId,
      `got ${usable.length} posts from your last ~3 months on ${label}. ` +
        `give me about ${eta} minute${eta === 1 ? "" : "s"} to actually read them, then i'll come back with the full read.`,
    ).catch(() => {});

    // Only now that we have a real pull, replace the old imported corpus (incl.
    // the /demo seed) so the diagnosis reflects THIS profile, not stale data.
    await replaceImportedCorpus(job.userId, source);

    // Oldest first: extraction (and therefore belief reconciliation) must run in
    // chronological order, or an OLD post processed later would supersede the
    // belief stated in a NEWER one.
    usable.sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());

    const boss = getBoss();
    let imported = 0;
    for (const post of usable) {
      const { capture, created } = await createCapture({
        userId: job.userId,
        source,
        rawText: post.text,
        capturedAt: post.postedAt,
        clientId: post.url ? `${account.platform}:${post.url}` : undefined,
        metadata: {
          published: true,
          url: post.url ?? null,
          connected_account: account.id,
          ...(post.engagement ? { engagement: post.engagement } : {}),
        },
        enqueue: false,
      });
      if (created) {
        await boss.send(QUEUES.extract, { captureId: capture.id, userId: job.userId });
        imported++;
      }
    }

    await query(
      `UPDATE connected_accounts
       SET status = 'ingested', post_count = $2, meta = $3, last_ingested_at = now()
       WHERE id = $1`,
      [account.id, imported, JSON.stringify(pull.meta)],
    );
    // Advance the stage (only forward — never regress a user who's further along).
    // 'profile_set' is the profile-first arc reaching connect; 'new' is the
    // connect-first escape hatch.
    await query(
      `UPDATE users SET strategist_stage = 'connected'
       WHERE id = $1 AND strategist_stage IN ('new','profile_set')`,
      [job.userId],
    );
    // Kick the diagnosis readiness check; it waits for extraction to finish.
    await boss.send(QUEUES.diagnose, { userId: job.userId, attempt: 0 });
  } catch (err) {
    await query(`UPDATE connected_accounts SET status = 'failed' WHERE id = $1`, [account.id]);
    await sendTelegram(
      job.userId,
      `something broke while pulling ${shown} from ${label}. give it another go with /connect in a minute. ` +
        `if it keeps failing, send me a few of your takes directly and i'll read those instead.`,
    ).catch(() => {});
    throw err;
  }
}

export async function connectedAccounts(userId: string) {
  return query(
    `SELECT id, platform, handle, status, post_count, last_ingested_at
     FROM connected_accounts WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
}

/**
 * If the user has ingested exactly ONE platform, returns the other one — the
 * natural "want me to pull your LinkedIn too?" moment. Null if they've
 * connected both already, or somehow neither (shouldn't happen once goals are
 * set, but never offer a platform ask in that case).
 */
export async function otherUnconnectedPlatform(userId: string): Promise<Platform | null> {
  const rows = await query<{ platform: Platform }>(
    `SELECT platform FROM connected_accounts WHERE user_id = $1 AND status = 'ingested'`,
    [userId],
  );
  const done = new Set(rows.map((r) => r.platform));
  if (done.size !== 1) return null;
  return done.has("x") ? "linkedin" : "x";
}
