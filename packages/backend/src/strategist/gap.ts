import { query, queryOne } from "../db/pool.js";
import { parseVector } from "../lib/kmeans.js";
import { computeVoiceStats, type VoiceStats } from "../lib/voice-stats.js";
import { embedOne } from "../llm/embeddings.js";
import { computeEvidence } from "./evidence.js";
import { engagementTotal } from "./performance.js";
import { TONE_CLUSTER, TONE_LABEL, type BrandProfile } from "./profile.js";

/**
 * The GAP the onboarding pays off on (Stage 10): the user's ACTUAL public history
 * measured against the profile they STATED in Stages 1-7. Every number here is
 * computed deterministically — positioning drift, goal/content mismatch, tone
 * gap, audience fit, and the plain baseline (audience size, cadence, top/bottom
 * posts). The reveal prompt only interprets these numbers; it never invents them.
 *
 * Mirrors evidence.ts/performance.ts: the model gets facts, not a blank canvas.
 */

/** cosine distance (0 = identical direction, 2 = opposite). */
export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** A post's memories within this cosine distance of the stated niche count as "on-niche". */
const ON_NICHE_DISTANCE = 0.5;

/** Below this many idea/claim posts there is nothing to measure positioning against at all. */
const MIN_POSITIONING_POSTS = 6;
/**
 * At or above this many, the off-niche percentage is worth stating flatly. Below
 * it the figure is still computed and shown — dropping it would lose a real
 * finding — but it travels with its n and an instruction to hedge. The old code
 * printed "X% sit OFF the stated niche. USE THIS NUMBER." from as few as 6 posts,
 * where a single post swings the figure 17 points.
 */
const CONFIDENT_POSITIONING_POSTS = 20;

export interface GapResult {
  text: string;
  positioningOffPct: number | null;
  insideOutPct: number | null;
  followers: { x: number | null; linkedin: number | null };
  hasLinkedIn: boolean;
}

interface MemVec {
  content: string;
  created_at: string;
  vector: number[];
}

async function loadIdeaVectors(userId: string): Promise<MemVec[]> {
  const rows = await query<{ content: string; created_at: string; embedding: string }>(
    `SELECT content, created_at::text, embedding::text
     FROM memories
     WHERE user_id = $1 AND status = 'active' AND kind IN ('idea','claim') AND embedding IS NOT NULL
     ORDER BY created_at ASC LIMIT 400`,
    [userId],
  );
  return rows.map((r) => ({ content: r.content, created_at: r.created_at, vector: parseVector(r.embedding) }));
}

/** Positioning gap: how much of their actual output sits off the stated niche. */
async function positioningBlock(
  userId: string,
  profile: BrandProfile,
  ideas: MemVec[],
): Promise<{ text: string; offPct: number | null }> {
  const stated = [profile.niche, profile.sub_niche_angle, ...(profile.content_pillars ?? [])]
    .filter(Boolean)
    .join(". ");
  if (!stated || ideas.length < MIN_POSITIONING_POSTS) {
    return { text: "POSITIONING GAP: too little stated positioning or too few posts to measure against it.", offPct: null };
  }
  const nicheVec = await embedOne(stated, userId);
  const scored = ideas.map((m) => ({ ...m, dist: cosineDistance(m.vector, nicheVec) }));
  const off = scored.filter((m) => m.dist > ON_NICHE_DISTANCE);
  const offPct = Math.round((100 * off.length) / scored.length);
  const examples = [...off]
    .sort((a, b) => b.dist - a.dist)
    .slice(0, 3)
    .map((m) => `  [${m.created_at.slice(0, 10)}] ${m.content.slice(0, 140)}`);
  // The claim strength follows the sample size, deterministically. A thin corpus
  // still gets its number (with the n and a hedge instruction); only a corpus big
  // enough for one post not to move the figure gets the flat "USE THIS NUMBER".
  const confident = scored.length >= CONFIDENT_POSITIONING_POSTS;
  const claim = confident
    ? `${offPct}% sit OFF the stated niche. USE THIS NUMBER.`
    : `${offPct}% sit OFF the stated niche — but that is ${off.length} of only ${scored.length} posts, so one post moves it ` +
      `${Math.round(100 / scored.length)} points. State it as an early read with the sample size attached, never as a settled percentage.`;
  return {
    text:
      `POSITIONING GAP (cosine of ${scored.length} idea/claim posts vs stated niche "${profile.sub_niche_angle ?? profile.niche}"): ` +
      claim +
      (examples.length ? `\nFurthest-off examples (real, dated):\n${examples.join("\n")}` : ""),
    offPct,
  };
}

