import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { config } from "../config.js";
import { llmCall } from "../llm/gateway.js";
import { embed } from "../llm/embeddings.js";
import { pullXProfile, pullLinkedInProfile } from "../capture/imports/apify-profile.js";
import { applyRecencyWindow } from "../capture/imports/x.js";
import { classifyPeerThemes } from "../prompts/classify-peer-themes.v1.js";
import { ALL_TONE_KEYS } from "../strategist/profile.js";
import { median, engagementTotal } from "../strategist/performance.js";
import { cosineDistance } from "../drafting/repurpose.js";

/**
 * Peer benchmarking: a small, explicitly user-chosen set of peers, compared on
 * TERRITORY (theme overlap) and RELATIVE performance (each against their own
 * baseline - raw numbers across different audience sizes are meaningless and
 * never surfaced). No positions, no belief graph, no voice profile for peers;
 * that machinery is reserved for the person who opted in.
 */

export const MAX_PEERS = 5;
/** Theme labels within this cosine distance count as the same territory. */
const THEME_MATCH_DISTANCE = 0.35;
const PEER_PULL_POSTS = 40;
const PEER_WINDOW_DAYS = 90;

// ── Pure comparison core (unit-tested) ───────────────────────────────────────

export interface TerritorySplit {
  shared: string[]; // user's label, matched by the peer
  userOnly: string[]; // the differentiation evidence - the headline finding
  peerOnly: string[];
  overlapPct: number; // share of the user's territory the peer also covers
}

/** Three-way territory split over embedded theme labels. Pure given vectors. */
export function splitTerritory(
  userThemes: string[],
  peerThemes: string[],
  userVecs: number[][],
  peerVecs: number[][],
  threshold = THEME_MATCH_DISTANCE,
): TerritorySplit {
  const peerMatched = new Set<number>();
  const shared: string[] = [];
  const userOnly: string[] = [];

  userThemes.forEach((label, i) => {
    let matched = false;
    peerVecs.forEach((pv, j) => {
      if (cosineDistance(userVecs[i]!, pv) < threshold) {
        matched = true;
        peerMatched.add(j);
      }
    });
    (matched ? shared : userOnly).push(label);
  });

  const peerOnly = peerThemes.filter((_, j) => !peerMatched.has(j));
  return {
    shared,
    userOnly,
    peerOnly,
    overlapPct: userThemes.length ? Math.round((100 * shared.length) / userThemes.length) : 0,
  };
}

export interface RelativePerformance {
  baseline: number | null;
  periodMedian: number | null;
  /** period vs own baseline; null when either side is missing. */
  ratio: number | null;
}

export function relativePerformance(baselineEng: number[], periodEng: number[]): RelativePerformance {
  const baseline = median(baselineEng);
  const periodMedian = median(periodEng);
  const ratio = baseline && baseline > 0 && periodMedian !== null ? Math.round((periodMedian / baseline) * 100) / 100 : null;
  return { baseline, periodMedian, ratio };
}

// ── Peer management (explicit add only - never suggested, never automatic) ───

export type PeersCommand =
  | { kind: "list" }
  | { kind: "add"; platform: "x" | "linkedin"; handle: string; note: string | null }
  | { kind: "remove"; handle: string };

export function parsePeersCommand(arg: string): PeersCommand | null {
  const t = arg.trim();
  if (!t) return { kind: "list" };
  const rm = t.match(/^remove\s+@?([A-Za-z0-9_.-]{2,64})$/i);
  if (rm?.[1]) return { kind: "remove", handle: rm[1].toLowerCase() };
  const add = t.match(/^add\s+(?:(x|twitter|linkedin)\s+)?@?([A-Za-z0-9_.-]{2,64})(?:\s+([\s\S]+))?$/i);
  if (add?.[2]) {
    const platform = add[1]?.toLowerCase() === "linkedin" ? "linkedin" : "x";
    return { kind: "add", platform, handle: add[2].toLowerCase(), note: add[3]?.trim() || null };
  }
  return null;
}

