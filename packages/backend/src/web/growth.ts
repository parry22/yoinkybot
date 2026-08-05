/**
 * Growth - the gamified board that fuses the Diagnosis (who you are) and the
 * Plan (what to do next) into one surface built to actually move a user to post.
 *
 * Every number here is computed from REAL stored data (no invented XP): posts you
 * actually shipped, ideas you actually developed, agent drafts, a real weekly
 * posting streak, follower snapshot. The game layer just reframes that data with
 * the behavioural levers that make people come back:
 *   • Goal-gradient - an XP bar and a Brand Score you push toward the next notch.
 *   • Loss aversion - a weekly posting streak you don't want to break.
 *   • Zeigarnik / next-best-action - a short, ordered quest list; open loops nag.
 *   • Endowed progress + milestones - visible thresholds you're partway toward.
 */
import { query, queryOne } from "../db/pool.js";
import { currentDiagnosis, type Diagnosis } from "../strategist/diagnosis.js";
import { getPlan } from "../strategist/plan.js";
import { getProfile, isProfileComplete } from "../strategist/profile.js";

export interface GrowthQuest {
  id: string;
  title: string;
  detail: string;
  xp: number;
  done: boolean;
  kind: "setup" | "habit" | "idea" | "reach";
  cta?: { label: string; href: string };
}

export interface GrowthMilestone {
  key: string;
  label: string;
  icon: string;
  current: number;
  target: number;
  reached: boolean;
}

export interface ScorePart {
  key: string;
  label: string;
  value: number;
  max: number;
  hint: string;
}

export interface GrowthState {
  hasDiagnosis: boolean;
  hasPlan: boolean;
  connected: boolean;
  headline: string | null;
  throughline: string | null;
  diagnosisDate: string | null;
  identity: { ownedPositions: string[]; unsaid: string[] };

  level: number;
  levelTitle: string;
  nextTitle: string | null;
  xp: number;
  xpIntoLevel: number;
  xpForNextLevel: number | null;

  brandScore: number;
  scoreParts: ScorePart[];

  streak: { current: number; best: number; postedThisWeek: boolean };

  stats: {
    postsShipped: number;
    postsLast4w: number;
    ideasDeveloped: number;
    ideasPending: number;
    agentDrafts: number;
    yoinkShipped: number;
    followers: number | null;
    automations: number;
  };

  quests: GrowthQuest[];
  milestones: GrowthMilestone[];
}

// Level ladder. XP is earned only from things that actually happened (below).
const LEVELS: { level: number; min: number; title: string }[] = [
  { level: 1, min: 0, title: "Ghost" },
  { level: 2, min: 120, title: "Poster" },
  { level: 3, min: 350, title: "Regular" },
  { level: 4, min: 700, title: "Voice" },
  { level: 5, min: 1200, title: "Signal" },
  { level: 6, min: 1900, title: "Authority" },
  { level: 7, min: 2900, title: "Landmark" },
];

function clampWeeks(iso: string): number | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / (7 * 24 * 60 * 60 * 1000));
}

/** current + best run of consecutive weeks with ≥1 post; this-week gap is grace, not a break. */
function streakFromWeeks(active: boolean[]): { current: number; best: number; postedThisWeek: boolean } {
  const postedThisWeek = active[0] === true;
  // Grace: if you haven't posted THIS week yet but did last week, the streak is
  // still alive (at risk) - we count from last week so the number doesn't scare-drop to 0.
  let i = active[0] ? 0 : 1;
  let current = 0;
  while (active[i]) {
    current++;
    i++;
  }
  let best = 0;
  let run = 0;
  for (const a of active) {
    if (a) {
      run++;
      best = Math.max(best, run);
    } else run = 0;
  }
  return { current, best, postedThisWeek };
}

function bar(part: number, whole: number, max: number): number {
  if (whole <= 0) return 0;
  return Math.round(Math.min(1, part / whole) * max);
}

