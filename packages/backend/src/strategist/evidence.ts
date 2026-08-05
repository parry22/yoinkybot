import { query } from "../db/pool.js";
import { kmeans, parseVector } from "../lib/kmeans.js";
import { computeVoiceStats, formatVoiceStats } from "../lib/voice-stats.js";
import { activePositions } from "../memory/positions.js";

/**
 * Computed evidence for the Brand Diagnosis. The diagnosis spec demands method
 * ("cluster idea/claim memories, recurring 3+ times across periods", "state the
 * ratio as a number", "sample the sentence length distribution") - a single LLM
 * pass over raw posts cannot be trusted to actually do that arithmetic. This
 * module does it deterministically; the model's job shrinks to interpretation.
 */

export interface ThemeCluster {
  size: number;
  monthSpread: number; // distinct months the theme appears in
  span: string; // "2025-02..2026-05"
  recurring: boolean; // 3+ items across 2+ months - candidate owned position
  samples: string[]; // up to 3 dated examples
}

interface ClusterItem {
  content: string;
  created_at: string;
  vector: number[];
}

/** Pure: group items by k-means assignment and summarize each theme. Exported for tests. */
export function summarizeClusters(items: ClusterItem[], assignments: number[], k: number): ThemeCluster[] {
  const groups = new Map<number, ClusterItem[]>();
  items.forEach((item, i) => {
    const a = assignments[i]!;
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a)!.push(item);
  });
  void k;
  const clusters: ThemeCluster[] = [];
  for (const members of groups.values()) {
    const byDate = [...members].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const months = new Set(byDate.map((m) => m.created_at.slice(0, 7)));
    clusters.push({
      size: members.length,
      monthSpread: months.size,
      span: `${byDate[0]!.created_at.slice(0, 7)}..${byDate[byDate.length - 1]!.created_at.slice(0, 7)}`,
      recurring: members.length >= 3 && months.size >= 2,
      samples: byDate.slice(0, 3).map((m) => `[${m.created_at.slice(0, 10)}] ${m.content.slice(0, 160)}`),
    });
  }
  return clusters.sort((a, b) => b.size - a.size);
}

export interface ComputedEvidence {
  text: string;
  recurringThemes: number;
  ratio: { insideOut: number; outsideIn: number; classified: number } | null;
}

// A shitpost/bit reported as sincere content would pollute both the theme
// clusters (owned-position candidates) and the outside-in ratio, so both
// queries below join captures and exclude anything that isn't confidently
// sincere. NULL-tolerant (memories.capture_id is nullable in practice, and
// captures classified before this feature existed have no register at all) -
// see memory/classification.ts#isSincereEnough for the exact predicate this mirrors.
const SINCERE_FILTER = `(c.sincerity_register IS NULL OR (c.sincerity_register = 'sincere' AND c.sincerity_confidence >= 0.5))`;

export async function computeEvidence(userId: string): Promise<ComputedEvidence> {
  const [ideaClaims, orientationRows, positions, allPosts] = await Promise.all([
    query<{ content: string; created_at: string; embedding: string }>(
      `SELECT m.content, m.created_at::text, m.embedding::text
       FROM memories m LEFT JOIN captures c ON c.id = m.capture_id
       WHERE m.user_id = $1 AND m.status = 'active' AND m.kind IN ('idea','claim') AND m.embedding IS NOT NULL
         AND ${SINCERE_FILTER}
       ORDER BY m.created_at ASC LIMIT 400`,
      [userId],
    ),
    query<{ orientation: string; n: string }>(
      `SELECT m.orientation, count(*)::text AS n
       FROM memories m JOIN captures c ON c.id = m.capture_id
       WHERE m.user_id = $1 AND m.status = 'active' AND m.orientation IS NOT NULL
         AND c.source IN ('x_import','linkedin_import')
         AND ${SINCERE_FILTER}
       GROUP BY m.orientation`,
      [userId],
    ),
    activePositions(userId, { includeStale: true }),
    query<{ content: string; created_at: string }>(
      `SELECT content, created_at::text FROM memories
       WHERE user_id = $1 AND status = 'active' ORDER BY created_at ASC LIMIT 500`,
      [userId],
    ),
  ]);

  const blocks: string[] = [];

  // 1. Recurring themes via k-means over idea/claim embeddings.
  let recurringThemes = 0;
  if (ideaClaims.length >= 6) {
    const items: ClusterItem[] = ideaClaims.map((r) => ({
      content: r.content,
      created_at: r.created_at,
      vector: parseVector(r.embedding),
    }));
    const k = Math.min(10, Math.max(3, Math.round(items.length / 8)));
    const { assignments } = kmeans(items.map((i) => i.vector), k);
    const clusters = summarizeClusters(items, assignments, k);
    recurringThemes = clusters.filter((c) => c.recurring).length;
    blocks.push(
      `THEME CLUSTERS (k-means over ${items.length} idea/claim memories; "recurring" = 3+ items across 2+ months - only recurring clusters qualify as owned positions):\n` +
        clusters
          .slice(0, 8)
          .map(
            (c, i) =>
              `Cluster ${i + 1}: ${c.size} items over ${c.monthSpread} month(s), ${c.span}${c.recurring ? " [RECURRING]" : ""}\n${c.samples.map((s) => `  ${s}`).join("\n")}`,
          )
          .join("\n"),
    );
  } else {
    blocks.push(`THEME CLUSTERS: only ${ideaClaims.length} idea/claim memories - too few to cluster meaningfully.`);
  }

  // 2. Inside-out vs outside-in - a counted ratio, not an impression.
  const counts = Object.fromEntries(orientationRows.map((r) => [r.orientation, Number(r.n)]));
  const insideOut = counts["inside_out"] ?? 0;
  const outsideIn = counts["outside_in"] ?? 0;
  const classified = insideOut + outsideIn;
  let ratio: ComputedEvidence["ratio"] = null;
  if (classified >= 10) {
    ratio = { insideOut, outsideIn, classified };
    blocks.push(
      `OUTSIDE-IN RATIO (counted over ${classified} classified public posts): ${insideOut} inside-out vs ${outsideIn} outside-in - ${Math.round((100 * insideOut) / classified)}% about themselves/their work. USE THESE EXACT NUMBERS.`,
    );
  } else {
    blocks.push(`OUTSIDE-IN RATIO: only ${classified} classified posts - too few to state a ratio; say so honestly.`);
  }

  // 3. Position recurrence from the belief store (counts + date spans are facts).
  if (positions.length) {
    blocks.push(
      `EXTRACTED POSITIONS (times stated + span are computed facts):\n` +
        positions
          .slice(0, 12)
          .map((p) => {
            const n = p.source_memory_ids.length;
            return `- "${p.statement}" - stated ${n} time${n === 1 ? "" : "s"}, ${p.first_stated_at.slice(0, 10)} to ${p.last_affirmed_at.slice(0, 10)}, confidence ${Math.round(p.confidence * 100)}%`;
          })
          .join("\n"),
    );
  }

  // 4. Measured voice numbers.
  const voice = computeVoiceStats(allPosts);
  blocks.push(voice ? `MEASURED VOICE STATS:\n${formatVoiceStats(voice)}` : "MEASURED VOICE STATS: too few posts to measure.");

  return { text: blocks.join("\n\n"), recurringThemes, ratio };
}
