/**
 * X analytics for the web app. The fast path reads the per-post engagement we
 * already store on `captures` (impressions/likes/replies/RT/quotes/bookmarks),
 * so the page loads instantly with no API call. Reply-level performance is a
 * separate, on-demand pull (rate-limited, ~seconds) since replies aren't stored.
 *
 * Honesty note: we surface every metric X actually exposes through our sources.
 * Profile clicks, per-post follower attribution, and revenue/RPM are NOT in any
 * public/scrape API - they're reported as unavailable rather than faked.
 */
import { query, queryOne } from "../db/pool.js";
import { config } from "../config.js";
import { pullXTimelineWithMetrics } from "../capture/imports/twitterapi-io.js";

export interface AnalyticsPost {
  url: string | null;
  text: string;
  createdAt: string;
  impressions: number;
  likes: number;
  replies: number;
  retweets: number;
  quotes: number;
  bookmarks: number;
  engagements: number;
  engagementRate: number | null;
}

export interface HeatCell {
  day: number; // 0=Sun … 6=Sat
  hour: number; // 0..23 in the user's timezone
  posts: number;
  impressions: number;
  engagements: number;
}

/** Median engagement of a content *format* (question, link, thread…) vs your own baseline. */
export interface FormatStat {
  key: string;
  label: string;
  posts: number;
  medianEngagementRate: number | null;
  medianImpressions: number | null;
  /** % above/below your own overall median engagement rate. */
  liftPct: number | null;
}

/** One 7-day bucket of posting momentum (oldest → newest). */
export interface WeeklyPoint {
  weeksAgo: number; // 7 … 0 (0 = this week)
  posts: number;
  impressions: number;
}

/** How posts shipped THROUGH Yoinky perform vs the rest - the differentiated metric. */
export interface YoinkImpact {
  assistedPosts: number;
  assistedImpressions: number;
  assistedMedianEngagementRate: number | null;
  baselineMedianEngagementRate: number | null;
  liftPct: number | null;
}

/** What the Auto Agent has actually produced (operational, from automation_runs). */
export interface AgentScorecard {
  drafted: number;
  shipped: number;
  awaiting: number;
  rejected: number;
  avgEdits: number;
}

export interface AnalyticsData {
  connected: boolean;
  handle: string | null;
  followers: number | null;
  timezone: string;
  postsAnalyzed: number;
  hasMetrics: boolean;
  totals: { impressions: number; engagements: number; likes: number; replies: number; retweets: number; bookmarks: number };
  medians: { impressions: number | null; engagements: number | null; engagementRate: number | null };
  topPosts: AnalyticsPost[];
  recentPosts: AnalyticsPost[];
  heatmap: HeatCell[];
  bestWindow: { day: number; hour: number } | null;
  formats: FormatStat[];
  weekly: WeeklyPoint[];
  impact: YoinkImpact;
  agent: AgentScorecard;
  unavailable: string[];
}

const EMPTY_IMPACT: YoinkImpact = {
  assistedPosts: 0, assistedImpressions: 0, assistedMedianEngagementRate: null, baselineMedianEngagementRate: null, liftPct: null,
};
const EMPTY_AGENT: AgentScorecard = { drafted: 0, shipped: 0, awaiting: 0, rejected: 0, avgEdits: 0 };

// Deterministic content-format lenses. A post can match several - each is a
// separate way of slicing the same posts, computed from the text we already
// store (no model, no extra API). This is the "beyond native analytics" cut:
// X shows you numbers per post, not which *shape* of post earns you the most.
const FORMAT_BUCKETS: { key: string; label: string; test: (p: AnalyticsPost) => boolean }[] = [
  { key: "question", label: "Asks a question", test: (p) => /\?/.test(p.text) },
  { key: "link", label: "Includes a link", test: (p) => /https?:\/\//i.test(p.text) },
  { key: "short", label: "Short & punchy (≤120 chars)", test: (p) => p.text.length <= 120 },
  { key: "long", label: "Longer takes (≥240 chars)", test: (p) => p.text.length >= 240 },
  { key: "multiline", label: "Threads & lists", test: (p) => /\n/.test(p.text) },
];

/** A day/hour cell needs at least this many posts before it can be called a "best window". */
const MIN_BEST_WINDOW_POSTS = 2;

function tweetId(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/status\/(\d+)/);
  return m ? m[1]! : null;
}

