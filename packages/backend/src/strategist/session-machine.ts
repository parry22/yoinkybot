import { z } from "zod";
import { InlineKeyboard } from "grammy";
import { llmCall, extractJson } from "../llm/gateway.js";
import { strategistSession } from "../prompts/strategist-session.v1.js";
import { strategistProfiling, fieldSpec, FALLBACK_QUESTION } from "../prompts/strategist-session.v2.js";
import { diagnosisReveal } from "../prompts/diagnosis-reveal.v1.js";
import { gapAnalysis } from "../prompts/gap-analysis.v1.js";
import { computeGap } from "./gap.js";
import { reactionSignal as reactionSignalPrompt } from "../prompts/reaction-signal.v1.js";
import { hybridSearch } from "../memory/search.js";
import { query, queryOne } from "../db/pool.js";
import { sendTelegramSequence } from "../telegram/bot.js";
import { saveTurn } from "../telegram/conversation.js";
import { casualize } from "../prompts/style.js";
import { currentDiagnosis, diagnosisById, type Diagnosis } from "./diagnosis.js";
import { submitGoal, GOAL_TYPES } from "./goals.js";
import { generatePlanDraft, generateThreeMonthPlan, confirmPlan, setPlanCadence, getPlan } from "./plan.js";
import { otherUnconnectedPlatform } from "./connect.js";
import {
  PROFILE_FIELDS,
  upsertProfileField,
  confirmPillars,
  finalizeProfile,
  profileSummaryForPrompt,
  getProfile,
  type ProfileField,
  type BrandProfile,
} from "./profile.js";
import {
  DIAGNOSIS_BEATS,
  PLAN_BEATS,
  getState,
  setState,
  setStage,
  type DiagnosisBeat,
  type PlanBeat,
  type ProfileCursor,
  type SessionPhase,
  type StrategistState,
} from "./state.js";

type ReactionSignal = "closing" | "continuation";

// How many turns in a phase before the watchdog tells the LLM to land it.
const WATCHDOG: Record<SessionPhase, number> = {
  profiling: 60, // runaway backstop only; per-field pacing is push-once in the prompt
  connect_transition: 4,
  gap_analysis: 8,
  opening: 99,
  diagnosis_dialogue: 8,
  goals: 7,
  plan_build: 4,
  active: 99,
};

// ── Action contract ──────────────────────────────────────────────────────────

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("beat_covered"), beat: z.enum(DIAGNOSIS_BEATS) }),
  z.object({ type: z.literal("plan_beat_covered"), beat: z.enum(PLAN_BEATS) }),
  z.object({ type: z.literal("advance_phase") }),
  z.object({
    type: z.literal("goal_field"),
    field: z.enum(["optimizing_for", "timeframe", "success", "goal_type"]),
    value: z.string(),
  }),
  z.object({ type: z.literal("goal_captured") }),
  z.object({ type: z.literal("cadence"), perWeek: z.number().optional(), note: z.string().optional() }),
  z.object({ type: z.literal("commit_plan") }),
  z.object({ type: z.literal("capture") }),
  z.object({ type: z.literal("offer_angles") }),
]);
export type Action = z.infer<typeof actionSchema>;

export interface Effect {
  kind: "captureGoal" | "setCadence" | "confirmPlan";
  goal?: { goalType: string; detail: string; timeframe?: string; success?: string };
  perWeek?: number;
  note?: string;
}

export interface ReduceResult {
  nextState: StrategistState;
  effects: Effect[];
  capture: boolean;
  offerAngles: boolean;
}

/** Parse the LLM envelope, dropping malformed/unknown actions rather than failing. */
export function parseSessionResponse(raw: unknown): { reply: string; actions: Action[] } {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const reply = typeof obj.reply === "string" && obj.reply.trim() ? obj.reply.trim() : "";
  const actions: Action[] = [];
  if (Array.isArray(obj.actions)) {
    for (const a of obj.actions) {
      const parsed = actionSchema.safeParse(a);
      if (parsed.success) actions.push(parsed.data);
    }
  }
  return { reply, actions };
}

// ── Pure guards ──────────────────────────────────────────────────────────────

export function gapBeatsCovered(covered: DiagnosisBeat[]): number {
  return covered.filter((b) => b !== "whats_working").length;
}

/** unsaid_patterns is the trust-gated finale — only after working + 2 gaps. */
export function unsaidUnlocked(covered: DiagnosisBeat[]): boolean {
  return covered.includes("whats_working") && gapBeatsCovered(covered) >= 2;
}

export function canAdvanceDiagnosis(covered: DiagnosisBeat[]): boolean {
  return covered.includes("whats_working") && gapBeatsCovered(covered) >= 2;
}

