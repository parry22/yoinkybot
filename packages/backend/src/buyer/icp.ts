/**
 * The ICP (ideal customer profile) - who BUYS the user's thing, which overlaps
 * but is not the same as brand_profiles (the creator's brand + content audience).
 * Buyer Radar needs "who is in-market for my product" to search, score, and gate,
 * so this is a distinct one-row-per-user store.
 *
 * Mirrors strategist/profile.ts: NULL-aware, never fabricates, idempotent upsert.
 * The icp_embedding (the niche-gate vector) is recomputed on every save from the
 * product + buyer + pain phrasings, so an edit re-tunes the gate immediately.
 * profile_id is bound to user_id (agency-prep groundwork; equal in v1).
 */
import { query, queryOne, toVector } from "../db/pool.js";
import { embedOne } from "../llm/embeddings.js";
import { getProfile } from "../strategist/profile.js";

export interface IcpProfile {
  id: string;
  user_id: string;
  profile_id: string;
  product_oneliner: string | null;
  buyer_description: string | null;
  pain_signals: string[];
  competitor_terms: string[];
  exclusions: string[];
  created_at: string;
  updated_at: string;
}

/** The editable fields, as the web intake submits them. All optional on a patch. */
export interface IcpInput {
  product_oneliner?: string;
  buyer_description?: string;
  pain_signals?: string[];
  competitor_terms?: string[];
  exclusions?: string[];
}

/** Suggested ICP defaults derived from the brand profile, for the intake to pre-fill. */
export interface IcpPrefill {
  product_oneliner: string;
  buyer_description: string;
  pain_signals: string[];
}

export async function getIcp(userId: string): Promise<IcpProfile | null> {
  return (await queryOne<IcpProfile>(`SELECT * FROM icp_profiles WHERE user_id = $1`, [userId])) ?? null;
}

/**
 * The feature can only run with the two load-bearing fields set (what you sell +
 * who buys). Everything else sharpens the search but isn't required - so the
 * intake stays minimal (3-4 questions).
 */
export function icpComplete(icp: IcpProfile | null): boolean {
  return Boolean(icp?.product_oneliner?.trim() && icp?.buyer_description?.trim());
}

/**
 * Pre-fill the intake from brand_profiles where the data already exists, so the
 * common case is confirm-and-go rather than typing. Highest-signal columns only;
 * degrades to empty strings the intake will ask about.
 */
export async function prefillIcp(userId: string): Promise<IcpPrefill> {
  const p = await getProfile(userId);
  const buyer = [p?.audience_who, p?.audience_pain_point ? `pain: ${p.audience_pain_point}` : ""]
    .filter(Boolean)
    .join(" - ");
  return {
    product_oneliner: p?.niche ?? "",
    buyer_description: buyer,
    pain_signals: p?.audience_pain_point ? [p.audience_pain_point] : [],
  };
}

function cleanArray(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const raw of value) {
    const t = (raw ?? "").trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/** The text the niche-gate vector embeds: product + buyer + pain phrasings. */
function embeddingText(icp: {
  product_oneliner: string | null;
  buyer_description: string | null;
  pain_signals: string[];
}): string {
  return [icp.product_oneliner, icp.buyer_description, icp.pain_signals.join(", ")].filter(Boolean).join(". ").trim();
}

/**
 * Upsert the ICP and recompute its embedding. Patch semantics: only the fields
 * present in `input` change; the embedding is recomputed from the merged result
 * so it always reflects the current product/buyer/pain wording. Returns the
 * stored row.
 */
export async function saveIcp(userId: string, input: IcpInput): Promise<IcpProfile> {
  const existing = await getIcp(userId);
  const merged = {
    product_oneliner: input.product_oneliner?.trim() || existing?.product_oneliner || null,
    buyer_description: input.buyer_description?.trim() || existing?.buyer_description || null,
    pain_signals: input.pain_signals !== undefined ? cleanArray(input.pain_signals) : (existing?.pain_signals ?? []),
    competitor_terms:
      input.competitor_terms !== undefined ? cleanArray(input.competitor_terms) : (existing?.competitor_terms ?? []),
    exclusions: input.exclusions !== undefined ? cleanArray(input.exclusions) : (existing?.exclusions ?? []),
  };

  const text = embeddingText(merged);
  let embedding: string | null = null;
  if (text) {
    try {
      embedding = toVector(await embedOne(text, userId));
    } catch (err) {
      // An embedding failure must not lose the user's typed ICP; persist without
      // it and the next save recomputes. The niche gate degrades to "no vector"
      // (skips) rather than crashing, same posture as the buzz gate without a key.
      console.error("icp embedding failed; saving without vector", err);
    }
  }

  const row = await queryOne<IcpProfile>(
    `INSERT INTO icp_profiles
       (user_id, profile_id, product_oneliner, buyer_description, pain_signals, competitor_terms, exclusions, icp_embedding, updated_at)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7::vector, now())
     ON CONFLICT (user_id) DO UPDATE SET
       product_oneliner = EXCLUDED.product_oneliner,
       buyer_description = EXCLUDED.buyer_description,
       pain_signals = EXCLUDED.pain_signals,
       competitor_terms = EXCLUDED.competitor_terms,
       exclusions = EXCLUDED.exclusions,
       icp_embedding = COALESCE(EXCLUDED.icp_embedding, icp_profiles.icp_embedding),
       updated_at = now()
     RETURNING *`,
    [
      userId,
      merged.product_oneliner,
      merged.buyer_description,
      merged.pain_signals,
      merged.competitor_terms,
      merged.exclusions,
      embedding,
    ],
  );
  return row!;
}
