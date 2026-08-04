import { query, queryOne, toVector } from "../db/pool.js";
import { config } from "../config.js";
import { embedOne } from "../llm/embeddings.js";
import { getBoss, QUEUES } from "../jobs/boss.js";
import { createCapture } from "../capture/service.js";
import { pullXProfileViaTwitterApiIo } from "../capture/imports/twitterapi-io.js";
import { canDeliverProactive } from "../surfacing/cadence.js";
import { sendTelegram } from "../telegram/bot.js";
import { InlineKeyboard } from "grammy";
import type { UserSettings } from "../lib/time.js";
import type { PlanView } from "./plan.js";

/**
 * Deterministic performance analytics for the Monday progress report. Every
 * number the report's LLM sees is computed here — the model interprets, it
 * never measures. Same architecture as the diagnosis's computed evidence.
 */

/** A post is "on throughline" when its memories sit within this cosine distance of it. */
const ALIGNED_DISTANCE = 0.5;
/** Below this many engagement-bearing baseline posts, rates are too noisy to report as full-confidence. */
const MIN_BASELINE_POSTS = 8;
/**
 * A split needs at least this many engagement-bearing posts per bucket to mean
 * anything. Was 2, which rendered a median-of-2-vs-median-of-3 under the header
 * "THROUGHLINE SPLIT (the headline comparison)" — a coin flip presented as the
 * report's central finding. 4 is still small, which is why renderPerformance now
 * also states the bucket sizes as a sample size the model is told to hedge on.
 */
const MIN_SPLIT_BUCKET = 4;
/** At or above this per bucket, the split is worth stating without a caveat. */
const CONFIDENT_SPLIT_BUCKET = 8;
const OUTLIER_RATIO = 1.5;
const MAX_OUTLIERS = 3;

// ── Pure analysis (unit-tested, no I/O) ──────────────────────────────────────

export interface PerfPost {
  platform: "x" | "linkedin";
  /** likes+replies+retweets+quotes at last refresh; null when the source never provided metrics. */
  engagement: number | null;
  capturedAt: number; // original publish time, epoch ms
  alignedDistance: number | null; // min cosine distance of its memories to the throughline
  orientation: string | null; // inside_out | outside_in | neutral
  content: string;
  url: string | null;
  /** Unlock-list idea this post developed, when provenance links them. */
  unlockIdea: string | null;
  /** Backing capture — lets an outlier be repurposed straight from the report. */
  captureId?: string | null;
  /** Read directly off captures — no subquery needed, unlike orientation, since
   *  these already live at capture granularity (memory/classification.ts). */
  rhetoricalMode?: string | null;
  sincerityRegister?: string | null;
}

export interface Outlier {
  content: string;
  url: string | null;
  engagement: number;
  ratio: number; // vs baseline median
  orientation: string | null;
  aligned: boolean | null;
  unlockIdea: string | null;
  captureId: string | null;
  rhetoricalMode: string | null;
  sincerityRegister: string | null;
}

