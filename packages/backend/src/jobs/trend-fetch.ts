import { query, queryOne, toVector } from "../db/pool.js";
import { embed } from "../llm/embeddings.js";
import { fetchTrendsWithFallback } from "../trends/registry.js";

/**
 * Populates the shared `trends` table a few times a day. Trends are fetched once
 * for the whole user base (biased by the themes users actually think about) and
 * matched per-user later by trend-match — so provider spend is O(1), not O(users).
 */
export async function handleTrendFetch(): Promise<void> {
  const themes = await interestThemes();
  if (themes.length === 0) return;

  const { trends, provider } = await fetchTrendsWithFallback({ themes, limit: 24 });
  if (trends.length === 0) {
    console.warn("trend fetch: no provider produced trends");
    return;
  }

  // Only embed trends we haven't seen before (embedding is the expensive part).
  const fresh: typeof trends = [];
  for (const t of trends) {
    const seen = await queryOne(`SELECT 1 FROM trends WHERE source = $1 AND external_id = $2`, [
      t.source,
      t.externalId,
    ]);
    if (!seen) fresh.push(t);
    else {
      await query(`UPDATE trends SET fetched_at = now(), volume = COALESCE($3, volume) WHERE source = $1 AND external_id = $2`, [
        t.source,
        t.externalId,
        t.volume ?? null,
      ]);
    }
  }
  if (fresh.length === 0) return;

  const embeddings = await embed(
    fresh.map((t) => `${t.topic}\n${t.summary}`),
    null,
  );
  for (let i = 0; i < fresh.length; i++) {
    const t = fresh[i]!;
    await query(
      `INSERT INTO trends (platform, source, external_id, topic, summary, url, volume, embedding, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9)
       ON CONFLICT (source, external_id) DO UPDATE SET fetched_at = now()`,
      [t.platform, t.source, t.externalId, t.topic, t.summary, t.url ?? null, t.volume ?? null, toVector(embeddings[i]!), t.observedAt],
    );
  }
  console.log(`trend fetch: ${fresh.length} new trends via ${provider}`);
}

/** The user base's interest fingerprint: cluster labels first, positions as fallback. */
async function interestThemes(): Promise<string[]> {
  const clusters = await query<{ label: string; n: string }>(
    `SELECT label, count(*)::text AS n FROM clusters GROUP BY label ORDER BY count(*) DESC LIMIT 6`,
  );
  if (clusters.length > 0) return clusters.map((c) => c.label);
  const positions = await query<{ statement: string }>(
    `SELECT statement FROM positions WHERE status = 'active' ORDER BY last_affirmed_at DESC LIMIT 6`,
  );
  return positions.map((p) => p.statement.slice(0, 80));
}
