/**
 * Web-facing wrappers around the same conversational brain the Telegram bot
 * uses. The bot delivers replies by sending Telegram messages through a
 * `Channel`; here we swap in a collecting channel that just gathers the text, so
 * an HTTP handler can return the turn's messages as JSON. All the real logic
 * (tool loop, capture, onboarding reducer) is shared, unchanged.
 */
import type { User } from "../lib/auth.js";
import { converseWithUser } from "../telegram/conversation.js";
import { chatToolExecutor, deliverTurnOutput } from "../telegram/actions.js";
import { runSessionTurn, skipAllIntake, nextProfileField } from "../strategist/session-machine.js";
import { getState, setState, getStage, setStage } from "../strategist/state.js";
import { PROFILE_FIELDS } from "../strategist/profile.js";
import { FALLBACK_QUESTION } from "../prompts/strategist-session.v2.js";
import { ensureBoss } from "../jobs/boss.js";
import { collectingChannel } from "./channel.js";

const WEB_OPENER =
  "before i read a single post, i want to hear it from you — a few real questions, then i go read " +
  "your history and show you the gap between what you're building and what's already out there.\n\n" +
  "first, easy: what's the broad space you work in?";

/**
 * Prime onboarding for the web and return the opening question. Mirrors the
 * bot's `/start`: sets the profiling stage/state for a fresh user, resumes an
 * in-progress intake, or reports the connect hand-off. Idempotent.
 */
export async function initWebOnboarding(user: User): Promise<OnboardingTurn> {
  const stage = await getStage(user.id);
  if (stage === "active" || stage === "plan_active") {
    return { messages: [], phase: "active", intakeComplete: true };
  }

  const st = await getState(user.id);
  const phase = st.phase ?? "new";

  if (phase === "profiling") {
    const next = nextProfileField(st.profile);
    const captured = st.profile?.captured?.length ?? 0;
    if (!next) return { messages: [], phase: "connect_transition", intakeComplete: true };
    const q = FALLBACK_QUESTION[next];
    return {
      messages: [captured > 0 ? `picking up where we left off. ${q}` : WEB_OPENER],
      phase,
      intakeComplete: false,
    };
  }

  if (phase === "connect_transition") {
    return {
      messages: [
        "nice — that's the questions done. next, connect your X or LinkedIn so i can read your actual work and diagnose from there.",
      ],
      phase,
      intakeComplete: true,
    };
  }

  // Fresh user: open the intake.
  await setStage(user.id, "profiling");
  await setState(user.id, { phase: "profiling", profile: {} });
  void PROFILE_FIELDS; // ordered field list drives nextProfileField above
  return { messages: [WEB_OPENER], phase: "profiling", intakeComplete: false };
}

/** One steady-state chat turn: bounded multi-tool loop, capture, final reply. */
export async function runWebChatTurn(user: User, text: string): Promise<{ messages: string[] }> {
  // Chat tools (connect, schedule, refresh diagnosis) may enqueue jobs.
  await ensureBoss();
  const { channel, messages } = collectingChannel();
  const result = await converseWithUser(user.id, text, { executeTool: chatToolExecutor(user, channel) });
  await deliverTurnOutput(user, text, result, channel);
  return { messages };
}

export interface OnboardingTurn {
  messages: string[];
  phase: string;
  /** True once the intake questionnaire is finished (past `profiling`). */
  intakeComplete: boolean;
}

/** One onboarding intake turn. `text` "skip this question" advances one field. */
export async function runWebOnboardingTurn(user: User, text: string): Promise<OnboardingTurn> {
  const { channel, messages } = collectingChannel();
  const r = await runSessionTurn(user.id, text);
  await deliverTurnOutput(user, text, r, channel);
  const st = await getState(user.id);
  const phase = st.phase ?? "profiling";
  return { messages, phase, intakeComplete: phase !== "profiling" };
}

/** "Skip this step" button — reuses the deterministic typed-skip path. */
export async function skipOnboardingStep(user: User): Promise<OnboardingTurn> {
  return runWebOnboardingTurn(user, "skip this question");
}

/** "Skip onboarding" button — finalize the thinner profile, jump to connect. */
export async function skipOnboardingAll(user: User): Promise<{ phase: string; intakeComplete: true }> {
  await skipAllIntake(user.id);
  const st = await getState(user.id);
  return { phase: st.phase ?? "connect_transition", intakeComplete: true };
}