export async function addPeer(
  userId: string,
  platform: "x" | "linkedin",
  handle: string,
  note: string | null,
): Promise<string> {
  const count = await queryOne<{ n: string }>(
    `SELECT count(*)::text n FROM peer_profiles WHERE user_id = $1 AND active`,
    [userId],
  );
  if (Number(count?.n ?? 0) >= MAX_PEERS) {
    return `You're already watching ${MAX_PEERS} peers - that's the cap on purpose, this works as a sharp shortlist, not a market scan. Remove one first: /peers remove <handle>`;
  }
  await query(
    `INSERT INTO peer_profiles (user_id, platform, peer_handle, relationship_note, active)
     VALUES ($1,$2,$3,$4,true)
     ON CONFLICT (user_id, platform, peer_handle) DO UPDATE SET active = true, relationship_note = COALESCE($4, peer_profiles.relationship_note)`,
    [userId, platform, handle, note],
  );
  return `Watching @${handle} on ${platform === "x" ? "X" : "LinkedIn"}${note ? ` (${note})` : ""}. Their public posts get pulled weekly, and the territory comparison folds into your Monday report. Territory and relative performance only - I don't build a profile on them.`;
}

export async function removePeer(userId: string, handle: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `UPDATE peer_profiles SET active = false WHERE user_id = $1 AND peer_handle = $2 AND active RETURNING id`,
    [userId, handle],
  );
  return row ? `Stopped watching @${handle}.` : `You weren't watching @${handle}.`;
}

export async function listPeers(userId: string): Promise<string> {
  const peers = await query<{ peer_handle: string; platform: string; relationship_note: string | null; n: string }>(
    `SELECT p.peer_handle, p.platform, p.relationship_note,
            (SELECT count(*) FROM peer_captures pc WHERE pc.peer_profile_id = p.id)::text AS n
     FROM peer_profiles p WHERE p.user_id = $1 AND p.active ORDER BY p.added_at`,
    [userId],
  );
  if (peers.length === 0) {
    return (
      "No peers on the watchlist. Add up to 5 people whose territory is worth comparing against yours:\n" +
      "/peers add @handle optional note on why them\n/peers add linkedin <slug> for LinkedIn\n\n" +
      "I compare territory and relative performance only - never raw numbers across different audiences, never style."
    );
  }
  return (
    "Watching:\n" +
    peers
      .map((p) => `• @${p.peer_handle} (${p.platform})${p.relationship_note ? ` - ${p.relationship_note}` : ""} · ${p.n} posts on record`)
      .join("\n") +
    "\n\n/peers add @handle · /peers remove @handle"
  );
}

// ── Weekly ingest (cron) - pull, dedupe, batch-classify themes ───────────────

const themesSchema = z.object({
  themes: z
    .array(
      z.object({
        index: z.number(),
        theme: z.string().min(1),
        // Tolerate a missing/garbled read rather than failing the whole batch -
        // matches jobs/extract.ts's .catch() precedent for classification fields.
        rhetorical_mode: z.string().catch("").optional(),
        sincerity_register: z
          .enum(["sincere", "ironic", "self_deprecating", "absurdist", "ambiguous"])
          .catch("ambiguous")
          .optional(),
      }),
    )
    .default([]),
});

export async function handlePeerIngest(): Promise<void> {
  const peers = await query<{ id: string; user_id: string; peer_handle: string; platform: "x" | "linkedin" }>(
    `SELECT p.id, p.user_id, p.peer_handle, p.platform
     FROM peer_profiles p JOIN users u ON u.id = p.user_id
     WHERE p.active AND u.telegram_id IS NOT NULL`,
  );
  for (const peer of peers) {
    try {
      await ingestPeer(peer);
    } catch (err) {
      console.error(`peer ingest failed for @${peer.peer_handle}`, err);
    }
  }
}