export async function getGrowthState(userId: string): Promise<GrowthState> {
  const [diag, plan, profile, acct, counts, weeksRows] = await Promise.all([
    currentDiagnosis(userId).catch(() => null),
    getPlan(userId).catch(() => null),
    getProfile(userId).catch(() => null),
    queryOne<{ handle: string; meta: Record<string, unknown> | null }>(
      `SELECT handle, meta FROM connected_accounts WHERE user_id = $1 AND platform = 'x' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ).catch(() => null),
    queryOne<{
      posts_shipped: string;
      posts_4w: string;
      ideas_developed: string;
      ideas_pending: string;
      agent_drafts: string;
      yoink_shipped: string;
      automations: string;
    }>(
      `SELECT
         (SELECT count(*) FROM captures WHERE user_id = $1 AND source = 'x_import')::text AS posts_shipped,
         (SELECT count(*) FROM captures WHERE user_id = $1 AND source = 'x_import' AND captured_at >= now() - interval '28 days')::text AS posts_4w,
         (SELECT count(*) FROM unlock_items WHERE user_id = $1 AND status = 'developed')::text AS ideas_developed,
         (SELECT count(*) FROM unlock_items ui JOIN brand_plans bp ON bp.id = ui.plan_id AND bp.status = 'active'
            WHERE ui.user_id = $1 AND ui.status = 'pending')::text AS ideas_pending,
         (SELECT count(*) FROM automation_runs WHERE user_id = $1 AND draft_body IS NOT NULL)::text AS agent_drafts,
         (SELECT count(*) FROM scheduled_posts WHERE user_id = $1 AND status = 'published')::text AS yoink_shipped,
         (SELECT count(*) FROM automations WHERE user_id = $1)::text AS automations`,
      [userId],
    ).catch(() => null),
    query<{ captured_at: string }>(
      `SELECT captured_at::text FROM captures WHERE user_id = $1 AND source = 'x_import' ORDER BY captured_at DESC LIMIT 600`,
      [userId],
    ).catch(() => []),
  ]);

  const connected = !!acct;
  const followers = typeof acct?.meta?.followers === "number" ? (acct!.meta!.followers as number) : null;
  const profileComplete = isProfileComplete(profile);
  const hasDiagnosis = !!diag;
  const hasPlan = !!plan;

  const postsShipped = Number(counts?.posts_shipped ?? 0);
  const postsLast4w = Number(counts?.posts_4w ?? 0);
  const ideasDeveloped = Number(counts?.ideas_developed ?? 0);
  const ideasPending = Number(counts?.ideas_pending ?? 0);
  const agentDrafts = Number(counts?.agent_drafts ?? 0);
  const yoinkShipped = Number(counts?.yoink_shipped ?? 0);
  const automations = Number(counts?.automations ?? 0);

  // Weekly posting streak (last 26 weeks window).
  const WINDOW = 26;
  const active = Array.from({ length: WINDOW }, () => false);
  for (const r of weeksRows) {
    const w = clampWeeks(r.captured_at);
    if (w !== null && w >= 0 && w < WINDOW) active[w] = true;
  }
  const streak = streakFromWeeks(active);

  // XP - only from things that actually happened.
  const xp =
    (connected ? 50 : 0) +
    (profileComplete ? 50 : 0) +
    (hasDiagnosis ? 100 : 0) +
    ideasDeveloped * 40 +
    agentDrafts * 15 +
    postsShipped * 4 +
    streak.best * 25;

  const curr = [...LEVELS].reverse().find((l) => xp >= l.min) ?? LEVELS[0]!;
  const next = LEVELS.find((l) => l.min > curr.min) ?? null;
  const xpIntoLevel = xp - curr.min;
  const xpForNextLevel = next ? next.min - curr.min : null;

  // Brand Score (0-100): four 25-pt pillars, all from measurable signal.
  const foundation = (connected ? 10 : 0) + (profileComplete ? 8 : 0) + (hasDiagnosis ? 7 : 0);
  const consistency = bar(streak.current, 5, 25); // a 5-week streak = full marks
  const depth = bar(ideasDeveloped, 5, 25); // developing your backlog
  const momentum = bar(postsLast4w, 8, 25); // ~2 posts/week over the last month
  const scoreParts: ScorePart[] = [
    { key: "foundation", label: "Foundation", value: foundation, max: 25, hint: "Connect, profile, diagnosis" },
    { key: "consistency", label: "Consistency", value: consistency, max: 25, hint: "Your weekly posting streak" },
    { key: "depth", label: "Depth", value: depth, max: 25, hint: "Backlog ideas you've developed" },
    { key: "momentum", label: "Momentum", value: momentum, max: 25, hint: "Posts in the last 4 weeks" },
  ];
  const brandScore = scoreParts.reduce((a, p) => a + p.value, 0);

  // Quests - ordered next-best-actions. Setup first (gates the board), then the
  // habit loop, then concrete ideas from the plan backlog.
  const quests: GrowthQuest[] = [];
  quests.push({
    id: "connect",
    title: "Connect your X account",
    detail: "Yoinky reads your posts to learn your voice and everything downstream.",
    xp: 50,
    done: connected,
    kind: "setup",
    cta: connected ? undefined : { label: "Connect", href: "/app/settings" },
  });
  quests.push({
    id: "profile",
    title: "Complete your brand profile",
    detail: "Niche, angle, and goals - the spine every draft reasons against.",
    xp: 50,
    done: profileComplete,
    kind: "setup",
    cta: profileComplete ? undefined : { label: "Finish setup", href: "/app/onboarding" },
  });
  quests.push({
    id: "diagnosis",
    title: "Get your brand diagnosis",
    detail: "The 5-dimension read of what you say vs what you ship.",
    xp: 100,
    done: hasDiagnosis,
    kind: "setup",
    cta: hasDiagnosis ? undefined : { label: "Start", href: "/app/onboarding" },
  });
  quests.push({
    id: "post-week",
    title: streak.postedThisWeek ? "Posted this week - streak safe" : "Post something this week",
    detail: streak.postedThisWeek
      ? "Nice. Keep the streak alive next week too."
      : "Don't break your streak - one post keeps the chain going.",
    xp: 30,
    done: streak.postedThisWeek,
    kind: "habit",
    cta: streak.postedThisWeek ? undefined : { label: "Compose", href: "/app/compose" },
  });
  quests.push({
    id: "first-agent",
    title: "Set up an Auto Agent",
    detail: "Describe an agent once and Yoinky drafts for you on your cadence.",
    xp: 60,
    done: automations > 0,
    kind: "setup",
    cta: automations > 0 ? undefined : { label: "New agent", href: "/app/automations" },
  });
  quests.push({
    id: "ship-yoink",
    title: "Ship a post through Yoinky",
    detail: "Approve an agent draft or schedule from Compose - then track its lift in Analytics.",
    xp: 40,
    done: yoinkShipped > 0,
    kind: "reach",
    cta: yoinkShipped > 0 ? undefined : { label: "Schedule", href: "/app/compose" },
  });

  // Concrete idea-quests from the top pending backlog unlocks.
  if (plan) {
    const pending = plan.unlock
      .filter((u) => u.status === "pending")
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 3);
    for (const u of pending) {
      quests.push({
        id: `idea-${u.id}`,
        title: `Develop: ${u.idea}`,
        detail: u.rationale || "A high-leverage idea from your plan waiting to become a post.",
        xp: 40,
        done: false,
        kind: "idea",
        cta: { label: "Write it", href: "/app/compose" },
      });
    }
  }

  // Milestones - visible thresholds with the nearest target auto-selected per track.
  const pick = (current: number, targets: number[]) =>
    targets.find((t) => current < t) ?? targets[targets.length - 1]!;
  const milestones: GrowthMilestone[] = [
    { key: "followers", label: "Followers", icon: "👥", current: followers ?? 0, target: pick(followers ?? 0, [100, 500, 1000, 5000, 10000, 50000]), reached: false },
    { key: "posts", label: "Posts shipped", icon: "✍️", current: postsShipped, target: pick(postsShipped, [10, 50, 100, 250, 500, 1000]), reached: false },
    { key: "streak", label: "Week streak", icon: "🔥", current: streak.current, target: pick(streak.current, [2, 4, 8, 12, 26, 52]), reached: false },
    { key: "ideas", label: "Ideas developed", icon: "💡", current: ideasDeveloped, target: pick(ideasDeveloped, [1, 5, 10, 25, 50]), reached: false },
  ].map((m) => ({ ...m, reached: m.current >= m.target }));

  const d: Diagnosis | null = diag?.dimensions ?? null;

  return {
    hasDiagnosis,
    hasPlan,
    connected,
    headline: d?.headline ?? null,
    throughline: plan?.throughline ?? null,
    diagnosisDate: diag?.created_at ?? null,
    identity: {
      ownedPositions: d?.intellectual_fingerprint.owned_positions.slice(0, 3) ?? [],
      unsaid: d?.unsaid_patterns.map((u) => u.idea).slice(0, 3) ?? [],
    },
    level: curr.level,
    levelTitle: curr.title,
    nextTitle: next?.title ?? null,
    xp,
    xpIntoLevel,
    xpForNextLevel,
    brandScore,
    scoreParts,
    streak,
    stats: {
      postsShipped,
      postsLast4w,
      ideasDeveloped,
      ideasPending,
      agentDrafts,
      yoinkShipped,
      followers,
      automations,
    },
    quests,
    milestones,
  };
}
