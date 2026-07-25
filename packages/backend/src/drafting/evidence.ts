/**
 * Performance evidence for the writer (§3a drafting).
 *
 * THE PROBLEM THIS FIXES. The draft prompt was stylistically very well specified
 * and empirically blind: it received retrieved memory *fragments*, a voice
 * profile, and the stated brand profile — but nothing about which of this
 * person's actual posts ever landed, what shape they took, or what they were
 * trying to do. Every performance number the product computes lived in analytics
 * / diagnosis / report surfaces the USER reads, and never in the loop that
 * writes. So the writer applied universal reach doctrine to everyone identically
 * and could not tell that, say, this particular person's short punchy posts
 * underperform their own median by 40%.
 *
 * Everything below already existed in the DB; none of it was wired to drafting:
 *   - `captures.raw_text` — the full text of their real posts (source='x_import')
 *   - `captures.metadata->'engagement'` — likes/replies/RTs/quotes (performance.ts
 *     refreshes these), so "high performer" is quotable against their own baseline
 *   - `captures.rhetorical_mode` / `sincerity_register` / `motive` — the post
 *     classifier (migration 0017) writes all three. `motive` in particular was
 *     written by the extractor and read by ZERO queries before this.
 *
 * Cost: one query, then pure computation. Best-effort by construction — a user
 * with no connected X, no refreshed engagement, or too few posts yields an empty
 * evidence object and the writer simply falls back to universal doctrine.
 */
import { query } from "../db/pool.js";
import { median, engagementTotal } from "../strategist/performance.js";
import { classifyOpener } from "../trends/viral-heuristics.js";

/** How many of their own posts to consider. Their whole recent history, bounded. */
const HISTORY_LIMIT = 200;
/** A bucket/motive needs this many posts before its median means anything. */
const MIN_SAMPLE = 3;
/** Post text is an exemplar, not a corpus — enough to see the shape, not bloat context. */
const TOP_TEXT_CHARS = 240;
const QUIET_TEXT_CHARS = 140;

export interface EvidencePost {
  /** The real post text (truncated) — the single most useful "sounds like me" input. */
  text: string;
  engagement: number;
  /** Multiple of their own median engagement. 2.4 = "2.4x your usual". */
  ratio: number | null;
  mode: string | null;
  sincerity: string | null;
  motive: string | null;
  /** How the first line opens — question | number | bold_claim | plain. */
  opener: string;
  chars: number;
  daysAgo: number;
}

export interface ShapeLift {
  label: string;
  posts: number;
  /** % difference between this shape's median engagement and their overall median. */
  liftPct: number;
}

export interface MotiveLift {
  motive: string;
  posts: number;
  liftPct: number;
}

export interface DraftEvidence {
  /** Null when there isn't enough history to say anything honest. */
  baselineEngagement: number | null;
  postsConsidered: number;
  /** Their biggest hits, strongest first. */
  topPosts: EvidencePost[];
  /** Their quietest posts — counter-examples, so the writer can avoid repeating them. */
  quietPosts: EvidencePost[];
  /** Which SHAPE of post out/under-performs their own median. */
  shapeLift: ShapeLift[];
  /** Which INTENT out/under-performs. Surfaces the previously-unread `motive`. */
  motiveLift: MotiveLift[];
}

export const EMPTY_EVIDENCE: DraftEvidence = {
  baselineEngagement: null,
  postsConsidered: 0,
  topPosts: [],
  quietPosts: [],
  shapeLift: [],
  motiveLift: [],
};

/**
 * Post-shape buckets. Deliberately the same cuts `web/analytics.ts#FORMAT_BUCKETS`
 * shows the user, so the writer is reasoning about the same shapes the Analytics
 * page reports — but measured on raw engagement here (self-contained on captures)
 * rather than engagement RATE (which needs impressions). Those bucket predicates
 * are private to analytics.ts; if you change one, change it in both places.
 */
