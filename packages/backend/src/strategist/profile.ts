/**
 * The stated brand profile (onboarding Stages 1-6): what the user tells us
 * before we read their public history. Persisted one row per user in
 * brand_profiles, filled in turn-by-turn during the paced intake, and referenced
 * by every downstream feature (drafting, consistency, gap analysis, plan).
 *
 * Deliberately lean (2026-07-11 trim): the intake asks 7 fields, not the original
 * 21 — the deeper positioning/audience/constraints/platform fields
 * (sub_niche_angle, credibility_source, unique_pov, secondary_goals,
 * audience_sophistication, audience_pain_point, formality_gradient,
 * vulnerability_threshold, visual_comfort, primary_platform,
 * platform_adaptation, posting_capacity, and all of the old Stage 7
 * constraints trio) were cut for a faster, less form-like onboarding.
 * Their columns stay in the DB (additive-only schema) and are still read by
 * downstream code (gap.ts, plan.ts, draft.ts) — those code paths are null-aware
 * and degrade gracefully when a field was never asked; nothing crashes on the
 * removal, those specific findings just never fire for new users.
 *
 * This module owns the field taxonomy (the ordered PROFILE_FIELDS the intake
 * walks, the tone menu, the goal options) and the DB access. It deliberately
 * does NOT import state.ts / setStage — the session orchestrator owns stage
 * transitions — so there is no import cycle.
 */
import { query, queryOne } from "../db/pool.js";

/** The fields the Stage 1-6 intake elicits, in ask order. Names are the exact
 *  brand_profiles columns, so persistence is a 1:1 column write. */
