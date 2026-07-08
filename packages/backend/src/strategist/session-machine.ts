import { z } from "zod";
import { InlineKeyboard } from "grammy";
import { llmCall, extractJson } from "../llm/gateway.js";
import { strategistSession } from "../prompts/strategist-session.v1.js";
import { diagnosisReveal } from "../prompts/diagnosis-reveal.v1.js";
import { reactionSignal as reactionSignalPrompt } from "../prompts/reaction-signal.v1.js";
import { hybridSearch } from "../memory/search.js";
import { query, queryOne } from "../db/pool.js";
import { sendTelegramSequence } from "../telegram/bot.js";
import { saveTurn } from "../telegram/conversation.js";
import { currentDiagnosis, diagnosisById, type Diagnosis } from "./diagnosis.js";
import { submitGoal, GOAL_TYPES } from "./goals.js";
import { generatePlanDraft, confirmPlan, setPlanCadence, getPlan } from "./plan.js";
import { otherUnconnectedPlatform } from "./connect.js";
import {
  DIAGNOSIS_BEATS,
  PLAN_BEATS,
  getState,
  setState,
  type DiagnosisBeat,
  type PlanBeat,
  type SessionPhase,
  type StrategistState,
} from "./state.js";

type ReactionSignal = "closing" | "continuation";

// How many turns in a phase before the watchdog tells the LLM to land it.
const WATCHDOG: Record<SessionPhase, number> = {
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

  if (phase === "diagnosis_dialogue") {
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
 * One turn of the paced onboarding conversation. Only called when the user is in
 * an onboarding phase (opening/diagnosis_dialogue/goals/plan_build). Loads state
 * + context, runs the phase-aware brain, applies the pure reducer, performs the
 * effects, persists, and returns the reply + content flags for the bot to send.
 */
export async function runSessionTurn(userId: string, message: string): Promise<SessionResult> {
  const state = await getState(userId);
  // The opener was a single message; the user's first reply begins the dialogue.
  const phase: SessionPhase = state.phase === "opening" ? "diagnosis_dialogue" : (state.phase ?? "diagnosis_dialogue");

  const diag = state.diagnosisId
    ? await diagnosisById(userId, state.diagnosisId)
    : ((await currentDiagnosis(userId))?.dimensions ?? null);
  if (!diag) {
    // No diagnosis to ground the session — shouldn't happen; degrade gracefully.
    const reply = "Give me a moment — I'm still reading through your work. Try again shortly.";
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
  const awaitingReactionSignal = phase === "diagnosis_dialogue" && remainingBeats(covered).length === 0;
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
        history,
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
  const reply = rawReply || "Say more?";

  // Reduce against a state pinned to the effective phase.
  const reduced = applyActions({ ...state, phase, covered, planCovered, turnsInPhase }, actions, reaction);
  let finalState = reduced.nextState;
  let offerSecondPlatform = false;

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
  "I read through everything you've put out. There's a sharper throughline here than you're using. " +
  "Before I get into the whole read, does anything about how you've been showing up feel off to you?";

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
