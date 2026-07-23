/**
 * Web read-model + actions for Automations (the Cowork-style surface). Thin
 * wrappers over the automation store + run pipeline + approval actions, exposed
 * through the @yoink/backend/web barrel. The web is config + a mirror of the
 * approval inbox; Telegram is the primary push channel.
 */
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { assertClean, ModerationError } from "../moderation/filter.js";
import {
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  setEnabled,
  type AutomationInput,
} from "../automations/store.js";
import { runAutomationOnce } from "../automations/run.js";
import { approveRun, rejectRun, applyEdit } from "../automations/approval.js";
import type { Automation, SourceType, DeliveryMode, CadenceKind } from "../automations/types.js";

export interface AutomationView {
  id: string;
  name: string;
  sourceType: SourceType;
  deliveryMode: DeliveryMode;
  cadenceKind: CadenceKind;
  cadenceMeta: Record<string, unknown>;
  monthlyCap: number;
  respectQuietHours: boolean;
  pillarScope: string[] | null;
  brief: string | null;
  enabled: boolean;
  pendingApprovals: number;
  lastRunAt: string | null;
}

export interface PendingApprovalView {
  runId: string;
  automationName: string;
  draft: string;
  media: string | null;
  createdAt: string;
}

export interface RunView {
  id: string;
  status: string;
  sourceLabel: string | null;
  draft: string | null;
  verdictReason: string | null;
  createdAt: string;
}

function toView(a: Automation, pending = 0): AutomationView {
  return {
    id: a.id,
    name: a.name,
    sourceType: a.source_type,
    deliveryMode: a.delivery_mode,
    cadenceKind: a.cadence_kind,
    cadenceMeta: a.cadence_meta ?? {},
    monthlyCap: a.monthly_cap,
    respectQuietHours: a.respect_quiet_hours,
    pillarScope: a.pillar_scope,
    brief: a.brief ?? null,
    enabled: a.enabled,
    pendingApprovals: pending,
    lastRunAt: a.last_run_at,
  };
}

export async function listAutomationsForWeb(userId: string): Promise<AutomationView[]> {
  const rows = await query<Automation & { pending: string }>(
    `SELECT a.*,
       (SELECT count(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'awaiting_approval') AS pending
     FROM automations a WHERE a.user_id = $1 ORDER BY a.created_at DESC`,
    [userId],
  );
  return rows.map((r) => toView(r, Number(r.pending ?? 0)));
}

export async function getAutomationForWeb(userId: string, id: string): Promise<AutomationView | null> {
  const a = await getAutomation(id, userId);
  return a ? toView(a) : null;
}

/** The web form posts raw JSON; sanitize reads each field defensively. */
export type AutomationFormInput = Record<string, unknown>;

const SOURCE_TYPES: SourceType[] = ["trend_ride", "unlock_backlog", "custom"];
const DELIVERY_MODES: DeliveryMode[] = ["approval", "auto"];
const CADENCE_KINDS: CadenceKind[] = ["daily", "weekly", "manual"];
const BRIEF_MAX = 1000;

function sanitize(input: AutomationFormInput): AutomationInput {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  assertClean(name); // throws ModerationError -> 400
  const sourceType = SOURCE_TYPES.includes(input.sourceType as SourceType) ? (input.sourceType as SourceType) : "trend_ride";
  const deliveryMode = DELIVERY_MODES.includes(input.deliveryMode as DeliveryMode) ? (input.deliveryMode as DeliveryMode) : "approval";
  const cadenceKind = CADENCE_KINDS.includes(input.cadenceKind as CadenceKind) ? (input.cadenceKind as CadenceKind) : "daily";
  const pillarScope = Array.isArray(input.pillarScope)
    ? input.pillarScope.map((s) => String(s)).filter(Boolean)
    : null;
  const brief = typeof input.brief === "string" ? input.brief.trim().slice(0, BRIEF_MAX) : "";
  if (brief) assertClean(brief); // the free-text brief goes through the same gate
  // A 'custom' automation is defined entirely by its brief — reject an empty one.
  if (sourceType === "custom" && !brief) {
    throw new ModerationError("Describe what this automation should do.");
  }
  return {
    name: name || (brief ? brief.slice(0, 60) : "Untitled automation"),
    source_type: sourceType,
    delivery_mode: deliveryMode,
    cadence_kind: cadenceKind,
    cadence_meta: (input.cadenceMeta && typeof input.cadenceMeta === "object" ? input.cadenceMeta : {}) as Record<string, unknown>,
    monthly_cap: typeof input.monthlyCap === "number" ? input.monthlyCap : config.AUTOMATION_DEFAULT_MONTHLY_CAP,
    respect_quiet_hours: input.respectQuietHours !== false,
    pillar_scope: pillarScope,
    brief: brief || null,
  };
}