export const PROFILE_FIELDS = [
  // Stage 1: Positioning
  "niche",
  // Stage 2: Goal
  "primary_goal",
  // Stage 3: Audience
  "audience_who",
  // Stage 4: Voice and tone
  "inspiration_creators",
  "tone_selections",
  // Stage 5: Content pillars (derived, then confirmed)
  "content_pillars",
  // Stage 6: Format
  "camera_comfort",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

const ARRAY_FIELDS = new Set<ProfileField>(["inspiration_creators", "tone_selections", "content_pillars"]);

/** Which stage a field belongs to — used to group the intake and by nudges. */
export const FIELD_STAGE: Record<ProfileField, number> = {
  niche: 1,
  primary_goal: 2,
  audience_who: 3,
  inspiration_creators: 4, tone_selections: 4,
  content_pillars: 5,
  camera_comfort: 6,
};

/** Stage 2 goal options — a single primary pick, no secondary-goals follow-up. */
export const GOAL_OPTIONS = [
  { key: "job", label: "Land a job or recruiter attention" },
  { key: "leads", label: "Generate leads or clients" },
  { key: "authority", label: "Build authority (speaking, consulting, advising)" },
  { key: "product", label: "Sell a specific product (course, SaaS, book, service)" },
  { key: "funding", label: "Raise funding, attract investors or co-founders" },
  { key: "audience", label: "Build a pure audience or media business" },
  { key: "community", label: "Networking and community, no monetization right now" },
] as const;

/** Stage 4 tone taxonomy: stable keys grouped into five clusters. tone_selections
 *  stores the keys; gap.ts maps them to measured voice; the tone menu renders labels. */
export const TONE_TAXONOMY = [
  {
    cluster: "Authority / Expertise",
    items: [
      { key: "authority.analytical", label: "Analytical breakdowns" },
      { key: "authority.data", label: "Data-driven takes" },
      { key: "authority.teardown", label: "Case study teardowns" },
      { key: "authority.contrarian", label: "Contrarian / hot takes" },
      { key: "authority.forecast", label: "Predictions and forecasting" },
    ],
  },
  {
    cluster: "Relatability / Trust",
    items: [
      { key: "trust.buildinpublic", label: "Build in public" },
      { key: "trust.confessional", label: "Confessional / vulnerability" },
      { key: "trust.narrative", label: "Personal narrative" },
      { key: "trust.bts", label: "Day-in-the-life / behind the scenes" },
    ],
  },
  {
    cluster: "Entertainment / Reach",
    items: [
      { key: "reach.shitpost", label: "Shitposting" },
      { key: "reach.meme", label: "Meme commentary" },
      { key: "reach.trendjack", label: "Trend-jacking" },
      { key: "reach.replyguy", label: "Reply-guy / community banter" },
    ],
  },
  {
    cluster: "Education / Utility",
    items: [
      { key: "education.howto", label: "How-to / tactical threads" },
      { key: "education.frameworks", label: "Listicles / frameworks" },
      { key: "education.explainer", label: "Explainers" },
      { key: "education.roundup", label: "Curated roundups" },
    ],
  },
  {
    cluster: "Persuasion / Thought Leadership",
    items: [
      { key: "persuasion.manifesto", label: "Manifesto / opinion pieces" },
      { key: "persuasion.debate", label: "Debate-bait / Socratic questions" },
      { key: "persuasion.vision", label: "Aspirational / vision posts" },
    ],
  },
] as const;

export const TONE_LABEL: Record<string, string> = Object.fromEntries(
  TONE_TAXONOMY.flatMap((c) => c.items.map((i) => [i.key, i.label])),
);
export const TONE_CLUSTER: Record<string, string> = Object.fromEntries(
  TONE_TAXONOMY.flatMap((c) => c.items.map((i) => [i.key, c.cluster])),
);
export const ALL_TONE_KEYS: string[] = TONE_TAXONOMY.flatMap((c) => c.items.map((i) => i.key));

export interface BrandProfile {
  id: string;
  user_id: string;
  version: number;
  niche: string | null;
  sub_niche_angle: string | null;
  credibility_source: string | null;
  unique_pov: string | null;
  primary_goal: string | null;
  secondary_goals: string[];
  audience_who: string | null;
  audience_sophistication: string | null;
  audience_pain_point: string | null;
  inspiration_creators: string[];
  tone_selections: string[];
  formality_gradient: string | null;
  vulnerability_threshold: string | null;
  content_pillars: string[];
  content_pillars_confirmed: boolean;
  camera_comfort: string | null;
  visual_comfort: string | null;
  primary_platform: string | null;
  platform_adaptation: string | null;
  posting_capacity: number | null;
  employer_restrictions: string | null;
  topics_off_limits: string[];
  anonymity_needs: string | null;
  unresolved: string[];
  profile_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function getProfile(userId: string): Promise<BrandProfile | null> {
  return (
    (await queryOne<BrandProfile>(`SELECT * FROM brand_profiles WHERE user_id = $1`, [userId])) ?? null
  );
}

/** Idempotently create the empty row the moment intake starts. */
export async function ensureProfile(userId: string): Promise<void> {
  await query(
    `INSERT INTO brand_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

/**
 * Array fields sometimes arrive as a real JSON array, but the model
 * occasionally emits the whole array double-encoded as one string instead
 * (e.g. value: "[\"naval\",\"dan koe\"]" instead of value: ["naval","dan koe"]) —
 * without this, that string got wrapped as a single-item array containing the
 * literal JSON text. Try a real JSON array first, then a comma-split fallback,
 * before ever treating the string as one opaque item.
 */
export function normalizeArray(value: string | string[]): string[] {
  if (Array.isArray(value)) return value;
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch {
      // not actually JSON — fall through to comma-split
    }
  }
  if (!trimmed) return [];
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
}

function normalize(field: ProfileField, value: string | string[]): string | string[] | null {
  if (ARRAY_FIELDS.has(field)) return normalizeArray(value);
  const scalar = Array.isArray(value) ? value[0] : value;
  return scalar ?? null;
}

/**
 * Write one captured field. Idempotent (safe on turn retry). When `unresolved`
 * is set, the field is also recorded in the unresolved[] ledger so downstream
 * copy can say "you weren't sure about X" rather than fabricating it. The column
 * name is whitelisted against PROFILE_FIELDS, never interpolated from free input.
 */
export async function upsertProfileField(
  userId: string,
  field: ProfileField,
  value: string | string[],
  opts: { unresolved?: boolean } = {},
): Promise<void> {
  if (!PROFILE_FIELDS.includes(field)) throw new Error(`unknown profile field: ${field}`);
  await ensureProfile(userId);
  const normalized = normalize(field, value);
  const unresolvedSql = opts.unresolved
    ? `, unresolved = (SELECT array_agg(DISTINCT e) FROM unnest(array_append(unresolved, $3)) e)`
    : "";
  const params: unknown[] = [userId, normalized];
  if (opts.unresolved) params.push(field);
  await query(
    `UPDATE brand_profiles SET ${field} = $2, updated_at = now()${unresolvedSql} WHERE user_id = $1`,
    params,
  );
}

/** Mark the derived content pillars confirmed by the user. */
export async function confirmPillars(userId: string, pillars: string[]): Promise<void> {
  await ensureProfile(userId);
  await query(
    `UPDATE brand_profiles SET content_pillars = $2, content_pillars_confirmed = true, updated_at = now() WHERE user_id = $1`,
    [userId, pillars],
  );
}

/** Close out the intake (Stage 6 done). Idempotent. */
export async function finalizeProfile(userId: string): Promise<void> {
  await ensureProfile(userId);
  await query(
    `UPDATE brand_profiles SET profile_completed_at = COALESCE(profile_completed_at, now()), updated_at = now() WHERE user_id = $1`,
    [userId],
  );
}

/** True once the Stage 1-6 intake has been finalized. */
export function isProfileComplete(p: BrandProfile | null): boolean {
  return !!p?.profile_completed_at;
}

/**
 * Compact, NULL-aware profile summary for prompts. Never fabricates: an unknown
 * field is simply omitted. Used by the gap analysis, plan, drafting, consistency,
 * and steady-state converse so every feature reasons against the STATED profile.
 */
export function profileSummaryForPrompt(p: BrandProfile | null): string {
  if (!p) return "(no stated profile yet)";
  const lines: string[] = [];
  const add = (label: string, v: string | null | undefined) => {
    if (v && v.trim()) lines.push(`${label}: ${v.trim()}`);
  };
  const addList = (label: string, v: string[] | undefined, map?: (s: string) => string) => {
    if (v && v.length) lines.push(`${label}: ${v.map((x) => (map ? map(x) : x)).join(", ")}`);
  };
  add("Niche", p.niche);
  add("Angle", p.sub_niche_angle);
  add("Credibility", p.credibility_source);
  add("Unique POV", p.unique_pov);
  add("Primary goal", p.primary_goal ? goalLabel(p.primary_goal) : null);
  addList("Secondary goals", p.secondary_goals, goalLabel);
  add("Audience", p.audience_who);
  add("Audience level", p.audience_sophistication);
  add("Audience pain point", p.audience_pain_point);
  addList("Admires", p.inspiration_creators);
  addList("Tone", p.tone_selections, (k) => TONE_LABEL[k] ?? k);
  add("Formality", p.formality_gradient);
  add("Vulnerability", p.vulnerability_threshold);
  addList("Content pillars", p.content_pillars);
  add("Camera", p.camera_comfort);
  add("Visuals", p.visual_comfort);
  add("Primary platform", p.primary_platform);
  add("Platform strategy", p.platform_adaptation);
  if (p.posting_capacity) lines.push(`Capacity: ${p.posting_capacity} posts/week`);
  add("Employer limits", p.employer_restrictions);
  addList("Off-limits topics", p.topics_off_limits);
  add("Anonymity", p.anonymity_needs);
  if (p.unresolved.length) lines.push(`Left unresolved: ${p.unresolved.join(", ")}`);
  return lines.length ? lines.join("\n") : "(profile started, nothing captured yet)";
}

function goalLabel(key: string): string {
  return GOAL_OPTIONS.find((g) => g.key === key)?.label ?? key;
}
