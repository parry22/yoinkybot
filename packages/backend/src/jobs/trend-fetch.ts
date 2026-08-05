import { z } from "zod";
import { query, queryOne, toVector } from "../db/pool.js";
import { embed } from "../llm/embeddings.js";
import { llmCall } from "../llm/gateway.js";
import { fetchTrendsWithFallback } from "../trends/registry.js";
import { discoverXTrends } from "../trends/discover-x.js";
import { twitterapiConfigured } from "../trends/providers/twitterapi.js";
import { trendThemes } from "../prompts/trend-themes.v1.js";

/**
 * Populates the shared `trends` table a few times a day. Trends are fetched once
 * for the whole user base (biased by the themes users actually think about) and
 * matched per-user later by trend-match - so provider spend is O(1), not O(users).
 */
export async function handleTrendFetch(): Promise<void> {
  const themes = await interestThemes();
  if (themes.length === 0) return;
  console.log(`trend fetch: searching for [${themes.join(", ")}]`);

  // twitterapi is the ONLY source the macro-moment feature actually uses:
  // discover-x produces searchable-TERM topics + a driving source tweet + verified
  // volume. The Apify provider produces VERBATIM tweet-text topics that can never
  // clear the buzz gate (buzz ~0.15) AND are now filtered out of the candidate
  // query (source='twitterapi' only) - so fetching them was pure wasted spend and
  // table pollution. When twitterapi is configured we use ONLY discover-x; an
  // empty run just means the next tick retries (the 3-day table window covers the
  // gap). The Apify registry is the fallback ONLY on instances with no twitterapi.
  let trends;
  let provider;
  if (twitterapiConfigured()) {
    trends = await discoverXTrends(themes, 12).catch((err) => {
      console.error("trend fetch: X cluster discovery failed", err);
      return [];
    });
    provider = "twitterapi";
  } else {
    const fallback = await fetchTrendsWithFallback({ themes, limit: 24 });
    trends = fallback.trends;
    provider = fallback.provider ?? "none";
  }
  if (trends.length === 0) {
    console.warn(`trend fetch: no trends produced (provider=${provider})`);
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

const themesSchema = z.object({ themes: z.array(z.string().min(2).max(40)).catch([]) });

/**
 * The user base's interest fingerprint, distilled into SEARCH TERMS.
 *
 * Why distillation exists (learned the hard way, 2026-07-12): raw cluster
 * labels made terrible seeds. The biggest clusters by memory count are often
 * personal-life chatter ("Passport and Flight Issues", "Punjab and Drinks"),
 * so the trend search literally queried X for passport talk while a
 * Musk/Altman feud and a wave of model launches went unseen. And even
 * on-niche labels are phrases nobody tweets verbatim - an event news cycle
 * uses event vocabulary, so discovery needs short broad terms, not sentences.
 *
 * A cheap system-level LLM call turns profile niches/pillars + cluster labels
 * + recent positions into 4-6 short professional search terms, explicitly
 * discarding personal-life topics. Deterministic fallback (profile bits, then
 * cluster labels, then position slices) if the call fails - degraded seeds
 * beat no seeds.
 */
export async function interestThemes(): Promise<string[]> {
  const [profiles, clusters, positions] = await Promise.all([
    query<{ niche: string | null; content_pillars: string[] }>(
      `SELECT niche, content_pillars FROM brand_profiles WHERE niche IS NOT NULL OR array_length(content_pillars,1) > 0`,
    ),
    query<{ label: string }>(
      `SELECT label FROM clusters GROUP BY label ORDER BY count(*) DESC LIMIT 8`,
    ),
    query<{ statement: string }>(
      `SELECT statement FROM positions WHERE status = 'active' ORDER BY last_affirmed_at DESC LIMIT 12`,
    ),
  ]);
  const profileBits = [
    ...new Set(profiles.flatMap((p) => [...(p.niche ? [p.niche] : []), ...p.content_pillars])),
  ];
  const clusterLabels = clusters.map((c) => c.label);
  if (profileBits.length === 0 && clusterLabels.length === 0 && positions.length === 0) return [];

  try {
    const res = await llmCall({
      userId: null, // system job - exempt from per-user caps
      eventType: "trend_themes",
      tier: trendThemes.tier,
      system: trendThemes.system,
      user: trendThemes.render({
        profileBits,
        clusterLabels,
        positions: positions.map((p) => p.statement.slice(0, 120)),
      }),
      json: true,
      // Generous relative to the tiny payload: GLM front-loads prose before the
      // JSON; 150 truncated mid-object in live testing ("no JSON found").
      maxTokens: 400,
    });
    const parsed = themesSchema.parse(res.parsed);
    if (parsed.themes.length >= 2) return parsed.themes.slice(0, 6);
  } catch (err) {
    console.error("trend theme distillation failed, using raw fallback", err);
  }
  // Deterministic fallback, best signal first.
  if (profileBits.length > 0) return profileBits.slice(0, 6);
  if (clusterLabels.length > 0) return clusterLabels.slice(0, 6);
  return positions.map((p) => p.statement.slice(0, 80)).slice(0, 6);
}