export async function ingestPeer(peer: {
  id: string;
  user_id: string;
  peer_handle: string;
  platform: "x" | "linkedin";
}): Promise<number> {
  if (peer.platform === "x" && !config.TWITTERAPI_IO_KEY && !config.APIFY_TOKEN) return 0;
  const pull =
    peer.platform === "x"
      ? await pullXProfile(peer.peer_handle, PEER_PULL_POSTS, { sinceDays: PEER_WINDOW_DAYS, minPosts: 20 })
      : await pullLinkedInProfile(peer.peer_handle, PEER_PULL_POSTS);
  const posts = applyRecencyWindow(
    pull.posts.filter((p) => p.text.length >= 20),
    { days: PEER_WINDOW_DAYS, minPosts: 20, maxPosts: PEER_PULL_POSTS },
  );

  // Upsert: new posts insert, already-seen posts get their engagement refreshed.
  for (const post of posts) {
    await query(
      `INSERT INTO peer_captures (peer_profile_id, external_id, content, published_at, engagement_metrics)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (peer_profile_id, external_id) DO UPDATE SET engagement_metrics = EXCLUDED.engagement_metrics`,
      [peer.id, post.url ?? `${peer.peer_handle}:${post.postedAt.getTime()}`, post.text, post.postedAt, JSON.stringify(post.engagement ?? {})],
    );
  }

  // One batched cheap call for every post this peer has that's missing EITHER
  // the theme or the newer mode/sincerity read (catches posts ingested before
  // this classification was added, not just brand-new ones).
  const untagged = await query<{ id: string; content: string }>(
    `SELECT id, content FROM peer_captures WHERE peer_profile_id = $1
       AND (classified_theme IS NULL OR rhetorical_mode IS NULL)
     ORDER BY published_at DESC LIMIT 60`,
    [peer.id],
  );
  if (untagged.length) {
    try {
      const res = await llmCall({
        userId: peer.user_id,
        eventType: "peer_themes",
        // High-volume, low-stakes tagging - the cheap floor per the model registry.
        tier: "cheap_floor",
        system: classifyPeerThemes.system,
        user: classifyPeerThemes.render({ posts: untagged.map((u, i) => ({ index: i, content: u.content })) }),
        json: true,
        maxTokens: 1200,
      });
      const parsed = themesSchema.parse(res.parsed);
      for (const t of parsed.themes) {
        const target = untagged[t.index];
        if (!target) continue;
        const rhetoricalMode = t.rhetorical_mode && (ALL_TONE_KEYS as string[]).includes(t.rhetorical_mode) ? t.rhetorical_mode : null;
        await query(
          `UPDATE peer_captures SET classified_theme = $2, rhetorical_mode = $3, sincerity_register = $4 WHERE id = $1`,
          [target.id, t.theme.toLowerCase().slice(0, 80), rhetoricalMode, t.sincerity_register ?? null],
        );
      }
    } catch (err) {
      console.error(`peer theme classification failed for @${peer.peer_handle}`, err);
    }
  }
  return untagged.length;
}

// ── Comparison, computed at report time ──────────────────────────────────────

export interface PeerComparison {
  text: string;
  peersCompared: number;
}

/**
 * The rendered COMPUTED PEER COMPARISON block for the Monday report - territory
 * first, everything relative-to-own-baseline. Returns null when the user
 * watches no peers (the report simply omits the section).
 */
