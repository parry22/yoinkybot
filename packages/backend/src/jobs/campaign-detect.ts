import { query, queryOne, toVector, withTransaction } from "../db/pool.js";
import { parseVector } from "../lib/kmeans.js";
import { cosineDistance } from "../strategist/gap.js";
import { detectStructuralMarker } from "../memory/classification.js";
import { getBoss, QUEUES, type CampaignDetectJob } from "./boss.js";

/**
 * Build-in-public series detection. Fired ONCE PER CAPTURE (not per memory -
 * see jobs/extract.ts) so two sibling memories from one post can never race
 * and create two campaigns for the same series. This queue's worker
 * concurrency is set to 1 in jobs/workers.ts for the same reason: campaign
 * detection is pure background enrichment, nothing user-facing waits on it,
 * so serializing it per-process is simpler than an advisory lock and fully
 * closes the create-race on this single-instance deploy.
 *
 * Two paths: a structural marker ("day 14", a repeated bracket/hashtag tag -
 * deterministic, computed from the immutable raw_text) fast-attaches to an
 * existing matching campaign; otherwise a thematic check looks for 2+ of the
 * user's own recent campaign-less captures embedding-close to this one - if
 * found (3 total including this one), a new campaign is created and the
 * earlier matches are backfilled retroactively in the same transaction.
 */

const MAX_READINESS_ATTEMPTS = 20; // ~10 min of 30s re-checks, same budget as diagnosis.ts
/**
 * Matches embed-link's own NEIGHBOR_DISTANCE exactly - verified live against
 * the real embedding provider in this deploy (Qwen/DashScope), whose vectors
 * run "cool": on-topic paraphrases sit ~0.5-0.6 cosine, not the ~0.2-0.3 a
 * tighter threshold assumes. An earlier 0.4 attempt matched nothing at all in
 * a live 3-post "day 1/2/3" series probe; 0.55 is the empirically-calibrated
 * value for "meaningfully related" with this exact provider. Revisit only if
 * the embedding provider changes.
 */
const CAMPAIGN_DISTANCE = 0.55;
const RECENCY_WINDOW_DAYS = 21;
const CANDIDATE_LIMIT = 20;
const MIN_SERIES_SIZE = 3;

interface CaptureRow {
  id: string;
  user_id: string;
  raw_text: string | null;
  captured_at: string;
}