export function goalDraftComplete(draft: StrategistState["goalDraft"]): boolean {
  return !!(draft?.optimizing_for && draft?.timeframe && draft?.success);
}

export function remainingBeats(covered: DiagnosisBeat[]): DiagnosisBeat[] {
  const seen = new Set(covered);
  return DIAGNOSIS_BEATS.filter((b) => !seen.has(b));
}

export function remainingPlanBeats(covered: PlanBeat[]): PlanBeat[] {
  const seen = new Set(covered);
  return PLAN_BEATS.filter((b) => !seen.has(b));
}

/** Keyword-classify a drawn-out goal into one of the GOAL_TYPES keys. */
export function classifyGoalType(draft: StrategistState["goalDraft"]): string {
  const text = `${draft?.optimizing_for ?? ""} ${draft?.success ?? ""}`.toLowerCase();
  if (/\bauthorit|known for|thought leader|the voice|respected|credib/.test(text)) return "authority";
  if (/\baudience|follower|subscriber|reach|grow|\d+\s*(k|followers)/.test(text)) return "audience";
  if (/\bcompany|product|startup|launch|customer|inbound|sales|revenue|users?\b/.test(text)) return "company";
  if (/\braise|fundrais|invest|hir|recruit|partner|speaking|job|opportunit/.test(text)) return "opportunity";
  return draft?.goal_type && GOAL_TYPES[draft.goal_type] ? draft.goal_type : "other";
}

// ── Pure reducer ─────────────────────────────────────────────────────────────

/**
 * Decide the next state + the DB effects to perform, from the current state and
 * the LLM's actions. Pure and I/O-free (fully unit-testable); runSessionTurn
 * performs the returned effects. Actions are applied in a fixed order so a turn
 * that both answers and advances is deterministic.
 *
 * `reaction` is the classifier's read of the user's latest reply, used ONLY to
 * gate leaving diagnosis_dialogue once every beat has been revealed — real
 * pushback keeps the conversation open instead of getting steamrolled by a
 * fixed one-turn advance. Undefined behaves like "closing" (fail-open): a
 * classifier outage should never trap someone in the dialogue phase forever.
 */
export function applyActions(state: StrategistState, actions: Action[], reaction?: ReactionSignal): ReduceResult {
  const phase = state.phase ?? "diagnosis_dialogue";
  const covered = [...(state.covered ?? [])];
  const planCovered = [...(state.planCovered ?? [])];
  const goalDraft = { ...(state.goalDraft ?? {}) };
  const turns = state.turnsInPhase ?? 0;
  const effects: Effect[] = [];
  let nextPhase = phase;
  let cadenceSet = state.cadenceSet ?? false;
  let capture = false;
  let offerAngles = false;

  const has = (t: Action["type"]) => actions.some((a) => a.type === t);

  // 1. beat_covered — dedup + enforce the trust gate even if revealed early.
  for (const a of actions) {
    if (a.type === "beat_covered" && !covered.includes(a.beat)) {
      if (a.beat === "unsaid_patterns" && !unsaidUnlocked(covered)) continue;
      covered.push(a.beat);
    }
  }

  // 1b. plan_beat_covered — same dedup pattern, paces the plan presentation.
  for (const a of actions) {
    if (a.type === "plan_beat_covered" && !planCovered.includes(a.beat)) planCovered.push(a.beat);
  }

  // 2. goal_field — accumulate the draft.
  for (const a of actions) {
    if (a.type === "goal_field") goalDraft[a.field] = a.value;
  }

  // 3. cadence — record on the draft plan (needs a plan).
  for (const a of actions) {
    if (a.type === "cadence" && state.planId) {
      effects.push({ kind: "setCadence", perWeek: a.perWeek, note: a.note });
      cadenceSet = true;
    }
  }

  // 4. content flags (same semantics as converse.v1).
  if (has("capture")) capture = true;
  if (has("offer_angles")) offerAngles = true;

  // ── Forward progress is DETERMINISTIC, not LLM-dependent ──────────────────
  // The model reliably paces well but under-emits advance signals and can loop
  // forever. So the machine advances on its own once the phase's work is done.

  if (phase === "gap_analysis") {
    // The gap analysis is delivered all-up-front (like the cold reveal), then we
    // sit and talk. Leave for the three-month plan on a genuine closing signal
    // (real pushback keeps the conversation open); watchdog is the backstop.
    if (reaction !== "continuation" || turns >= WATCHDOG.gap_analysis) {
      nextPhase = "plan_build";
    }
  } else if (phase === "diagnosis_dialogue") {
    const allRevealed = remainingBeats(covered).length === 0;
    const gateMet = canAdvanceDiagnosis(covered);
    if (allRevealed) {
      // Everything's been shown — this is the "pause" beat. Only actually leave
      // on a genuine closing signal; real pushback gets a real conversation
      // instead of being treated the same as "yeah, fair". The watchdog is
      // still the backstop so an endless back-and-forth eventually resolves.
      if (reaction !== "continuation" || turns >= WATCHDOG.diagnosis_dialogue) {
        nextPhase = "goals";
      }
    } else if ((has("advance_phase") && gateMet) || (gateMet && turns >= WATCHDOG.diagnosis_dialogue)) {
      nextPhase = "goals";
    }
  } else if (phase === "goals") {
    // Capture the moment the draft is complete — don't wait on the model's flag.
    if (goalDraftComplete(goalDraft)) {
      effects.push({
        kind: "captureGoal",
        goal: {
          goalType: classifyGoalType(goalDraft),
          detail: goalDraft.optimizing_for!,
          timeframe: goalDraft.timeframe,
          success: goalDraft.success,
        },
      });
      nextPhase = "plan_build";
    }
  } else if (phase === "plan_build") {
    // Commit on the model's signal, or once cadence is set and the user has had
    // at least one turn with the plan in front of them, so a ready plan is never
    // left stranded waiting on an advance signal the model under-emits.
    if (state.planId && (has("commit_plan") || (cadenceSet && turns >= 1))) {
      effects.push({ kind: "confirmPlan" });
      nextPhase = "active";
    }
  }

  const phaseChanged = nextPhase !== phase;
  const nextState: StrategistState = {
    ...state,
    phase: nextPhase,
    covered,
    planCovered,
    goalDraft,
    cadenceSet,
    turnsInPhase: phaseChanged ? 0 : turns + 1,
  };
  return { nextState, effects, capture, offerAngles };
}