const SHAPE_BUCKETS: Array<{ label: string; test: (text: string) => boolean }> = [
  { label: "asks a question", test: (t) => /\?/.test(t) },
  { label: "includes a link", test: (t) => /https?:\/\//i.test(t) },
  { label: "short & punchy (≤120 chars)", test: (t) => t.length <= 120 },
  { label: "longer take (≥240 chars)", test: (t) => t.length >= 240 },
  { label: "multi-line / thread-style", test: (t) => /\n/.test(t) },
];

interface Row {
  raw_text: string | null;
  captured_at: string;
  eng: unknown;
  rhetorical_mode: string | null;
  sincerity_register: string | null;
  motive: string | null;
}

function liftPct(bucketMedian: number, overall: number): number {
  return Math.round(((bucketMedian - overall) / overall) * 100);
}

/**
 * Build the writer's evidence pack: their own baseline, their hits and misses
 * with real numbers, and which shapes/intents actually work FOR THEM.
 */
export async function draftEvidence(userId: string): Promise<DraftEvidence> {
  let rows: Row[];
  try {
    rows = await query<Row>(
      `SELECT raw_text, captured_at::text, metadata->'engagement' AS eng,
              rhetorical_mode, sincerity_register, motive
       FROM captures
       WHERE user_id = $1
         AND source = 'x_import'
         AND metadata->>'published' = 'true'
         AND metadata ? 'engagement'
       ORDER BY captured_at DESC
       LIMIT $2`,
      [userId, HISTORY_LIMIT],
    );
  } catch (err) {
    console.error("draftEvidence query failed (falling back to no evidence)", err);
    return EMPTY_EVIDENCE;
  }

  const now = Date.now();
  const posts = rows
    .map((r) => {
      const text = (r.raw_text ?? "").trim();
      const engagement = engagementTotal(r.eng);
      return {
        text,
        engagement,
        mode: r.rhetorical_mode,
        sincerity: r.sincerity_register,
        motive: r.motive,
        at: new Date(r.captured_at).getTime(),
      };
    })
    // No text or no metrics = nothing to learn from.
    .filter((p): p is typeof p & { engagement: number } => p.text.length > 0 && p.engagement !== null);

  if (posts.length < MIN_SAMPLE) return { ...EMPTY_EVIDENCE, postsConsidered: posts.length };

  const overall = median(posts.map((p) => p.engagement));
  if (overall === null || overall <= 0) {
    // Everything at zero engagement (brand-new account) — a baseline of 0 makes
    // every ratio meaningless, so report the count and stay quiet on performance.
    return { ...EMPTY_EVIDENCE, postsConsidered: posts.length };
  }

  const toEvidence = (p: (typeof posts)[number], chars: number): EvidencePost => ({
    text: p.text.length > chars ? `${p.text.slice(0, chars)}…` : p.text,
    engagement: p.engagement,
    ratio: Math.round((p.engagement / overall) * 10) / 10,
    mode: p.mode,
    sincerity: p.sincerity,
    motive: p.motive,
    opener: classifyOpener(p.text),
    chars: p.text.length,
    daysAgo: Math.max(0, Math.round((now - p.at) / 86_400_000)),
  });

  const byEngagement = [...posts].sort((a, b) => b.engagement - a.engagement);
  const topPosts = byEngagement.slice(0, 3).map((p) => toEvidence(p, TOP_TEXT_CHARS));
  // Quiet examples only make the point when there's a real spread; with a tiny
  // history the "worst" post is noise, not a lesson.
  const quietPosts =
    posts.length >= 8 ? byEngagement.slice(-2).reverse().map((p) => toEvidence(p, QUIET_TEXT_CHARS)) : [];

  const shapeLift: ShapeLift[] = [];
  for (const b of SHAPE_BUCKETS) {
    const inBucket = posts.filter((p) => b.test(p.text));
    if (inBucket.length < MIN_SAMPLE) continue;
    const m = median(inBucket.map((p) => p.engagement));
    if (m === null) continue;
    shapeLift.push({ label: b.label, posts: inBucket.length, liftPct: liftPct(m, overall) });
  }
  shapeLift.sort((a, b) => b.liftPct - a.liftPct);

  const motiveLift: MotiveLift[] = [];
  const motives = new Set(posts.map((p) => p.motive).filter((m): m is string => !!m));
  for (const mv of motives) {
    const inMotive = posts.filter((p) => p.motive === mv);
    if (inMotive.length < MIN_SAMPLE) continue;
    const m = median(inMotive.map((p) => p.engagement));
    if (m === null) continue;
    motiveLift.push({ motive: mv, posts: inMotive.length, liftPct: liftPct(m, overall) });
  }
  motiveLift.sort((a, b) => b.liftPct - a.liftPct);

  return {
    baselineEngagement: Math.round(overall * 10) / 10,
    postsConsidered: posts.length,
    topPosts,
    quietPosts,
    shapeLift,
    motiveLift,
  };
}

/**
 * Provenance for the memories the retriever returned: which of them came from a
 * post the user actually PUBLISHED, how that post did, and what it was trying to
 * do. Without this the writer cannot tell a private half-formed voice note from a
 * take that already went out and landed — and it treats both as equal substance.
 * Keyed by memory id. Best-effort: failure returns an empty map.
 */
export interface MemoryProvenance {
  published: boolean;
  engagement: number | null;
  mode: string | null;
  sincerity: string | null;
  motive: string | null;
}

export async function memoryProvenance(
  userId: string,
  captureIds: string[],
): Promise<Map<string, MemoryProvenance>> {
  const ids = captureIds.filter(Boolean);
  if (ids.length === 0) return new Map();
  try {
    const rows = await query<{
      id: string;
      published: boolean | null;
      eng: unknown;
      rhetorical_mode: string | null;
      sincerity_register: string | null;
      motive: string | null;
    }>(
      `SELECT id, (metadata->>'published' = 'true') AS published, metadata->'engagement' AS eng,
              rhetorical_mode, sincerity_register, motive
       FROM captures WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [userId, ids],
    );
    const out = new Map<string, MemoryProvenance>();
    for (const r of rows) {
      out.set(r.id, {
        published: r.published === true,
        engagement: engagementTotal(r.eng),
        mode: r.rhetorical_mode,
        sincerity: r.sincerity_register,
        motive: r.motive,
      });
    }
    return out;
  } catch (err) {
    console.error("memoryProvenance query failed (continuing without provenance)", err);
    return new Map();
  }
}