function formatStats(posts: AnalyticsPost[]): FormatStat[] {
  const overall = median(posts.filter((p) => p.engagementRate !== null).map((p) => p.engagementRate as number));
  const out: FormatStat[] = [];
  for (const b of FORMAT_BUCKETS) {
    const inb = posts.filter(b.test);
    if (inb.length < 3) continue; // too few to be a signal
    const medRate = median(inb.filter((p) => p.engagementRate !== null).map((p) => p.engagementRate as number));
    const liftPct = medRate !== null && overall !== null && overall > 0 ? ((medRate - overall) / overall) * 100 : null;
    out.push({ key: b.key, label: b.label, posts: inb.length, medianEngagementRate: medRate, medianImpressions: median(inb.map((p) => p.impressions)), liftPct });
  }
  // Sort by lift, nulls last. The old comparator was
  // `(b.liftPct ?? -Infinity) - (a.liftPct ?? -Infinity)`, which returns NaN for
  // any pair where BOTH lifts are null (-Infinity - -Infinity) - and every lift
  // is null whenever the overall median engagement rate is 0 or unmeasurable,
  // i.e. exactly the accounts with no impression data. A NaN comparator leaves
  // the array in an implementation-defined order, so the "best format" the page
  // leads with was arbitrary. Compare the null-ness first, then the numbers.
  return out.sort((a, b) => {
    if (a.liftPct === null && b.liftPct === null) return 0;
    if (a.liftPct === null) return 1;
    if (b.liftPct === null) return -1;
    return b.liftPct - a.liftPct;
  });
}

function weeklyMomentum(posts: AnalyticsPost[]): WeeklyPoint[] {
  const WEEKS = 8;
  const now = Date.now();
  const wk = 7 * 24 * 60 * 60 * 1000;
  const buckets = Array.from({ length: WEEKS }, () => ({ posts: 0, impressions: 0 }));
  for (const p of posts) {
    const t = new Date(p.createdAt).getTime();
    if (!Number.isFinite(t)) continue;
    const idx = Math.floor((now - t) / wk);
    if (idx < 0 || idx >= WEEKS) continue;
    buckets[idx]!.posts += 1;
    buckets[idx]!.impressions += p.impressions;
  }
  return buckets.map((b, i) => ({ weeksAgo: i, posts: b.posts, impressions: b.impressions })).reverse();
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const UNAVAILABLE = [
  "Profile clicks & link clicks - X does not expose these through any public or scrape API.",
  "Per-post / per-reply follower attribution - X never says which post produced a follow.",
  "Estimated revenue / RPM by content - not in the public API.",
];

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function toPost(eng: Record<string, unknown>, text: string, url: string | null, createdAt: string): AnalyticsPost {
  const impressions = num(eng.viewCount);
  const likes = num(eng.likeCount);
  const replies = num(eng.replyCount);
  const retweets = num(eng.retweetCount);
  const quotes = num(eng.quoteCount);
  const bookmarks = num(eng.bookmarkCount);
  const engagements = likes + replies + retweets + quotes + bookmarks;
  return {
    url,
    text: text.length > 240 ? text.slice(0, 240) + "…" : text,
    createdAt,
    impressions,
    likes,
    replies,
    retweets,
    quotes,
    bookmarks,
    engagements,
    engagementRate: impressions > 0 ? engagements / impressions : null,
  };
}

function localCell(iso: string, tz: string): { day: number; hour: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
    let hr = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    if (hr === 24) hr = 0;
    const day = DOW.indexOf(wd);
    return day >= 0 && hr >= 0 ? { day, hour: hr } : null;
  } catch {
    return null;
  }
}