export interface PostAnalysis {
  periodDays: number;
  baseline: { posts: number; median: number | null };
  period: { posts: number; withEngagement: number; median: number | null };
  split: { aligned: { posts: number; median: number }; off: { posts: number; median: number } } | null;
  /** Sincere vs everything else (ironic/self_deprecating/absurdist/ambiguous),
   *  same gating as the throughline split — "your outlier was a shitpost, not
   *  your usual analytical mode" is a real, useful distinction. */
  sincerityMix: { sincere: { posts: number; median: number }; other: { posts: number; median: number } } | null;
  outliers: Outlier[];
  actualPerWeek: number;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** All the post math in one pure pass: baseline vs period, split, outliers, cadence. */
export function analyzePosts(posts: PerfPost[], periodStartMs: number, nowMs: number): PostAnalysis {
  const periodDays = Math.max(1, Math.round((nowMs - periodStartMs) / 86_400_000));
  const inPeriod = posts.filter((p) => p.capturedAt >= periodStartMs);
  const baselinePosts = posts.filter((p) => p.capturedAt < periodStartMs && p.engagement !== null);
  const baselineMedian = median(baselinePosts.map((p) => p.engagement!));

  const periodWithEng = inPeriod.filter((p) => p.engagement !== null);
  const periodMedian = median(periodWithEng.map((p) => p.engagement!));

  // Throughline split — only over period posts where both engagement and an
  // alignment reading exist, and only when each bucket is big enough to mean anything.
  const alignedPosts = periodWithEng.filter((p) => p.alignedDistance !== null && p.alignedDistance < ALIGNED_DISTANCE);
  const offPosts = periodWithEng.filter((p) => p.alignedDistance !== null && p.alignedDistance >= ALIGNED_DISTANCE);
  const split =
    alignedPosts.length >= MIN_SPLIT_BUCKET && offPosts.length >= MIN_SPLIT_BUCKET
      ? {
          aligned: { posts: alignedPosts.length, median: median(alignedPosts.map((p) => p.engagement!))! },
          off: { posts: offPosts.length, median: median(offPosts.map((p) => p.engagement!))! },
        }
      : null;

  // Sincere vs not — only over period posts that actually carry a sincerity
  // read (older captures/legacy data have none, correctly excluded rather
  // than guessed at).
  const sincerePosts = periodWithEng.filter((p) => p.sincerityRegister === "sincere");
  const otherRegisterPosts = periodWithEng.filter((p) => p.sincerityRegister != null && p.sincerityRegister !== "sincere");
  const sincerityMix =
    sincerePosts.length >= MIN_SPLIT_BUCKET && otherRegisterPosts.length >= MIN_SPLIT_BUCKET
      ? {
          sincere: { posts: sincerePosts.length, median: median(sincerePosts.map((p) => p.engagement!))! },
          other: { posts: otherRegisterPosts.length, median: median(otherRegisterPosts.map((p) => p.engagement!))! },
        }
      : null;

  // Outliers need a trustworthy baseline; a 1.5x of noise is not a finding.
  const outliers: Outlier[] =
    baselinePosts.length >= MIN_BASELINE_POSTS && baselineMedian !== null && baselineMedian > 0
      ? periodWithEng
          .filter((p) => p.engagement! >= OUTLIER_RATIO * baselineMedian)
          .sort((a, b) => b.engagement! - a.engagement!)
          .slice(0, MAX_OUTLIERS)
          .map((p) => ({
            content: p.content.slice(0, 160),
            url: p.url,
            engagement: p.engagement!,
            ratio: Math.round((p.engagement! / baselineMedian) * 10) / 10,
            orientation: p.orientation,
            aligned: p.alignedDistance === null ? null : p.alignedDistance < ALIGNED_DISTANCE,
            unlockIdea: p.unlockIdea,
            captureId: p.captureId ?? null,
            rhetoricalMode: p.rhetoricalMode ?? null,
            sincerityRegister: p.sincerityRegister ?? null,
          }))
      : [];

  return {
    periodDays,
    baseline: { posts: baselinePosts.length, median: baselineMedian },
    period: { posts: inPeriod.length, withEngagement: periodWithEng.length, median: periodMedian },
    split,
    sincerityMix,
    outliers,
    actualPerWeek: Math.round((inPeriod.length / (periodDays / 7)) * 10) / 10,
  };
}

export interface PerformanceData {
  analysis: PostAnalysis;
  xConfidence: "full" | "partial" | "unavailable";
  xConfidenceReason: string;
  linkedinConnected: boolean;
  unlock: { developedInPeriod: number; developedTotal: number; pending: number };
  committedPerWeek: number | null;
  draftsInPeriod: number;
}

/**
 * The hedge instruction that rides alongside a split whose smaller bucket is
 * still thin. Deterministic (code decides whether the sample is thin); the model
 * only phrases it.
 */
function smallSampleCaveat(a: number, b: number): string {
  const n = Math.min(a, b);
  if (n >= CONFIDENT_SPLIT_BUCKET) return "";
  return ` SMALL SAMPLE: the thinner side is ${n} posts, so one post moves the median a lot — state it as a lean, not a proven effect.`;
}

/** Render the computed block the report LLM is handed. Pure; unit-tested. */
export function renderPerformance(d: PerformanceData): string {
  const a = d.analysis;
  const lines: string[] = [`COMPUTED PERFORMANCE (period: last ${a.periodDays} days — every number below is measured, use them verbatim)`];

  if (d.xConfidence === "unavailable") {
    lines.push(`Social engagement: unavailable this period (${d.xConfidenceReason}).`);
  } else {
    // `baseline.median` is null whenever NO prior post carried metrics (freshly
    // connected account, or a source that gave us none). It used to be
    // interpolated raw, so under a header that reads "every number below is
    // measured, use them verbatim" the model was literally handed
    // "baseline median engagement null per post" — and repeated it. The sibling
    // period median on the same line was already guarded; this matches it.
    const baselineMedian = a.baseline.median === null ? "n/a (no prior post carries metrics)" : String(a.baseline.median);
    lines.push(
      `Connected social history: baseline median engagement ${baselineMedian} per post (measured over ${a.baseline.posts} prior posts) · ` +
        `this period ${a.period.posts} posts, ${a.period.withEngagement} with metrics, median ${a.period.median ?? "n/a"}` +
        (a.baseline.median && a.period.median !== null
          ? ` (${Math.round((a.period.median / a.baseline.median) * 100)}% of baseline)`
          : ""),
    );
    lines.push(`Social data confidence: ${d.xConfidence}${d.xConfidence !== "full" ? ` (${d.xConfidenceReason})` : ""}.`);
  }

  // Both splits carry their bucket sizes AND, when a bucket is small, an explicit
  // instruction to hedge. A median over four posts moves ~25 points per post; the
  // model can only be honest about that if it is told the n, so the n travels with
  // the number rather than being implied by the header.
  lines.push(
    a.split
      ? `THROUGHLINE SPLIT (the headline comparison): on-throughline ${a.split.aligned.posts} posts, median ${a.split.aligned.median} vs off-throughline ${a.split.off.posts} posts, median ${a.split.off.median}.` +
          smallSampleCaveat(a.split.aligned.posts, a.split.off.posts)
      : `THROUGHLINE SPLIT: too few posts this period to split meaningfully (${a.period.withEngagement} with metrics; each side needs ${MIN_SPLIT_BUCKET}). Say so rather than inventing a comparison.`,
  );

  if (a.sincerityMix) {
    lines.push(
      `TONE SPLIT: sincere posts ${a.sincerityMix.sincere.posts}, median ${a.sincerityMix.sincere.median} vs ` +
        `non-sincere (joke/bit/ironic) posts ${a.sincerityMix.other.posts}, median ${a.sincerityMix.other.median}.` +
        smallSampleCaveat(a.sincerityMix.sincere.posts, a.sincerityMix.other.posts),
    );
  }

  lines.push(
    a.outliers.length
      ? `OUTLIERS (≥1.5x baseline):\n` +
          a.outliers
            .map(
              (o) =>
                `- "${o.content}" — engagement ${o.engagement} (${o.ratio}x baseline)` +
                `${o.orientation ? ` · ${o.orientation}` : ""}` +
                `${o.aligned === null ? "" : o.aligned ? " · on-throughline" : " · off-throughline"}` +
                `${o.sincerityRegister && o.sincerityRegister !== "sincere" ? ` · ${o.sincerityRegister.replace("_", "-")}, not your usual mode` : ""}` +
                `${o.unlockIdea ? ` · developed unlock idea: "${o.unlockIdea}"` : ""}`,
            )
            .join("\n")
      : "OUTLIERS: none this period.",
  );

  lines.push(
    `UNLOCK CONVERSION: ${d.unlock.developedInPeriod} developed this period · ${d.unlock.developedTotal} developed total · ${d.unlock.pending} still pending.`,
  );
  lines.push(
    `CADENCE: committed ${d.committedPerWeek ?? "not set"}/week · actual ${a.actualPerWeek}/week (${a.period.posts} published posts in ${a.periodDays} days) · ${d.draftsInPeriod} drafts written with me this period.`,
  );
  return lines.join("\n");
}

// ── Refresh: keep engagement current + ingest posts published since connect ──

export interface RefreshResult {
  status: "ok" | "skipped" | "failed";
  updated: number;
  added: number;
  /** New posts seen but deliberately not ingested (see `ingestNew`). */
  skippedNew?: number;
}

export interface RefreshOpts {
  /**
   * Ingest genuinely new posts through the LLM extract pipeline, not just refresh
   * metrics on posts we already hold. Defaults to true, which is the historic
   * behaviour and what every user-initiated path wants.
   *
   * The unattended fleet sweep (jobs/x-refresh.ts) turns this OFF for users with
   * no active entitlement. Metric refreshes are a cheap DB update and everyone
   * gets them; extraction is an LLM call per post, and `extract` sits in
   * CAP_EXEMPT_EVENTS (llm/gateway.ts) so it does not even count against the
   * daily budget. Left on, a twice-daily sweep would give a lapsed free account
   * unmetered LLM extraction indefinitely.
   */
  ingestNew?: boolean;
}

/**
 * Engagement is captured as a snapshot at /connect time and posts published
 * afterwards never enter the system on their own — so before each performance
 * read, re-pull the user's recent X history: refresh metrics on posts we
 * already hold (matched by client_id) and ingest genuinely new ones through
 * the normal extract pipeline (oldest first, so belief reconciliation stays
 * chronological). LinkedIn's Apify profile pull is refreshed by its own job.
 */
export async function refreshXEngagement(userId: string, maxPosts = 100, opts: RefreshOpts = {}): Promise<RefreshResult> {
  const ingestNew = opts.ingestNew !== false;
  if (!config.TWITTERAPI_IO_KEY) return { status: "skipped", updated: 0, added: 0 };
  const account = await queryOne<{ handle: string }>(
    `SELECT handle FROM connected_accounts WHERE user_id = $1 AND platform = 'x' AND status = 'ingested'`,
    [userId],
  );
  if (!account) return { status: "skipped", updated: 0, added: 0 };

  try {
    const pull = await pullXProfileViaTwitterApiIo(account.handle, maxPosts);
    const posts = pull.posts.filter((p) => p.text.length >= 20 && p.url);
    posts.sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());

    const boss = getBoss();
    let updated = 0;
    let added = 0;
    let skippedNew = 0;
    for (const post of posts) {
      const clientId = `x:${post.url}`;
      const row = await queryOne<{ id: string }>(
        `UPDATE captures SET metadata = metadata || $3::jsonb
         WHERE user_id = $1 AND client_id = $2 RETURNING id`,
        [
          userId,
          clientId,
          JSON.stringify({ engagement: post.engagement ?? {}, ...(post.media?.length ? { media: post.media } : {}) }),
        ],
      );
      if (row) {
        updated++;
        continue;
      }
      // Metric refreshes on posts we already hold happen above for EVERYONE — a
      // plain UPDATE, and the whole point of the job. Only the LLM-backed ingest
      // of genuinely new posts is gated (see RefreshOpts.ingestNew).
      if (!ingestNew) {
        skippedNew++;
        continue;
      }
      const { capture, created } = await createCapture({
        userId,
        source: "x_import",
        rawText: post.text,
        capturedAt: post.postedAt,
        clientId,
        metadata: {
          published: true,
          url: post.url ?? null,
          engagement: post.engagement ?? {},
          ...(post.media?.length ? { media: post.media } : {}),
        },
        enqueue: false,
      });
      if (created) {
        await boss.send(QUEUES.extract, { captureId: capture.id, userId });
        added++;
      }
    }

    // Refresh the profile facts too, not just the per-post metrics. `followers`
    // is read straight off connected_accounts.meta by the analytics page, and
    // before this it only ever changed on a full reconnect — so a user's
    // follower count sat frozen at its connect-day value indefinitely. Merge
    // rather than replace: meta also carries cadence stats written elsewhere.
    await query(
      `UPDATE connected_accounts
       SET meta = meta || $2::jsonb, last_refreshed_at = now()
       WHERE user_id = $1 AND platform = 'x'`,
      [userId, JSON.stringify(pull.meta ?? {})],
    );

    return { status: "ok", updated, added, skippedNew };
  } catch (err) {
    console.error(`engagement refresh failed for ${userId}`, err);
    return { status: "failed", updated: 0, added: 0 };
  }
}