export async function computePeerComparison(
  userId: string,
  userRelative: { baseline: number | null; periodMedian: number | null },
  periodStart: Date,
): Promise<PeerComparison | null> {
  const peers = await query<{ id: string; peer_handle: string; platform: string; relationship_note: string | null }>(
    `SELECT id, peer_handle, platform, relationship_note FROM peer_profiles WHERE user_id = $1 AND active ORDER BY added_at`,
    [userId],
  );
  if (peers.length === 0) return null;

  const userClusters = await query<{ label: string }>(
    `SELECT label FROM clusters WHERE user_id = $1 ORDER BY array_length(memory_ids,1) DESC LIMIT 10`,
    [userId],
  );
  const userThemes = userClusters.map((c) => c.label.toLowerCase());
  const userRatio =
    userRelative.baseline && userRelative.baseline > 0 && userRelative.periodMedian !== null
      ? Math.round((userRelative.periodMedian / userRelative.baseline) * 100) / 100
      : null;

  const lines: string[] = [
    `COMPUTED PEER COMPARISON (weekly-ingested public posts · every performance figure is each person vs THEIR OWN baseline - raw cross-account numbers are never comparable and never shown)`,
    `Your period-vs-baseline: ${userRatio ?? "n/a"}x.`,
  ];

  for (const peer of peers) {
    const rows = await query<{ content: string; published_at: string; eng: unknown; theme: string | null }>(
      `SELECT content, published_at::text, engagement_metrics AS eng, classified_theme AS theme
       FROM peer_captures WHERE peer_profile_id = $1 ORDER BY published_at DESC LIMIT 120`,
      [peer.id],
    );
    if (rows.length < 5) {
      lines.push(`@${peer.peer_handle}: only ${rows.length} posts on record so far - too thin to compare honestly this period.`);
      continue;
    }

    const withEng = rows.map((r) => ({ ...r, engagement: engagementTotal(r.eng) })).filter((r) => r.engagement !== null);
    const startMs = periodStart.getTime();
    const perf = relativePerformance(
      withEng.filter((r) => new Date(r.published_at).getTime() < startMs).map((r) => r.engagement!),
      withEng.filter((r) => new Date(r.published_at).getTime() >= startMs).map((r) => r.engagement!),
    );

    const peerThemes = [...new Set(rows.map((r) => r.theme).filter((t): t is string => !!t))].slice(0, 12);
    let split: TerritorySplit | null = null;
    if (userThemes.length >= 2 && peerThemes.length >= 2) {
      const vecs = await embed([...userThemes, ...peerThemes], userId);
      split = splitTerritory(userThemes, peerThemes, vecs.slice(0, userThemes.length), vecs.slice(userThemes.length));
    }

    // Traction on peer-only themes: theme's median above the peer's own baseline.
    const traction = new Set<string>();
    if (split && perf.baseline) {
      for (const theme of split.peerOnly) {
        const themeEng = withEng.filter((r) => r.theme === theme).map((r) => r.engagement!);
        const m = median(themeEng);
        if (m !== null && m > perf.baseline) traction.add(theme);
      }
    }

    lines.push(
      `@${peer.peer_handle}${peer.relationship_note ? ` (${peer.relationship_note})` : ""}: ${rows.length} posts on record · their period-vs-baseline: ${perf.ratio ?? "n/a"}x` +
        (split
          ? `\n  TERRITORY (theme overlap ${split.overlapPct}% of yours):` +
            `\n  - yours alone (differentiation evidence): ${split.userOnly.join("; ") || "(none - everything you cover, they cover too)"}` +
            `\n  - shared ground: ${split.shared.join("; ") || "(none)"}` +
            `\n  - theirs only: ${split.peerOnly.map((t) => (traction.has(t) ? `${t} [getting real traction]` : t)).join("; ") || "(none)"}`
          : `\n  TERRITORY: not enough theme data yet on one side to split honestly.`),
    );

    await query(
      `INSERT INTO peer_comparison_snapshots (user_id, peer_profile_id, period_start, period_end, peer_baseline, user_baseline, theme_overlap)
       VALUES ($1,$2,$3,now(),$4,$5,$6)`,
      [userId, peer.id, periodStart, perf.baseline, userRelative.baseline, JSON.stringify(split ?? {})],
    );
  }

  return { text: lines.join("\n"), peersCompared: peers.length };
}