/** Goal alignment: does the existing content mix serve the stated primary goal. */
export function goalBlock(profile: BrandProfile, ratio: { insideOut: number; outsideIn: number; classified: number } | null): {
  text: string;
  insideOutPct: number | null;
} {
  if (!profile.primary_goal) return { text: "GOAL ALIGNMENT: no stated primary goal to measure against.", insideOutPct: null };
  if (!ratio) {
    return { text: `GOAL ALIGNMENT: stated goal is ${profile.primary_goal}, but too few classified posts to measure the content mix.`, insideOutPct: null };
  }
  const insideOutPct = Math.round((100 * ratio.insideOut) / ratio.classified);
  // Goals that need outward, audience-facing proof; a heavily inside-out feed underserves them.
  const outwardGoals = new Set(["leads", "authority", "product", "funding", "community"]);
  const note = outwardGoals.has(profile.primary_goal)
    ? insideOutPct >= 65
      ? `MISMATCH: a "${profile.primary_goal}" goal needs outward, audience-facing content, but ${insideOutPct}% of your posts are inside-out (about you/your work). Name this gap precisely.`
      : `Reasonably aligned: ${insideOutPct}% inside-out, which leaves room for the audience-facing content a "${profile.primary_goal}" goal needs.`
    : `Stated goal ${profile.primary_goal}; measured ${insideOutPct}% inside-out.`;
  return { text: `GOAL ALIGNMENT (${ratio.classified} classified posts): ${note}`, insideOutPct };
}

const STRUCTURED_TONES = new Set([
  "authority.analytical",
  "authority.data",
  "authority.teardown",
  "education.howto",
  "education.frameworks",
  "education.explainer",
  "persuasion.manifesto",
]);
const LOOSE_TONES = new Set(["reach.shitpost", "reach.meme", "reach.replyguy", "reach.trendjack"]);

/** Tone gap: selected tone taxonomy vs what the writing actually measures. */
export function toneBlock(profile: BrandProfile, voice: VoiceStats | null): string {
  const tones = profile.tone_selections ?? [];
  if (!tones.length) return "TONE GAP: no tones selected to measure against.";
  if (!voice) return "TONE GAP: too few posts to measure voice against the selected tones.";
  const findings: string[] = [];

  if (tones.some((t) => STRUCTURED_TONES.has(t)) && voice.meanSentenceLen < 10) {
    findings.push(
      `You picked structured/analytical modes (${tones.filter((t) => STRUCTURED_TONES.has(t)).map((t) => TONE_LABEL[t]).join(", ")}), but your median sentence is ${voice.meanSentenceLen} words, which reads fast and clipped, not built-out.`,
    );
  }
  if (tones.some((t) => LOOSE_TONES.has(t)) && voice.perPost.exclamations < 0.3 && voice.meanSentenceLen > 18) {
    findings.push(
      `You picked loose/entertainment modes, but the writing is long and even (median ${voice.meanSentenceLen} words, ${voice.perPost.exclamations} exclamations/post), not playful.`,
    );
  }
  // Cross-cluster tension (the spec's "name it plainly" case).
  const clusters = new Set(tones.map((t) => TONE_CLUSTER[t]).filter(Boolean));
  if (clusters.has("Authority / Expertise") && clusters.has("Entertainment / Reach")) {
    findings.push(
      "You picked both careful authority and loose entertainment modes. Those pull different directions, worth treating as separate content buckets, not one voice.",
    );
  }
  if ((profile.vulnerability_threshold === "none") && tones.some((t) => t.startsWith("trust."))) {
    findings.push(
      "You picked trust/relatability modes but set vulnerability to none. Those fight each other, the relatable modes need something real shown.",
    );
  }
  return findings.length
    ? `TONE GAP (selected tones vs measured voice):\n${findings.map((f) => `- ${f}`).join("\n")}`
    : `TONE GAP: your selected tones broadly match your measured voice (median ${voice.meanSentenceLen} words, ${voice.perPost.exclamations} exclamations/post).`;
}