async function embeddingsPending(captureId: string): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text n FROM memories WHERE capture_id = $1 AND embedding IS NULL`,
    [captureId],
  );
  return Number(row?.n ?? 0) > 0;
}

async function representativeEmbedding(captureId: string): Promise<number[] | null> {
  const row = await queryOne<{ embedding: string }>(
    `SELECT embedding::text FROM memories WHERE capture_id = $1 AND embedding IS NOT NULL
     ORDER BY created_at ASC LIMIT 1`,
    [captureId],
  );
  return row ? parseVector(row.embedding) : null;
}

/** Attach a capture to an existing campaign - shared by both match paths. */
async function attachToCampaign(campaignId: string, capture: CaptureRow): Promise<void> {
  const campaign = await queryOne<{ post_count: number }>(
    `UPDATE campaigns SET post_count = post_count + 1, last_capture_at = $2
     WHERE id = $1 RETURNING post_count`,
    [campaignId, capture.captured_at],
  );
  await query(
    `UPDATE captures SET campaign_id = $2, campaign_installment_number = $3,
            motive = 'campaign_installment', motive_confidence = 0.9
     WHERE id = $1`,
    [capture.id, campaignId, campaign?.post_count ?? 1],
  );
}

export async function handleCampaignDetect(job: CampaignDetectJob): Promise<void> {
  const attempt = job.attempt ?? 0;
  const capture = await queryOne<CaptureRow>(
    `SELECT id, user_id, raw_text, captured_at::text FROM captures WHERE id = $1`,
    [job.captureId],
  );
  if (!capture || !capture.raw_text) return;
  const rawText = capture.raw_text;

  // Wait for this capture's memories to have embeddings - bounded, same
  // startAfter-requeue idiom as strategist/diagnosis.ts's ingestionPending.
  if ((await embeddingsPending(capture.id)) && attempt < MAX_READINESS_ATTEMPTS) {
    await getBoss().send(QUEUES.campaignDetect, { ...job, attempt: attempt + 1 }, { startAfter: 30 });
    return;
  }

  const embedding = await representativeEmbedding(capture.id);
  if (!embedding) return; // extraction produced no memories - nothing to link

  const marker = detectStructuralMarker(rawText);

  // Fast path: an existing campaign already carries this exact marker family.
  if (marker) {
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM campaigns WHERE user_id = $1 AND structural_marker = $2
       ORDER BY last_capture_at DESC LIMIT 1`,
      [capture.user_id, marker],
    );
    if (existing) {
      await attachToCampaign(existing.id, capture);
      return;
    }
  }

  // Thematic path: an existing campaign (marker-based or not) close enough
  // in subject to this post, recently active.
  const thematicMatch = await queryOne<{ id: string; distance: number }>(
    `SELECT id, (representative_embedding <=> $2::vector) AS distance
     FROM campaigns
     WHERE user_id = $1 AND representative_embedding IS NOT NULL
       AND last_capture_at > now() - interval '${RECENCY_WINDOW_DAYS} days'
     ORDER BY distance ASC LIMIT 1`,
    [capture.user_id, toVector(embedding)],
  );
  if (thematicMatch && thematicMatch.distance < CAMPAIGN_DISTANCE) {
    await attachToCampaign(thematicMatch.id, capture);
    return;
  }

  // Neither an existing campaign nor a marker match - check whether this post
  // is the 3rd+ of a NEW, not-yet-detected series among the user's own recent
  // campaign-less captures.
  const candidates = await query<{ id: string; captured_at: string; embedding: string }>(
    `SELECT c.id, c.captured_at::text,
            (SELECT m.embedding::text FROM memories m WHERE m.capture_id = c.id
             AND m.embedding IS NOT NULL ORDER BY m.created_at ASC LIMIT 1) AS embedding
     FROM captures c
     WHERE c.user_id = $1 AND c.id <> $2 AND c.campaign_id IS NULL
       AND c.captured_at > now() - interval '${RECENCY_WINDOW_DAYS} days'
     ORDER BY c.captured_at DESC LIMIT ${CANDIDATE_LIMIT}`,
    [capture.user_id, capture.id],
  );
  const matched = candidates
    .filter((c) => c.embedding)
    .map((c) => ({ ...c, distance: cosineDistance(parseVector(c.embedding), embedding) }))
    .filter((c) => c.distance < CAMPAIGN_DISTANCE);

  if (matched.length + 1 < MIN_SERIES_SIZE) return; // just a one-off post, not a series

  const members = [...matched, { id: capture.id, captured_at: capture.captured_at, distance: 0 }].sort((a, b) =>
    a.captured_at.localeCompare(b.captured_at),
  );

  await withTransaction(async (client) => {
    const created = await client.query<{ id: string }>(
      `INSERT INTO campaigns (user_id, label, structural_marker, representative_embedding, first_capture_at, last_capture_at, post_count)
       VALUES ($1, $2, $3, $4::vector, $5, $6, $7) RETURNING id`,
      [
        capture.user_id,
        marker ?? `recurring series: ${rawText.slice(0, 60)}`,
        marker,
        toVector(embedding),
        members[0]!.captured_at,
        capture.captured_at,
        members.length,
      ],
    );
    const campaignId = created.rows[0]!.id;
    for (let i = 0; i < members.length; i++) {
      await client.query(
        `UPDATE captures SET campaign_id = $2, campaign_installment_number = $3,
                motive = 'campaign_installment', motive_confidence = 0.9
         WHERE id = $1`,
        [members[i]!.id, campaignId, i + 1],
      );
    }
  });
}
