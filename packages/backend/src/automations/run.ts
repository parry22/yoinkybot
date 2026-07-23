/**
 * The automation run pipeline (§4): cap check → deterministic select → moderate
 * seed → compose (existing draft path) → persist → deliver. Code decides
 * whether/which; the LLM only composes. Voice split is load-bearing: the draft
 * body is feed content (POST_WRITING_RULES + enforceStyle, via generateDraft) and
 * is NEVER casualized; only the framing DM line is casual.
 */
import { config } from "../config.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { generateDraft } from "../drafting/draft.js";
import { markUnlockDeveloped } from "../strategist/plan.js";
import { moderateText } from "../moderation/filter.js";
import { dmChannel } from "../telegram/bot.js";
import { schedulePost } from "../scheduling/service.js";
import { ensureBoss } from "../jobs/boss.js";
import { approvalMessage, approvalKeyboard } from "./approval.js";
import { SOURCES } from "./sources/index.js";
import {
  createRun,
  claimRun,
  stampRun,
  bumpWarmup,
  monthlyRunCount,
  userDailyRunCount,
  setRunScheduled,
  setRunStatus,
} from "./store.js";
import type { Automation, RunStatus } from "./types.js";

export interface RunResult {
  status: RunStatus;
  runId?: string;
  reason?: string;
}

/**
 * Run one automation once. Safe for both the cron tick and the web "run once now"
 * button (pass manual:true so an empty source records a visible skipped run).
 */
export async function runAutomationOnce(automation: Automation, opts: { manual?: boolean } = {}): Promise<RunResult> {
  const userId = automation.user_id;
  const isAuto = automation.delivery_mode === "auto";

  // The whole unattended path is DARK until the flag flips — auto automations
  // produce nothing (and spend nothing) until then. Hands-off AUTO mode is also
  // a Scale-only entitlement: Growth may build approval-mode automations but not
  // let them post on their own. (Runtime backstop; save-time gate is in web/automations.ts.)
  if (isAuto) {
    if (!config.AUTOMATIONS_AUTO_ENABLED) return { status: "skipped", reason: "auto mode is disabled" };
    if (!(await entitlementsFor(userId)).autoAgent) {
      return { status: "skipped", reason: "auto mode requires the Scale plan" };
    }
  }

  // Caps BEFORE any paid/model work (buyer-radar doctrine).
  if ((await monthlyRunCount(automation.id)) >= automation.monthly_cap) {
    const run = await createRun(automation.id, userId, "skipped", { verdict_reason: "monthly cap reached" });
    return { status: "skipped", runId: run.id, reason: "monthly cap reached" };
  }
  if ((await userDailyRunCount(userId)) >= config.AUTOMATION_USER_DAILY_CAP) {
    return { status: "skipped", reason: "daily post cap reached" };
  }

  // Deterministic select — no LLM has run yet.
  const source = SOURCES[automation.source_type];
  const item = await source.select(userId, automation);
  if (!item) {
    if (opts.manual) {
      const run = await createRun(automation.id, userId, "skipped", { verdict_reason: "nothing eligible to post right now" });
      return { status: "skipped", runId: run.id, reason: "nothing eligible to post right now" };
    }
    return { status: "skipped", reason: "nothing eligible" };
  }

  // Moderate the seed; a bad seed is dropped, never embedded or sent to a model.
  if (!moderateText(item.seed).ok) {
    const run = await createRun(automation.id, userId, "skipped", {
      source_ref: item.sourceRef,
      verdict_reason: "source failed content guidelines",
    });
    return { status: "skipped", runId: run.id, reason: "source failed content guidelines" };
  }

  // Compose via the existing draft path (feed voice, metered, voice+pillars+reach).
  let seed = automation.pillar_scope?.length ? `${item.seed}\n\nStay within: ${automation.pillar_scope.join(", ")}.` : item.seed;
  // The brief is the seed itself for a 'custom' automation; for the preset
  // sources it layers on as the user's own extra guidance.
  if (automation.source_type !== "custom" && automation.brief?.trim()) {
    seed = `${seed}\n\nExtra guidance from me: ${automation.brief.trim()}`;
  }
  const draft = await generateDraft(userId, seed, automation.platform);
  if (!draft.ok) {
    const run = await createRun(automation.id, userId, "skipped", {
      source_ref: item.sourceRef,
      verdict_reason: draft.note || "draft declined",
    });
    return { status: "skipped", runId: run.id, reason: draft.note || "draft declined" };
  }

  const run = await createRun(automation.id, userId, "drafting", {
    source_ref: item.sourceRef,
    draft_body: draft.draft,
    media_suggestion: draft.mediaSuggestion || null,
    agent_steps: { sources: draft.sources.map((s) => ({ id: s.id, kind: s.kind })) },
  });

  // Consume the source (unlock backlog marks the developed item) + stamp the run.
  if (automation.source_type === "unlock_backlog") {
    await markUnlockDeveloped(userId, draft.draft).catch(() => {});
  }
  await stampRun(automation.id);

  // Warmup ramp: an auto automation's first N posts route through approval so the
  // user confirms the voice before it goes fully hands-off.
  const inWarmup = isAuto && automation.warmup_count < config.AUTOMATION_AUTO_WARMUP;
  const effectiveApproval = automation.delivery_mode === "approval" || inWarmup;

  if (effectiveApproval) {
    const claimed = await claimRun(run.id, "drafting", "awaiting_approval");
    if (!claimed) return { status: "skipped", runId: run.id, reason: "already handled" };
    // DM the approval card (no-op if the user hasn't linked Telegram — the web
    // Approvals inbox mirrors it either way). Draft body is sent VERBATIM.
    await dmChannel(userId)
      .say(approvalMessage(automation.name, item.label, draft.draft, draft.mediaSuggestion || null), approvalKeyboard(run.id))
      .catch(() => {});
    if (isAuto) await bumpWarmup(automation.id); // warmup post consumed
    return { status: "awaiting_approval", runId: run.id };
  }

  // True auto: schedule a delayed, cancellable post (never instant). Outcome DM is
  // emitted by jobs/scheduled-post.ts on publish.
  const claimed = await claimRun(run.id, "drafting", "approved");
  if (!claimed) return { status: "skipped", runId: run.id, reason: "already handled" };
  await ensureBoss();
  const when = new Date(Date.now() + config.AUTOMATION_AUTO_DELAY_MIN * 60_000);
  const res = await schedulePost(userId, { platform: automation.platform, content: draft.draft, scheduledFor: when });
  if (!res.ok || !res.id) {
    await setRunStatus(run.id, "failed", res.reason ?? "schedule failed");
    return { status: "failed", runId: run.id, reason: res.reason };
  }
  await setRunScheduled(run.id, res.id);
  await bumpWarmup(automation.id);
  return { status: "scheduled", runId: run.id };
}