/** Audience fit: does the writing meet the stated audience, and does it address their pain. */
async function audienceBlock(userId: string, profile: BrandProfile, voice: VoiceStats | null, ideas: MemVec[]): Promise<string> {
  const parts: string[] = [];
  if (profile.audience_sophistication && voice) {
    if (profile.audience_sophistication === "expert" && voice.meanSentenceLen < 9) {
      parts.push(`You write for an expert audience, but the prose is very simple (median ${voice.meanSentenceLen} words) — may read as under-pitched to peers.`);
    } else if (profile.audience_sophistication === "beginner" && voice.meanSentenceLen > 24) {
      parts.push(`You write for beginners, but the prose runs long and dense (median ${voice.meanSentenceLen} words) — may lose them.`);
    }
  }
  if (profile.audience_pain_point && ideas.length >= 6) {
    const painVec = await embedOne(profile.audience_pain_point, userId);
    const closest = Math.min(...ideas.map((m) => cosineDistance(m.vector, painVec)));
    if (closest > 0.55) {
      parts.push(`Few of your posts address the pain point you named ("${profile.audience_pain_point.slice(0, 80)}"); the closest is a ${closest.toFixed(2)} cosine away, which is distant.`);
    } else {
      parts.push(`You do touch the stated pain point (closest post ${closest.toFixed(2)} cosine away).`);
    }
  }
  return parts.length ? `AUDIENCE FIT:\n${parts.map((p) => `- ${p}`).join("\n")}` : "AUDIENCE FIT: not enough stated audience detail or posts to measure.";
}

/** One X post as the top/quietest ranking sees it. `e` is null when the source carried no metrics. */
export interface RankablePost {
  text: string;
  at: string;
  e: number | null;
}

/** Below this many metric-bearing posts there is nothing worth calling a top or a bottom. */
const MIN_RANKABLE_POSTS = 4;

/**
 * "Your best posts vs your quietest" — or the honest admission that there is no
 * such distinction to draw. Pure so the degenerate cases are unit-testable.
 *
 * THE BUG THIS FIXES. The old code filtered on `e !== null` and sorted, then
 * printed slice(0,2) as TOP and slice(-2) as QUIETEST whenever four posts
 * survived. For an account whose source reports real zeros — a small or new
 * account, which is exactly who this onboarding gap analysis runs for — every
 * post scores 0, so the sort is a no-op and the reveal prompt received two
 * identical "(0 eng)" lists labelled as opposites, which the model then
 * narrated as a performance contrast. The `else if (x)` honest fallback below
 * could never fire, because the count test passed.
 *
 * So the gate is now "is there a spread to rank on", not just "are there rows".
 */
export function topBottomLines(posts: RankablePost[], hasX: boolean): string[] {
  const withEng = posts
    .filter((p): p is RankablePost & { e: number } => p.e !== null)
    .sort((a, b) => b.e - a.e);
  const fmt = (p: { text: string; at: string; e: number }) => `  [${p.at.slice(0, 10)}] (${p.e} eng) ${p.text.slice(0, 120)}`;

  if (withEng.length >= MIN_RANKABLE_POSTS) {
    const top = withEng[0]!.e;
    const bottom = withEng[withEng.length - 1]!.e;
    if (top > bottom) {
      return [
        `TOP CONNECTED POSTS:\n${withEng.slice(0, 2).map(fmt).join("\n")}`,
        `QUIETEST CONNECTED POSTS:\n${withEng.slice(-2).map(fmt).join("\n")}`,
      ];
    }
    // Metrics exist and are all the same number — usually all zero. Naming the
    // number is more useful than pretending there's a best and a worst.
    return [
      `Connected post-level engagement is flat: all ${withEng.length} posts with metrics score exactly ${top}, so there is no best ` +
        `and no quietest post to compare. Say that plainly — do NOT invent a performance contrast.`,
    ];
  }
  if (hasX) {
    return [
      "Connected post-level engagement isn't available (no engagement source configured), so top/bottom posts are thin. Say so honestly.",
    ];
  }
  return [];
}

