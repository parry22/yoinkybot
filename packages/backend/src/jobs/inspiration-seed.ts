/**
 * One-off Inspiration seed, enqueued once per user at the tail of diagnosis (the
 * first moment their niche/positions exist). It pre-populates the web Trends &
 * Virals tabs so a freshly-connected user sees real, on-niche value immediately
 * instead of an empty screen. Runs the existing per-user matchers in SEED mode
 * (channel 'web', no Telegram delivery). Best-effort throughout: any failure just
 * means the scheduled jobs backfill later.
 */
import { config } from "../config.js";
import { getProfile } from "../strategist/profile.js";
import { activePositions } from "../memory/positions.js";
import { trendMatchForUser } from "./trend-match.js";
import { viralBenchmarkForUser } from "./viral-benchmark.js";
import { fetchViralPool } from "../trends/viral-scoring.js";

export async function seedInspirationForUser(userId: string): Promise<void> {
  // A niche is required - positions are built during ingestion/diagnosis.
  const positions = await activePositions(userId);
  if (positions.length === 0) return;

  // Trends: reuse the per-user matcher in seed mode. Depends on the fleet `trends`
  // table being populated (trendFetch runs every 8h); if it's empty this no-ops.
  await trendMatchForUser(userId, {}, { seed: true }).catch((err) => console.error("trend inspiration seed failed", err));

  // Virals: needs a candidate pool from a paid search, so gate on the key. Themes
  // come from the user's own niche/pillars, so the pool is on-topic.
  if (!config.TWITTERAPI_IO_KEY) return;
  try {
    const profile = await getProfile(userId);
    const themes = [profile?.niche ?? "", ...(profile?.content_pillars ?? [])].filter(Boolean);
    if (themes.length === 0) return;
    const pool = await fetchViralPool(themes);
    if (pool.length > 0) await viralBenchmarkForUser(userId, pool, {}, { seed: true });
  } catch (err) {
    console.error("viral inspiration seed failed", err);
  }
}

export async function handleInspirationSeed(userId: string): Promise<void> {
  await seedInspirationForUser(userId);
}
