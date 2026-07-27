/**
 * Channel-agnostic approve / reject / edit actions for an automation run. No
 * `ctx` and no Telegram here, so the Telegram callbacks AND the web Approvals
 * inbox both call these and only differ in how they render the result. Every
 * gating transition is an atomic claim (store.claimRun), so a double tap can't
 * double-schedule or double-reject.
 */
import { InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { schedulePost } from "../scheduling/service.js";
import { ensureBoss } from "../jobs/boss.js";
import { reviseDraft } from "../drafting/revise.js";
import { casualize } from "../prompts/style.js";
import { claimRun, getRun, setRunScheduled, setRunStatus, updateRunDraft } from "./store.js";

/** The approval DM: casual framing line + VERBATIM draft body + media line. Lives
 *  here (not run.ts) so both run.ts and telegram/bot.ts import it without a cycle. */
export function approvalMessage(automationName: string, label: string, draft: string, media: string | null): string {
  const framing = casualize(`⚡ your "${automationName}" automation drafted this off ${label}:`);
  const mediaLine = media ? `\n\n📎 pair it with: ${media}` : "";
  return `${framing}\n\n${draft}${mediaLine}`;
}

export function approvalKeyboard(runId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ approve", `auto:ok:${runId}`)
    .text("✏️ edit", `auto:edit:${runId}`)
    .text("🗑 reject", `auto:no:${runId}`);
}

// An approved post still queues (cancellable), just with a short delay — the user
// already chose to publish, so it doesn't wait the full auto-mode window.
const APPROVED_DELAY_MS = 2 * 60_000;

/**
 * Why a run is no longer actionable, in words. An expired approval used to come
 * back as the same flat "already handled" a double-tap gets, which is the one
 * case where the user genuinely did nothing and deserves an explanation — the
 * agent gave up on the draft, and the monthly slot went back.
 */
const EXPIRY_NOTE = "that draft expired — it sat unanswered too long, so I let it go and gave you the post slot back";

export async function approveRun(userId: string, runId: string): Promise<{ ok: boolean; reason?: string }> {
  const run = await getRun(runId, userId);
  if (!run) return { ok: false, reason: "not found" };
  if (run.status === "expired") return { ok: false, reason: EXPIRY_NOTE };
  if (!run.draft_body) return { ok: false, reason: "no draft" };
  const claimed = await claimRun(runId, "awaiting_approval", "approved");
  if (!claimed) return { ok: false, reason: "already handled" };
  await ensureBoss();
  const res = await schedulePost(userId, {
    platform: "x",
    content: run.draft_body,
    scheduledFor: new Date(Date.now() + APPROVED_DELAY_MS),
  });
  if (!res.ok || !res.id) {
    await setRunStatus(runId, "failed", res.reason ?? "schedule failed");
    return { ok: false, reason: res.reason ?? "couldn't queue it" };
  }
  await setRunScheduled(runId, res.id);
  return { ok: true };
}

export async function rejectRun(userId: string, runId: string): Promise<{ ok: boolean; reason?: string }> {
  const claimed = await claimRun(runId, "awaiting_approval", "rejected");
  if (!claimed) {
    // Distinguish "you already answered this" from "we aged it out on you".
    const run = await getRun(runId, userId);
    return { ok: false, reason: run?.status === "expired" ? EXPIRY_NOTE : undefined };
  }
  await setRunStatus(runId, "rejected", "user_rejected");
  return { ok: true };
}

export interface EditResult {
  ok: boolean;
  draft?: string;
  capped?: boolean;
  reason?: string;
}

/** Apply a free-text edit to a run's draft, unless the edit cap is hit. */
export async function applyEdit(userId: string, runId: string, instruction: string): Promise<EditResult> {
  const run = await getRun(runId, userId);
  if (!run || !run.draft_body) return { ok: false, reason: "not found" };
  if (run.status === "expired") return { ok: false, reason: EXPIRY_NOTE };
  if (run.status !== "awaiting_approval") return { ok: false, reason: "not open for edits" };
  if (run.edit_count >= config.AUTOMATION_MAX_EDITS) return { ok: false, capped: true };
  const revised = await reviseDraft(userId, run.draft_body, instruction, "x");
  if (!revised.ok) return { ok: false, reason: revised.note || "couldn't apply that" };
  await updateRunDraft(runId, revised.draft);
  return { ok: true, draft: revised.draft };
}