// ── Profiling reducer (Stage 1-7 intake) ─────────────────────────────────────

const profileActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("profile_field"),
    field: z.enum(PROFILE_FIELDS),
    value: z.union([z.string(), z.array(z.string())]),
    unresolved: z.boolean().optional(),
  }),
  z.object({ type: z.literal("push_field"), field: z.enum(PROFILE_FIELDS) }),
  z.object({ type: z.literal("capture") }),
  z.object({ type: z.literal("offer_angles") }),
]);
export type ProfileAction = z.infer<typeof profileActionSchema>;

export interface ProfileEffect {
  kind: "persistField" | "confirmPillars" | "finalizeProfile";
  field?: ProfileField;
  value?: string | string[];
  unresolved?: boolean;
  pillars?: string[];
}

export interface ProfileReduceResult {
  nextState: StrategistState;
  effects: ProfileEffect[];
  capture: boolean;
  offerAngles: boolean;
}

export function parseProfileResponse(raw: unknown): { reply: string; actions: ProfileAction[] } {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const reply = typeof obj.reply === "string" && obj.reply.trim() ? obj.reply.trim() : "";
  const actions: ProfileAction[] = [];
  if (Array.isArray(obj.actions)) {
    for (const a of obj.actions) {
      const parsed = profileActionSchema.safeParse(a);
      if (parsed.success) actions.push(parsed.data);
    }
  }
  return { reply, actions };
}

/** The next field the intake still needs, in ask order. Undefined = all done. */
export function nextProfileField(cursor: ProfileCursor | undefined): ProfileField | undefined {
  const captured = new Set(cursor?.captured ?? []);
  return PROFILE_FIELDS.find((f) => !captured.has(f));
}

/**
 * Pure reducer for the Stage 1-7 intake. Deterministic forward progress: a field
 * captured (answered OR explicitly marked unresolved) is never asked again, so
 * the intake always advances regardless of what the model emits. When every
 * field is captured it finalizes the profile and moves to connect_transition.
 */