export async function saveAutomationFromWeb(userId: string, input: AutomationFormInput, id?: string): Promise<AutomationView> {
  const clean = sanitize(input);
  // Hands-off AUTO mode is a Scale entitlement. Growth can build approval-mode
  // automations but not ones that post on their own. Surfaced as a ModerationError
  // so the web route's existing 400 handler shows the reason.
  if (clean.delivery_mode === "auto" && !(await entitlementsFor(userId)).autoAgent) {
    throw new ModerationError("Hands-off auto mode is a Scale feature — pick “Asks you first”, or upgrade to Scale.");
  }
  const saved = id
    ? await updateAutomation(id, userId, clean)
    : await createAutomation(userId, clean, config.AUTOMATION_DEFAULT_MONTHLY_CAP);
  if (!saved) throw new Error("automation not found");
  return toView(saved);
}

export async function setAutomationEnabledWeb(userId: string, id: string, enabled: boolean): Promise<{ ok: boolean }> {
  const a = await getAutomation(id, userId);
  if (!a) return { ok: false };
  await setEnabled(id, userId, enabled);
  return { ok: true };
}

export async function runAutomationOnceWeb(userId: string, id: string): Promise<{ status: string; reason?: string }> {
  const a = await getAutomation(id, userId);
  if (!a) return { status: "failed", reason: "not found" };
  const res = await runAutomationOnce(a, { manual: true });
  return { status: res.status, reason: res.reason };
}

export async function listPendingApprovalsWeb(userId: string): Promise<PendingApprovalView[]> {
  const rows = await query<{ id: string; name: string; draft_body: string; media_suggestion: string | null; created_at: string }>(
    `SELECT r.id, a.name, r.draft_body, r.media_suggestion, r.created_at::text
     FROM automation_runs r JOIN automations a ON a.id = r.automation_id
     WHERE r.user_id = $1 AND r.status = 'awaiting_approval'
     ORDER BY r.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    runId: r.id,
    automationName: r.name,
    draft: r.draft_body,
    media: r.media_suggestion,
    createdAt: r.created_at,
  }));
}

export async function listAutomationRunsWeb(userId: string, automationId: string, limit = 30): Promise<RunView[]> {
  const rows = await query<{
    id: string;
    status: string;
    source_ref: { label?: string; source_note?: string; idea?: string } | null;
    draft_body: string | null;
    verdict_reason: string | null;
    created_at: string;
  }>(
    `SELECT id, status, source_ref, draft_body, verdict_reason, created_at::text
     FROM automation_runs WHERE user_id = $1 AND automation_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [userId, automationId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    sourceLabel: r.source_ref?.source_note ?? r.source_ref?.idea ?? null,
    draft: r.draft_body,
    verdictReason: r.verdict_reason,
    createdAt: r.created_at,
  }));
}

/** Approve / reject / edit a run from the web (mirrors the Telegram callbacks). */
export async function actOnRunWeb(
  userId: string,
  runId: string,
  action: "approve" | "reject" | "edit",
  instruction?: string,
): Promise<{ ok: boolean; draft?: string; capped?: boolean; reason?: string }> {
  if (action === "approve") return approveRun(userId, runId);
  if (action === "reject") return rejectRun(userId, runId);
  if (action === "edit") {
    if (!instruction?.trim()) return { ok: false, reason: "tell me what to change" };
    return applyEdit(userId, runId, instruction.trim());
  }
  return { ok: false, reason: "unknown action" };
}