// ── DB assembly ──────────────────────────────────────────────────────────────

/** Sum of like/reply/retweet/quote counts; null when the source carried no metrics. Shared with peer benchmarking. */
export function engagementTotal(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const parts = [e["likeCount"], e["replyCount"], e["retweetCount"], e["quoteCount"]].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/** Gather posts + unlock/cadence facts and run the pure analysis. */
export async function computePerformance(
  userId: string,
  plan: PlanView,
  periodStart: Date,
  refresh: RefreshResult,
): Promise<PerformanceData> {
  const throughlineVec = toVector(await embedOne(plan.throughline, userId));

  const rows = await query<{
    source: string;
    captured_at: string;
    raw_text: string | null;
    url: string | null;
    eng: unknown;
    dist: number | null;
    orientation: string | null;
    capture_id: string;
    rhetorical_mode: string | null;
    sincerity_register: string | null;
  }>(
    `SELECT c.id AS capture_id, c.source, c.captured_at::text, c.raw_text,
            c.metadata->>'url' AS url, c.metadata->'engagement' AS eng,
            c.rhetorical_mode, c.sincerity_register,
            (SELECT min(m.embedding <=> $2::vector) FROM memories m
             WHERE m.capture_id = c.id AND m.embedding IS NOT NULL) AS dist,
            (SELECT m.orientation FROM memories m
             WHERE m.capture_id = c.id AND m.orientation IS NOT NULL LIMIT 1) AS orientation
     FROM captures c
     WHERE c.user_id = $1 AND c.source IN ('x_import','linkedin_import')
       AND (c.metadata->>'published')::boolean IS TRUE`,
    [userId, throughlineVec],
  );

  // Unlock provenance: which capture's memory an unlock item actually became.
  const unlockByCapture = new Map<string, string>();
  const provenance = await query<{ idea: string; capture_id: string | null }>(
    `SELECT ui.idea, m.capture_id FROM unlock_items ui
     JOIN memories m ON m.id = ui.memory_id
     WHERE ui.user_id = $1 AND ui.memory_id IS NOT NULL`,
    [userId],
  );
  for (const p of provenance) if (p.capture_id) unlockByCapture.set(p.capture_id, p.idea);

  const posts: PerfPost[] = rows.map((r) => {
    const platform = r.source === "linkedin_import" ? ("linkedin" as const) : ("x" as const);
    return {
      platform,
      engagement: engagementTotal(r.eng),
      capturedAt: new Date(r.captured_at).getTime(),
      alignedDistance: r.dist,
      orientation: r.orientation,
      content: r.raw_text ?? "",
      url: r.url,
      unlockIdea: unlockByCapture.get(r.capture_id) ?? null,
      captureId: r.capture_id,
      rhetoricalMode: r.rhetorical_mode,
      sincerityRegister: r.sincerity_register,
    };
  });

  const analysis = analyzePosts(posts, periodStart.getTime(), Date.now());

  const anyEngagement = posts.some((p) => p.engagement !== null);
  let xConfidence: PerformanceData["xConfidence"];
  let xConfidenceReason: string;
  if (!anyEngagement) {
    xConfidence = "unavailable";
    xConfidenceReason = refresh.status === "skipped" ? "no engagement source configured or no X account connected" : "no posts carry engagement metrics";
  } else if (refresh.status !== "ok") {
    xConfidence = "partial";
    xConfidenceReason = refresh.status === "failed" ? "metrics refresh failed, numbers are from the last successful pull" : "metrics not refreshed this period";
  } else if (analysis.baseline.posts < MIN_BASELINE_POSTS) {
    xConfidence = "partial";
    xConfidenceReason = `baseline rests on only ${analysis.baseline.posts} posts`;
  } else {
    xConfidence = "full";
    xConfidenceReason = "";
  }

  const [unlockRow, draftsRow, liRow] = await Promise.all([
    queryOne<{ in_period: string; total: string; pending: string }>(
      `SELECT
         count(*) FILTER (WHERE status='developed' AND developed_at >= $2)::text AS in_period,
         count(*) FILTER (WHERE status='developed')::text AS total,
         count(*) FILTER (WHERE status='pending')::text AS pending
       FROM unlock_items WHERE user_id = $1 AND plan_id = $3`,
      [userId, periodStart, plan.id],
    ),
    queryOne<{ n: string }>(`SELECT count(*)::text n FROM drafts WHERE user_id = $1 AND created_at >= $2`, [
      userId,
      periodStart,
    ]),
    queryOne<{ n: string }>(
      `SELECT count(*)::text n FROM connected_accounts WHERE user_id = $1 AND platform = 'linkedin' AND status = 'ingested'`,
      [userId],
    ),
  ]);

  return {
    analysis,
    xConfidence,
    xConfidenceReason,
    linkedinConnected: Number(liRow?.n ?? 0) > 0,
    unlock: {
      developedInPeriod: Number(unlockRow?.in_period ?? 0),
      developedTotal: Number(unlockRow?.total ?? 0),
      pending: Number(unlockRow?.pending ?? 0),
    },
    committedPerWeek: plan.cadence?.perWeek ?? null,
    draftsInPeriod: Number(draftsRow?.n ?? 0),
  };
}

// ── Daily performance pulse ──────────────────────────────────────────────────

/** A fresh post beating this multiple of the user's own baseline is worth a same-day note. */
const PULSE_RATIO = 1.5;
const PULSE_LOOKBACK_DAYS = 3;

/**
 * Next-day feedback, not two-weeks-later feedback: a light engagement refresh,
 * then one message when a post published in the last few days is running well
 * above the user's own baseline. Shares the proactive budget (it's a nudge,
 * not a report), dedupes per capture, carries a repurpose button — acting on
 * a measured signal, exactly the outlier exception the repurposing spec allows.
 */
export async function handlePerformancePulse(): Promise<void> {
  if (!config.TWITTERAPI_IO_KEY) return;
  const users = await query<{ id: string; settings: UserSettings }>(
    `SELECT u.id, u.settings FROM users u
     JOIN brand_plans bp ON bp.user_id = u.id AND bp.status = 'active'
     JOIN connected_accounts ca ON ca.user_id = u.id AND ca.platform = 'x' AND ca.status = 'ingested'
     WHERE u.telegram_id IS NOT NULL`,
  );
  for (const user of users) {
    try {
      await pulseForUser(user.id, user.settings ?? {});
    } catch (err) {
      console.error(`performance pulse failed for ${user.id}`, err);
    }
  }
}

export async function pulseForUser(userId: string, settings: UserSettings): Promise<boolean> {
  // Refresh first (2 pages — recent posts only), then measure. Skip it when the
  // twice-daily sweep (jobs/x-refresh.ts, 01:00 & 13:00 UTC) already pulled this
  // account recently: the pulse runs at 04:45, so without this gate every
  // Telegram user with an active plan gets a second full pull 3h45m after the
  // first — paying twice for data that hasn't moved.
  const fresh = await queryOne<{ fresh: boolean }>(
    `SELECT (last_refreshed_at > now() - interval '6 hours') AS fresh
       FROM connected_accounts WHERE user_id = $1 AND platform = 'x'`,
    [userId],
  );
  if (!fresh?.fresh) await refreshXEngagement(userId, 40);

  const rows = await query<{ id: string; raw_text: string | null; captured_at: string; eng: unknown; url: string | null }>(
    `SELECT id, raw_text, captured_at::text, metadata->'engagement' AS eng, metadata->>'url' AS url
     FROM captures
     WHERE user_id = $1 AND source = 'x_import' AND (metadata->>'published')::boolean IS TRUE`,
    [userId],
  );
  const cutoff = Date.now() - PULSE_LOOKBACK_DAYS * 86_400_000;
  const withEng = rows
    .map((r) => ({ ...r, engagement: engagementTotal(r.eng), at: new Date(r.captured_at).getTime() }))
    .filter((r) => r.engagement !== null);
  const baseline = median(withEng.filter((r) => r.at < cutoff).map((r) => r.engagement!));
  if (baseline === null || baseline <= 0 || withEng.filter((r) => r.at < cutoff).length < 8) return false;

  const candidates = withEng
    .filter((r) => r.at >= cutoff && r.engagement! >= PULSE_RATIO * baseline)
    .sort((a, b) => b.engagement! - a.engagement!);
  if (candidates.length === 0) return false;

  // One per capture, ever — a post gets celebrated once, not daily while hot.
  let pick: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    const seen = await queryOne(
      `SELECT 1 FROM surfacings WHERE user_id = $1 AND type = 'performance_alert' AND payload->>'capture_id' = $2`,
      [userId, c.id],
    );
    if (!seen) {
      pick = c;
      break;
    }
  }
  if (!pick) return false;

  const cadence = await canDeliverProactive(userId, settings);
  if (!cadence.ok) return false; // still within lookback tomorrow — it'll get its moment

  const ratio = Math.round((pick.engagement! / baseline) * 10) / 10;
  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, '{}', 'performance_alert', $2, 'telegram') RETURNING id`,
    [userId, JSON.stringify({ capture_id: pick.id, engagement: pick.engagement, baseline, ratio })],
  );
  if (!surfacing) return false;

  const preview = (pick.raw_text ?? "").slice(0, 120);
  const kb = new InlineKeyboard().text("♻️ repurpose for LinkedIn", `rpz:c:${pick.id}:li`);
  return sendTelegram(
    userId,
    `Your post "${preview}${(pick.raw_text ?? "").length > 120 ? "…" : ""}" is running at ${ratio}x your baseline ` +
      `(${pick.engagement} vs your median ${baseline}). Worth giving it a second life while it's moving.`,
    surfacing.id,
    kb,
  );
}