/**
 * `meta->>'followers'` is text out of jsonb and the meta blob is whatever the
 * importer last merged in, so it can be absent, null, or a non-numeric string.
 * The old `x?.followers ? Number(x.followers) : null` let a junk value through as
 * NaN, and the prompt then read "AUDIENCE SIZE: X followers: NaN" under a header
 * telling the model these are measured facts. web/analytics.ts and web/growth.ts
 * both type-check the same field before trusting it; this is the same check,
 * adapted for the `->>` text projection this query uses.
 */
function followerCount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The plain baseline the three-month plan moves from: audience size, cadence, top/bottom posts. */
async function baselineBlock(
  userId: string,
): Promise<{ text: string; followers: { x: number | null; linkedin: number | null }; hasLinkedIn: boolean }> {
  const accounts = await query<{ platform: string; followers: string | null; post_count: number; status: string }>(
    `SELECT platform, meta->>'followers' AS followers, post_count, status
     FROM connected_accounts WHERE user_id = $1`,
    [userId],
  );
  const x = accounts.find((a) => a.platform === "x");
  const li = accounts.find((a) => a.platform === "linkedin");
  const followers = {
    x: followerCount(x?.followers),
    linkedin: followerCount(li?.followers),
  };

  // Cadence over the ingested window.
  const span = await queryOne<{ n: string; first: string | null; last: string | null }>(
    `SELECT count(*)::text n, min(captured_at)::text first, max(captured_at)::text last
     FROM captures WHERE user_id = $1 AND source IN ('x_import','linkedin_import')`,
    [userId],
  );
  const n = Number(span?.n ?? 0);
  let cadence = "";
  if (n >= 3 && span?.first && span?.last) {
    const days = Math.max(1, (new Date(span.last).getTime() - new Date(span.first).getTime()) / 86_400_000);
    const perWeek = Math.round((n / (days / 7)) * 10) / 10;
    cadence = `Historic cadence: ~${perWeek} posts/week (${n} posts over ~${Math.round(days)} days).`;
  }

  // Top/bottom posts across connected platforms. LinkedIn's public-profile
  // actor now carries reactions/comments/reposts, so it participates honestly.
  const xPosts = await query<{ raw_text: string | null; captured_at: string; eng: unknown }>(
    `SELECT raw_text, captured_at::text, metadata->'engagement' AS eng
     FROM captures WHERE user_id = $1 AND source IN ('x_import','linkedin_import') AND raw_text IS NOT NULL`,
    [userId],
  );

  const lines: string[] = [];
  const audience: string[] = [];
  if (followers.x !== null) audience.push(`X followers: ${followers.x}`);
  if (followers.linkedin !== null) audience.push(`LinkedIn followers: ${followers.linkedin}`);
  if (audience.length) lines.push(`AUDIENCE SIZE: ${audience.join(", ")}.`);
  if (cadence) lines.push(cadence);
  lines.push(
    ...topBottomLines(
      xPosts.map((p) => ({ text: p.raw_text!, at: p.captured_at, e: engagementTotal(p.eng) })),
      !!x || !!li,
    ),
  );
  return {
    text: `STARTING POINT (the real baseline the plan moves from):\n${lines.join("\n")}`,
    followers,
    hasLinkedIn: !!li,
  };
}

/**
 * Compute the full gap analysis. Deterministic; the reveal prompt narrates it.
 * Defensive throughout — any section with too little data says so rather than
 * fabricating a finding.
 */
export async function computeGap(userId: string, profile: BrandProfile): Promise<GapResult> {
  const [ideas, allPosts, evidence, baseline] = await Promise.all([
    loadIdeaVectors(userId),
    query<{ content: string; created_at: string }>(
      `SELECT content, created_at::text FROM memories WHERE user_id = $1 AND status = 'active' ORDER BY created_at ASC LIMIT 500`,
      [userId],
    ),
    computeEvidence(userId),
    baselineBlock(userId),
  ]);
  const voice = computeVoiceStats(allPosts);

  const positioning = await positioningBlock(userId, profile, ideas);
  const goal = goalBlock(profile, evidence.ratio);
  const tone = toneBlock(profile, voice);
  const audience = await audienceBlock(userId, profile, voice, ideas);

  const text = [baseline.text, positioning.text, goal.text, tone, audience].join("\n\n");
  return {
    text,
    positioningOffPct: positioning.offPct,
    insideOutPct: goal.insideOutPct,
    followers: baseline.followers,
    hasLinkedIn: baseline.hasLinkedIn,
  };
}