export function applyProfileActions(
  state: StrategistState,
  actions: ProfileAction[],
): ProfileReduceResult {
  const cursor: Required<ProfileCursor> = {
    captured: [...(state.profile?.captured ?? [])],
    pushed: [...(state.profile?.pushed ?? [])],
    unresolved: [...(state.profile?.unresolved ?? [])],
    pillarsDrafted: [...(state.profile?.pillarsDrafted ?? [])],
    stuck: state.profile?.stuck ?? 0,
  };
  const turns = state.turnsInPhase ?? 0;
  const effects: ProfileEffect[] = [];
  let capture = false;
  let offerAngles = false;

  for (const a of actions) {
    if (a.type === "capture") capture = true;
    else if (a.type === "offer_angles") offerAngles = true;
    else if (a.type === "push_field") {
      if (!cursor.pushed.includes(a.field)) cursor.pushed.push(a.field);
    } else if (a.type === "profile_field") {
      // content_pillars carries its own effect so the confirmed flag is set too.
      if (a.field === "content_pillars") {
        const pillars = Array.isArray(a.value) ? a.value : [a.value];
        effects.push({ kind: "confirmPillars", pillars });
      } else {
        effects.push({ kind: "persistField", field: a.field, value: a.value, unresolved: a.unresolved });
      }
      if (!cursor.captured.includes(a.field)) cursor.captured.push(a.field);
      if (a.unresolved && !cursor.unresolved.includes(a.field)) cursor.unresolved.push(a.field);
    }
  }

  // Runaway backstop: if the intake has dragged far past its field count, force
  // the current field unresolved and move on rather than looping forever.
  if (turns >= WATCHDOG.profiling) {
    const stuck = nextProfileField(cursor);
    if (stuck && !cursor.captured.includes(stuck)) {
      cursor.captured.push(stuck);
      if (!cursor.unresolved.includes(stuck)) cursor.unresolved.push(stuck);
      effects.push({ kind: "persistField", field: stuck, value: "", unresolved: true });
    }
  }

  const done = nextProfileField(cursor) === undefined;
  if (done) effects.push({ kind: "finalizeProfile" });
  const nextPhase: SessionPhase = done ? "connect_transition" : "profiling";
  const phaseChanged = nextPhase !== (state.phase ?? "profiling");

  const nextState: StrategistState = {
    ...state,
    phase: nextPhase,
    profile: cursor,
    awaitingConnect: nextPhase === "connect_transition" ? true : state.awaitingConnect,
    turnsInPhase: phaseChanged ? 0 : turns + 1,
  };
  return { nextState, effects, capture, offerAngles };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export interface SessionResult {
  reply: string;
  capture: boolean;
  offerAngles: boolean;
  /** True the one turn a goal is captured, if exactly one platform is connected. */
  offerSecondPlatform: boolean;
}

async function loadHistory(userId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const rows = await query<{ role: "user" | "assistant"; content: string }>(
    `SELECT role, content FROM chat_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [userId],
  );
  return rows.reverse();
}

/** Cheap-tier read of whether the user's reply signals they're ready to move on. Fails open. */
async function classifyReaction(userId: string, lastBotMessage: string, message: string): Promise<ReactionSignal> {
  try {
    const res = await llmCall({
      userId,
      eventType: "reaction_signal",
      tier: reactionSignalPrompt.tier,
      system: reactionSignalPrompt.system,
      user: reactionSignalPrompt.render({ lastBotMessage, message }),
      json: true,
      maxTokens: 40,
    });
    const parsed = z.object({ signal: z.enum(["closing", "continuation"]) }).safeParse(res.parsed);
    return parsed.success ? parsed.data.signal : "closing";
  } catch (err) {
    console.error("reaction classification failed; defaulting to closing so the user isn't stuck", err);
    return "closing";
  }
}

/**
 * One turn of the Stage 1-7 profile intake (phases profiling + connect_transition).
 * No diagnosis exists yet. Asks the next uncaptured field one at a time, persists
 * each answer turn-by-turn (crash-safe + feeds the drop-off nudge), and on
 * completion finalizes the profile and moves to the connect transition.
 */
async function runProfilingTurn(userId: string, message: string, state: StrategistState): Promise<SessionResult> {
  const phase: SessionPhase = state.phase === "connect_transition" ? "connect_transition" : "profiling";
  const cursor = state.profile ?? {};
  const field = phase === "profiling" ? nextProfileField(cursor) : undefined;
  // The field to ask after capturing the current one, so the model has the next
  // question's option set in hand and doesn't stall for a turn on it.
  const following = field
    ? nextProfileField({ ...cursor, captured: [...(cursor.captured ?? []), field] })
    : undefined;
  const turnsInPhase = state.phase === phase ? (state.turnsInPhase ?? 0) : 0;

  // A plain, deterministic fallback so a transient LLM/DB hiccup never dead-ends
  // the intake — the machine already knows the next field, so just ask it.
  const fallbackReply =
    phase === "profiling" && field
      ? FALLBACK_QUESTION[field]
      : "Send me your X handle or LinkedIn and I'll read your history from here.";

  // Context loads are best-effort: a DB hiccup on any of them must NOT kill the
  // turn (that was the loop bug — a failed getProfile threw before the LLM ran,
  // so nothing was ever captured and the same field was re-asked forever). The
  // LLM turn is what drives the conversation, so it always runs.
  const [history, relevant, profileRow] = await Promise.all([
    loadHistory(userId).catch(() => [] as Array<{ role: "user" | "assistant"; content: string }>),
    hybridSearch(userId, message, 4).catch(() => []),
    getProfile(userId).catch(() => null),
  ]);

  let reply = fallbackReply;
  let actions: ProfileAction[] = [];
  try {
    const res = await llmCall({
      userId,
      eventType: "strategist_profiling",
      tier: strategistProfiling.tier,
      system: strategistProfiling.system,
      user: strategistProfiling.render({
        phase,
        // Include the message they just sent — it's not persisted until the end
        // of this turn, so without this the model can't see what it's answering
        // and re-asks the same question a turn late (the "not listening" bug).
        history: [...history, { role: "user", content: message }],
        profileSoFar: profileSummaryForPrompt(profileRow),
        nextField: field ?? null,
        fieldSpec: field ? fieldSpec(field, profileRow) : "",
        followingField: following ?? null,
        followingSpec: following ? fieldSpec(following, profileRow) : "",
        alreadyPushed: field ? (cursor.pushed ?? []).includes(field) : false,
        relevantMemories: relevant.map((m) => m.content),
        landItNow: turnsInPhase >= WATCHDOG[phase],
      }),
      json: true,
      maxTokens: 700,
    });
    let envelope = res.parsed;
    if (envelope === undefined) {
      try {
        envelope = extractJson(res.text);
      } catch {
        envelope = { reply: res.text };
      }
    }
    const parsed = parseProfileResponse(envelope);
    reply = parsed.reply || reply;
    actions = parsed.actions;
  } catch (err) {
    // Keep the deterministic fallback question (set above) rather than a generic
    // "lost my thread" dead-end — the conversation still moves forward.
    console.error("profiling turn failed; falling back to the plain field question", err);
  }

  // connect_transition just talks (delivering the Stage 8 hand-off); it captures
  // no fields, so only run the reducer during the intake itself.
  const reduced =
    phase === "profiling"
      ? applyProfileActions({ ...state, phase, turnsInPhase }, actions)
      : {
          nextState: { ...state, phase, turnsInPhase: turnsInPhase + 1 } as StrategistState,
          effects: [] as ProfileEffect[],
          capture: actions.some((a) => a.type === "capture"),
          offerAngles: actions.some((a) => a.type === "offer_angles"),
        };
  let finalState = reduced.nextState;

  try {
    for (const eff of reduced.effects) {
      if (eff.kind === "persistField" && eff.field) {
        await upsertProfileField(userId, eff.field, eff.value ?? "", { unresolved: eff.unresolved });
      } else if (eff.kind === "confirmPillars") {
        await confirmPillars(userId, eff.pillars ?? []);
      } else if (eff.kind === "finalizeProfile") {
        await finalizeProfile(userId);
        await setStage(userId, "profile_set");
      }
    }
  } catch (err) {
    console.error("profiling effect failed; will retry next turn", err);
    // Don't advance out of profiling if persistence failed — reask next turn.
    if (finalState.phase === "connect_transition" && reduced.effects.some((e) => e.kind === "finalizeProfile")) {
      finalState = { ...finalState, phase: "profiling", awaitingConnect: false };
    }
  }

  // Hard anti-loop backstop: if we're still on the same field this turn didn't
  // capture, count it; after a few tries, mark it unresolved and move on so no
  // question can ever be asked forever, whatever the reason (model, DB, network).
  if (phase === "profiling" && field && finalState.phase === "profiling") {
    const stillOnField = nextProfileField(finalState.profile) === field;
    if (stillOnField) {
      const stuck = (state.profile?.stuck ?? 0) + 1;
      if (stuck >= 3) {
        const cur = finalState.profile ?? {};
        finalState = {
          ...finalState,
          profile: {
            ...cur,
            captured: [...(cur.captured ?? []), field],
            unresolved: [...(cur.unresolved ?? []), field],
            stuck: 0,
          },
        };
        await upsertProfileField(userId, field, "", { unresolved: true }).catch(() => {});
        const next = nextProfileField(finalState.profile);
        reply = next ? `No worries, we can come back to that. ${FALLBACK_QUESTION[next]}` : reply;
      } else {
        finalState = { ...finalState, profile: { ...(finalState.profile ?? {}), stuck } };
      }
    } else {
      finalState = { ...finalState, profile: { ...(finalState.profile ?? {}), stuck: 0 } };
    }
  }

  const spoken = casualize(reply);
  await saveTurn(userId, "user", message);
  await saveTurn(userId, "assistant", spoken);
  await setState(userId, finalState);

  return { reply: spoken, capture: reduced.capture, offerAngles: reduced.offerAngles, offerSecondPlatform: false };
}

/**
 * One turn of the paced onboarding conversation. Only called when the user is in
 * an onboarding phase (opening/diagnosis_dialogue/goals/plan_build). Loads state
 * + context, runs the phase-aware brain, applies the pure reducer, performs the
 * effects, persists, and returns the reply + content flags for the bot to send.
 */
export async function runSessionTurn(userId: string, message: string): Promise<SessionResult> {
  const state = await getState(userId);

  // The Stage 1-7 intake runs before any diagnosis exists — its own path.
  if (state.phase === "profiling" || state.phase === "connect_transition") {
    return runProfilingTurn(userId, message, state);
  }

  // The opener was a single message; the user's first reply begins the dialogue.
  const phase: SessionPhase = state.phase === "opening" ? "diagnosis_dialogue" : (state.phase ?? "diagnosis_dialogue");

  const diag = state.diagnosisId
    ? await diagnosisById(userId, state.diagnosisId)
    : ((await currentDiagnosis(userId))?.dimensions ?? null);
  if (!diag) {
    // No diagnosis to ground the session — shouldn't happen; degrade gracefully.
    const reply = "give me a sec, still reading through your stuff. try me again in a moment.";
    await saveTurn(userId, "user", message);
    await saveTurn(userId, "assistant", reply);
    return { reply, capture: false, offerAngles: false, offerSecondPlatform: false };
  }

  const [history, relevant, plan] = await Promise.all([
    loadHistory(userId),
    hybridSearch(userId, message, 4).catch(() => []),
    phase === "plan_build" ? getPlan(userId, state.planId) : Promise.resolve(null),
  ]);

  const covered = state.covered ?? [];
  const planCovered = state.planCovered ?? [];
  const turnsInPhase = state.phase === phase ? (state.turnsInPhase ?? 0) : 0;

  // Only true on the exact turn every diagnosis beat has already been shown —
  // i.e. the "pause" from the reveal. That's the one case where whether to
  // leave diagnosis_dialogue depends on reading the reply, not just pacing.
  const awaitingReactionSignal =
    (phase === "diagnosis_dialogue" && remainingBeats(covered).length === 0) || phase === "gap_analysis";
  const lastBotMessage = awaitingReactionSignal
    ? ([...history].reverse().find((h) => h.role === "assistant")?.content ?? "")
    : "";

  const [res, reaction] = await Promise.all([
    llmCall({
      userId,
      eventType: "strategist_session",
      tier: strategistSession.tier,
      system: strategistSession.system,
      user: strategistSession.render({
        phase,
        // Include the just-sent message (not persisted until end of turn) so the
        // strategist reacts to what they actually said, not a turn behind.
        history: [...history, { role: "user", content: message }],
        diagnosis: diag,
        covered,
        remainingBeats: remainingBeats(covered),
        unsaidUnlocked: unsaidUnlocked(covered),
        goalDraft: state.goalDraft ?? {},
        planCovered,
        remainingPlanBeats: remainingPlanBeats(planCovered),
        plan: plan ? { throughline: plan.throughline, unlock: plan.unlock, cadence: plan.cadence } : null,
        relevantMemories: relevant.map((m) => m.content),
        landItNow: turnsInPhase >= WATCHDOG[phase],
      }),
      json: true,
      maxTokens: 700,
    }),
    awaitingReactionSignal ? classifyReaction(userId, lastBotMessage, message) : Promise.resolve(undefined),
  ]);

  // Robust parse: extractJson already ran in the gateway; re-derive if needed.
  let envelope = res.parsed;
  if (envelope === undefined) {
    try {
      envelope = extractJson(res.text);
    } catch {
      envelope = { reply: res.text };
    }
  }
  const { reply: rawReply, actions } = parseSessionResponse(envelope);
  const reply = casualize(rawReply || "say more?");

  // Reduce against a state pinned to the effective phase.
  const reduced = applyActions({ ...state, phase, covered, planCovered, turnsInPhase }, actions, reaction);
  let finalState = reduced.nextState;
  let offerSecondPlatform = false;

  // gap_analysis → plan_build: the user's reaction landed. Build and reveal the
  // three-month plan (its own paced sequence) instead of a normal reply.
  if (phase === "gap_analysis" && finalState.phase === "plan_build") {
    await saveTurn(userId, "user", message);
    await openPlanSession(userId, state.gapText);
    return { reply: "", capture: reduced.capture, offerAngles: reduced.offerAngles, offerSecondPlatform: false };
  }

  // Perform effects in order. Each effect only advances the phase AFTER its DB
  // work actually succeeds, and the whole loop is guarded so a mid-turn failure
  // can never persist an advanced phase without the row it depends on
  // (adversarial-review findings: partial state / null planId / stuck states).
  try {
    for (const eff of reduced.effects) {
      if (eff.kind === "captureGoal" && eff.goal) {
        await submitGoal(userId, {
          goalType: eff.goal.goalType,
          detail: eff.goal.detail,
          timeframe: eff.goal.timeframe,
          success: eff.goal.success,
        });
        // The goal just landed — a natural moment to ask about the OTHER
        // platform, once, if they've only connected the one so far.
        offerSecondPlatform = Boolean(await otherUnconnectedPlatform(userId).catch(() => null));
        await generatePlanDraft(userId); // creates the draft plan + unlock items
        const draftPlan = await getPlan(userId);
        // Only enter plan_build if the plan truly materialized; otherwise stay
        // in goals and let the next turn retry (never plan_build without planId).
        finalState = draftPlan?.id
          ? { ...finalState, planId: draftPlan.id, phase: "plan_build" }
          : { ...finalState, phase: "goals" };
      } else if (eff.kind === "setCadence" && finalState.planId) {
        await setPlanCadence(userId, finalState.planId, { perWeek: eff.perWeek, note: eff.note });
      } else if (eff.kind === "confirmPlan" && finalState.planId) {
        const ok = await confirmPlan(userId, finalState.planId); // atomic: status + stage + state
        finalState = ok ? { phase: "active" } : { ...finalState, phase: "plan_build" };
      }
    }
  } catch (err) {
    console.error("session effect failed; reconciling state", err);
    // A thrown commit means confirmPlan's transaction rolled back — the plan is
    // still a draft, so step back to plan_build (keeping planId) rather than
    // stranding the user "active" on an uncommitted plan.
    if (finalState.phase === "active") {
      finalState = { ...finalState, phase: "plan_build" };
    }
    // And never sit in plan_build without the plan it depends on.
    if (finalState.phase === "plan_build" && !finalState.planId) {
      finalState = { ...finalState, phase: "goals" };
    }
  }

  await saveTurn(userId, "user", message);
  await saveTurn(userId, "assistant", reply);
  await setState(userId, finalState);

  return { reply, capture: reduced.capture, offerAngles: reduced.offerAngles, offerSecondPlatform };
}

// ── The diagnosis reveal ───────────────────────────────────────────────────────

const REVEAL_FALLBACK =
  "read through everything you've put out. there's a sharper throughline in here than you're using. " +
  "before i get into the whole read, does anything about how you've been showing up feel off to you?";

/**
 * Fired once ingestion + diagnosis complete: deliver the FULL five-dimension
 * diagnosis as a paced, multi-message walkthrough (sharp observation → what's
 * working → the harder gaps → the unsaid pattern → a pause for their reaction).
 * It does NOT jump to goals. After delivery the session sits in
 * diagnosis_dialogue with every beat already revealed, so the user's next
 * message is treated as their reaction and the strategist can move forward from
 * there.
 */
export async function openSession(userId: string, diagnosisId: string, dimensions: Diagnosis): Promise<void> {
  const [samples, countRow] = await Promise.all([
    query<{ content: string }>(
      `SELECT content FROM memories WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 8`,
      [userId],
    ),
    queryOne<{ n: string }>(`SELECT count(*)::text n FROM memories WHERE user_id = $1 AND status = 'active'`, [userId]),
  ]);

  let messages: string[] = [];
  try {
    const res = await llmCall({
      userId,
      eventType: "diagnosis_reveal",
      tier: diagnosisReveal.tier,
      system: diagnosisReveal.system,
      user: diagnosisReveal.render({
        diagnosis: dimensions,
        sampleMemories: samples.map((s) => s.content),
        memoryCount: Number(countRow?.n ?? samples.length),
      }),
      json: true,
      maxTokens: 2200,
    });
    const parsed = (res.parsed ?? {}) as { messages?: unknown };
    if (Array.isArray(parsed.messages)) {
      messages = parsed.messages.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
    }
  } catch (err) {
    console.error("diagnosis reveal generation failed", err);
  }
  if (messages.length === 0) messages = [REVEAL_FALLBACK];

  // Every beat is delivered up front now, so the dialogue starts fully covered:
  // the user's next turn is a reaction, and the machine can advance to goals.
  await setState(userId, {
    phase: "diagnosis_dialogue",
    diagnosisId,
    covered: [...DIAGNOSIS_BEATS],
    turnsInPhase: 0,
  });
  // Persist only the last message as the assistant turn so short chat history
  // stays coherent without ballooning from the full multi-part reveal.
  await saveTurn(userId, "assistant", messages[messages.length - 1]!);
  await sendTelegramSequence(userId, messages);
}

const GAP_FALLBACK =
  "read your whole history against everything you just told me. there's a real gap between what " +
  "you're aiming for and what's actually out there. before i lay it all out, does anything about " +
  "how you've been showing up already feel off to you?";

/**
 * Stage 10: the gap analysis. Fired after connect+diagnosis when a completed
 * brand profile exists. Computes the deterministic stated-vs-actual gap, has the
 * model narrate it as a paced multi-message reveal, and leaves the session in
 * gap_analysis with the diagnosis pinned — the user's next message is their
 * reaction, and the machine advances to the three-month plan from there.
 */
export async function openGapSession(
  userId: string,
  diagnosisId: string,
  dimensions: Diagnosis,
  profile: BrandProfile,
): Promise<void> {
  const [samples, countRow, gap] = await Promise.all([
    query<{ content: string }>(
      `SELECT content FROM memories WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 8`,
      [userId],
    ),
    queryOne<{ n: string }>(`SELECT count(*)::text n FROM memories WHERE user_id = $1 AND status = 'active'`, [userId]),
    computeGap(userId, profile).catch((err) => {
      console.error("gap computation failed; revealing on the diagnosis alone", err);
      return null;
    }),
  ]);

  let messages: string[] = [];
  try {
    const res = await llmCall({
      userId,
      eventType: "gap_analysis",
      tier: gapAnalysis.tier,
      system: gapAnalysis.system,
      user: gapAnalysis.render({
        profileSummary: profileSummaryForPrompt(profile),
        diagnosis: dimensions,
        gap: gap?.text ?? "(gap computation unavailable — work from the diagnosis and stated profile alone)",
        sampleMemories: samples.map((s) => s.content),
        memoryCount: Number(countRow?.n ?? samples.length),
      }),
      json: true,
      maxTokens: 2500,
    });
    const parsed = (res.parsed ?? {}) as { messages?: unknown };
    if (Array.isArray(parsed.messages)) {
      messages = parsed.messages.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
    }
  } catch (err) {
    console.error("gap analysis generation failed", err);
  }
  if (messages.length === 0) messages = [GAP_FALLBACK];

  await setState(userId, {
    phase: "gap_analysis",
    diagnosisId,
    covered: [...DIAGNOSIS_BEATS],
    gapText: gap?.text, // reused by the three-month plan so we don't recompute
    turnsInPhase: 0,
  });
  await saveTurn(userId, "assistant", messages[messages.length - 1]!);
  await sendTelegramSequence(userId, messages);
}

/**
 * Stage 11: the three-month plan, delivered when the gap analysis lands and the
 * user is ready. Generates the plan from the diagnosis + stated profile + the gap
 * kept from the reveal, then delivers a paced month-by-month reveal and sits in
 * plan_build awaiting confirmation (cadence is the stated capacity, not asked).
 */
export async function openPlanSession(userId: string, gapText?: string): Promise<void> {
  const profile = await getProfile(userId);
  const plan = profile ? await generateThreeMonthPlan(userId, profile, gapText ?? "").catch((err) => {
    console.error("three-month plan generation failed", err);
    return null;
  }) : null;

  if (!plan) {
    await sendTelegramSequence(userId, [
      "hit a snag building your three-month plan just now. give me a moment and say 'plan' to try again.",
    ]);
    return;
  }

  const messages: string[] = [];
  messages.push(`here's the shift that closes the biggest gap:\n\n${plan.repositioning}`);
  messages.push(`🎯 what you become known for:\n${plan.throughline}`);
  for (const m of plan.months) messages.push(`${m.label}\n${m.objective}`);
  if (plan.unlock.length) {
    messages.push(
      "first pieces, pulled straight from what you're already sitting on:\n" +
        plan.unlock.slice(0, 3).map((u, i) => `${i + 1}. ${u.idea}`).join("\n"),
    );
  }
  messages.push(
    `cadence: ${plan.perWeek} posts a week, the honest number you gave me. ` +
      "if that lands, say the word and i'll lock it in and start working it with you.",
  );

  await setState(userId, {
    phase: "plan_build",
    planId: plan.planId,
    planCovered: [...PLAN_BEATS], // fully presented — the plan_build turn just confirms
    cadenceSet: true,
    turnsInPhase: 0,
  });
  await saveTurn(userId, "assistant", messages[messages.length - 1]!);
  await sendTelegramSequence(userId, messages);
}