async function xAccount(userId: string): Promise<{ handle: string; followers: number | null } | null> {
  const row = await queryOne<{ handle: string; meta: Record<string, unknown> | null }>(
    `SELECT handle, meta FROM connected_accounts WHERE user_id = $1 AND platform = 'x' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!row) return null;
  const followers = typeof row.meta?.followers === "number" ? row.meta.followers : null;
  return { handle: row.handle, followers };
}

async function userTimezone(userId: string): Promise<string> {
  const row = await queryOne<{ tz: string | null }>(
    `SELECT settings->>'timezone' AS tz FROM users WHERE id = $1`,
    [userId],
  );
  return row?.tz || "UTC";
}

/** Fast, no-API analytics from stored post engagement. */
export async function getAnalytics(userId: string): Promise<AnalyticsData> {
  const [acct, tz] = await Promise.all([xAccount(userId), userTimezone(userId)]);
  if (!acct) {
    return {
      connected: false, handle: null, followers: null, timezone: tz, postsAnalyzed: 0, hasMetrics: false,
      totals: { impressions: 0, engagements: 0, likes: 0, replies: 0, retweets: 0, bookmarks: 0 },
      medians: { impressions: null, engagements: null, engagementRate: null },
      topPosts: [], recentPosts: [], heatmap: [], bestWindow: null,
      formats: [], weekly: [], impact: EMPTY_IMPACT, agent: EMPTY_AGENT, unavailable: UNAVAILABLE,
    };
  }

  const rows = await query<{ created_at: string; raw_text: string | null; url: string | null; eng: unknown }>(
    `SELECT c.captured_at::text AS created_at, c.raw_text,
            c.metadata->>'url' AS url, c.metadata->'engagement' AS eng
     FROM captures c
     WHERE c.user_id = $1 AND c.source = 'x_import' AND c.metadata->'engagement' IS NOT NULL
     ORDER BY c.captured_at DESC`,
    [userId],
  );

  const posts: AnalyticsPost[] = [];
  for (const r of rows) {
    if (!r.eng || typeof r.eng !== "object") continue;
    const p = toPost(r.eng as Record<string, unknown>, r.raw_text ?? "", r.url, r.created_at);
    // Only count posts that actually carry impression/engagement signal.
    if (p.impressions > 0 || p.engagements > 0) posts.push(p);
  }

  const totals = posts.reduce(
    (a, p) => ({
      impressions: a.impressions + p.impressions,
      engagements: a.engagements + p.engagements,
      likes: a.likes + p.likes,
      replies: a.replies + p.replies,
      retweets: a.retweets + p.retweets,
      bookmarks: a.bookmarks + p.bookmarks,
    }),
    { impressions: 0, engagements: 0, likes: 0, replies: 0, retweets: 0, bookmarks: 0 },
  );

  const heat = new Map<string, HeatCell>();
  for (const p of posts) {
    const c = localCell(p.createdAt, tz);
    if (!c) continue;
    const key = `${c.day}:${c.hour}`;
    const cell = heat.get(key) ?? { day: c.day, hour: c.hour, posts: 0, impressions: 0, engagements: 0 };
    cell.posts += 1;
    cell.impressions += p.impressions;
    cell.engagements += p.engagements;
    heat.set(key, cell);
  }
  const heatmap = [...heat.values()];
  // Best window = highest engagement-per-post cell with at least MIN_BEST_WINDOW_POSTS
  // posts. There is deliberately NO fallback any more: it used to fall back to
  // `ranked[0]`, which is a single-post cell on a sparse account - "your best time
  // to post is Tuesday 3pm" derived from one tweet - and, when every cell has zero
  // engagement, the comparator is 0 for every pair so `ranked[0]` is just whichever
  // cell the Map happened to yield first. The UI already refuses to decorate a
  // best window built on fewer than two posts, so claiming one here was a promise
  // nothing downstream honoured. Null is the honest answer.
  const ranked = [...heatmap].sort((a, b) => b.engagements / b.posts - a.engagements / a.posts);
  const best = ranked.find((c) => c.posts >= MIN_BEST_WINDOW_POSTS) ?? null;

  // ── Yoinky's own-data cuts ─────────────────────────────────────────────
  // 1) Posts shipped THROUGH Yoinky (published scheduler) → match back to their
  //    captured metrics by tweet id, so we can show assisted-vs-baseline lift.
  const shipped = await query<{ external_url: string | null }>(
    `SELECT external_url FROM scheduled_posts WHERE user_id = $1 AND status = 'published' AND external_url IS NOT NULL`,
    [userId],
  );
  const shippedIds = new Set(shipped.map((r) => tweetId(r.external_url)).filter((x): x is string => !!x));
  const isAssisted = (p: AnalyticsPost) => {
    const id = tweetId(p.url);
    return !!id && shippedIds.has(id);
  };
  const assisted = posts.filter(isAssisted);
  const baseline = posts.filter((p) => !isAssisted(p));
  const impact: YoinkImpact = {
    assistedPosts: assisted.length,
    assistedImpressions: assisted.reduce((a, p) => a + p.impressions, 0),
    assistedMedianEngagementRate: median(assisted.filter((p) => p.engagementRate !== null).map((p) => p.engagementRate as number)),
    baselineMedianEngagementRate: median(baseline.filter((p) => p.engagementRate !== null).map((p) => p.engagementRate as number)),
    liftPct: null,
  };
  if (
    impact.assistedMedianEngagementRate !== null &&
    impact.baselineMedianEngagementRate !== null &&
    impact.baselineMedianEngagementRate > 0
  ) {
    impact.liftPct = ((impact.assistedMedianEngagementRate - impact.baselineMedianEngagementRate) / impact.baselineMedianEngagementRate) * 100;
  }

  // 2) Auto Agent scorecard - operational counts straight from automation_runs.
  const agentRow = await queryOne<{ drafted: string; shipped: string; awaiting: string; rejected: string; avg_edits: string }>(
    `SELECT
       count(*) FILTER (WHERE draft_body IS NOT NULL)::text AS drafted,
       count(*) FILTER (WHERE status IN ('scheduled','posted','approved'))::text AS shipped,
       count(*) FILTER (WHERE status = 'awaiting_approval')::text AS awaiting,
       count(*) FILTER (WHERE status = 'rejected')::text AS rejected,
       COALESCE(round(avg(edit_count) FILTER (WHERE draft_body IS NOT NULL), 2), 0)::text AS avg_edits
     FROM automation_runs WHERE user_id = $1`,
    [userId],
  );
  const agent: AgentScorecard = {
    drafted: Number(agentRow?.drafted ?? 0),
    shipped: Number(agentRow?.shipped ?? 0),
    awaiting: Number(agentRow?.awaiting ?? 0),
    rejected: Number(agentRow?.rejected ?? 0),
    avgEdits: Number(agentRow?.avg_edits ?? 0),
  };

  return {
    connected: true,
    handle: acct.handle,
    followers: acct.followers,
    timezone: tz,
    postsAnalyzed: posts.length,
    hasMetrics: posts.length > 0,
    totals,
    medians: {
      impressions: median(posts.map((p) => p.impressions)),
      engagements: median(posts.map((p) => p.engagements)),
      engagementRate: median(posts.filter((p) => p.engagementRate !== null).map((p) => p.engagementRate as number)),
    },
    topPosts: [...posts].sort((a, b) => b.impressions - a.impressions).slice(0, 8),
    recentPosts: posts.slice(0, 25),
    heatmap,
    bestWindow: best ? { day: best.day, hour: best.hour } : null,
    formats: formatStats(posts),
    weekly: weeklyMomentum(posts),
    impact,
    agent,
    unavailable: UNAVAILABLE,
  };
}

export interface ReplyAnalytics {
  available: boolean;
  reason?: string;
  count: number;
  medianImpressions: number | null;
  medianEngagementRate: number | null;
  totalImpressions: number;
  sample: AnalyticsPost[];
}

/** On-demand reply-level performance (live pull; slower + rate-limited). */
export async function getReplyAnalytics(userId: string, max = 40): Promise<ReplyAnalytics> {
  const empty = (reason: string): ReplyAnalytics => ({
    available: false, reason, count: 0, medianImpressions: null, medianEngagementRate: null, totalImpressions: 0, sample: [],
  });
  if (!config.TWITTERAPI_IO_KEY) return empty("Reply metrics need the twitterapi.io source (not configured).");
  const acct = await xAccount(userId);
  if (!acct) return empty("Connect your X account first.");

  let pull: Awaited<ReturnType<typeof pullXTimelineWithMetrics>>;
  try {
    pull = await pullXTimelineWithMetrics(acct.handle, max);
  } catch {
    return empty("Couldn't reach X right now - try again in a bit.");
  }

  const replies = pull.tweets
    .filter((t) => t.isReply)
    .map((t) =>
      toPost(
        { viewCount: t.viewCount, likeCount: t.likeCount, replyCount: t.replyCount, retweetCount: t.retweetCount, quoteCount: t.quoteCount, bookmarkCount: t.bookmarkCount },
        t.text,
        t.url,
        t.createdAt,
      ),
    );

  if (!replies.length) {
    return { available: true, count: 0, medianImpressions: null, medianEngagementRate: null, totalImpressions: 0, sample: [] };
  }

  return {
    available: true,
    count: replies.length,
    medianImpressions: median(replies.map((r) => r.impressions)),
    medianEngagementRate: median(replies.filter((r) => r.engagementRate !== null).map((r) => r.engagementRate as number)),
    totalImpressions: replies.reduce((a, r) => a + r.impressions, 0),
    sample: [...replies].sort((a, b) => b.impressions - a.impressions).slice(0, 10),
  };
}
