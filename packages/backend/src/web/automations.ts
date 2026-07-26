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
import { automationStageLabel, type Emit } from "./stream.js";
import { approveRun, rejectRun, applyEdit } from "../automations/approval.js";
import {
  runInterviewTurn,
  specToAutomationInput,
  describeSpec,
  BRIEF_MAX,
  type InterviewMessage,
} from "../automations/interview.js";
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
  const ent = await entitlementsFor(userId);
  if (clean.delivery_mode === "auto" && !ent.autoAgent) {
    throw new ModerationError("Hands-off auto mode is a Scale feature — pick “Asks you first”, or upgrade to Scale.");
  }
  // Clamp the per-automation "Cap / month" to the plan ceiling so the form can
  // never promise more than the plan will actually deliver. The run pipeline
  // enforces the plan cap regardless; this just keeps the number honest on screen.
  if (ent.automationPostsPerMonth !== null) {
    const requested = clean.monthly_cap ?? config.AUTOMATION_DEFAULT_MONTHLY_CAP;
    clean.monthly_cap = Math.min(requested, ent.automationPostsPerMonth);
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

/**
 * Create/update an automation from the Auto Agent composer, streaming its steps.
 * The work is the same `saveAutomationFromWeb`; the stages exist because "type a
 * brief, press send" should read like the agent doing something rather than a
 * button that hangs. Labels are ours, emitted around the real steps.
 */
export async function saveAutomationStreaming(
  userId: string,
  input: AutomationFormInput,
  emit: Emit,
  id?: string,
): Promise<void> {
  emit({ type: "stage", label: "Reading your brief" });
  emit({ type: "stage", label: "Checking your plan and caps" });
  const view = await saveAutomationFromWeb(userId, input, id);
  emit({ type: "stage", label: id ? "Updating the agent" : "Setting up the agent" });
  emit({
    type: "message",
    text: id
      ? `Updated **${view.name}** — ${DELIVERY_COPY[view.deliveryMode]}, ${CADENCE_COPY[view.cadenceKind]}, up to ${view.monthlyCap} posts a month.`
      : `**${view.name}** is live — ${DELIVERY_COPY[view.deliveryMode]}, ${CADENCE_COPY[view.cadenceKind]}, up to ${view.monthlyCap} posts a month. Run it now, or leave it to its schedule.`,
  });
  emit({ type: "result", data: { automation: view } });
}

/**
 * One turn of the Auto Agent setup conversation, streamed.
 *
 * The interview replaced a form whose three preset pills sat in the UI before the
 * user had said anything (see automations/interview.ts for why that was the
 * problem). It is stateless: the client sends the whole transcript back each turn.
 *
 * When the interview completes, this does the last two things in one go — builds
 * the agent AND runs it once immediately. That matters: an agent you have to
 * remember to go and press "run" on is a config screen, not an agent. The first
 * run also surfaces a real draft while the user is still on the page, so a
 * misread brief is caught now rather than at 9am tomorrow.
 */
export async function runAutomationInterviewStreaming(
  userId: string,
  messages: InterviewMessage[],
  emit: Emit,
): Promise<void> {
  const turn = await runInterviewTurn(userId, messages);

  if (!turn.complete) {
    emit({ type: "message", text: turn.reply });
    emit({ type: "result", data: { complete: false, options: turn.options, spec: turn.spec } });
    return;
  }

  emit({ type: "message", text: turn.reply });
  emit({ type: "stage", label: "Setting up the agent" });

  const input = specToAutomationInput(turn.spec);
  let view: AutomationView;
  try {
    view = await saveAutomationFromWeb(userId, input);
  } catch (err) {
    if (err instanceof ModerationError) {
      emit({ type: "error", message: err.reason });
      return;
    }
    console.error("automation interview save failed", err);
    emit({ type: "error", message: "Couldn't set that agent up — try again." });
    return;
  }

  emit({
    type: "message",
    text: `**${view.name}** is live — ${describeSpec(turn.spec)}, up to ${view.monthlyCap} posts a month.`,
  });

  // Fire it once now. A failure here is NOT a setup failure: the agent exists and
  // its schedule stands, so the honest report is "built, but the first run found
  // nothing" rather than an error that implies nothing was created.
  emit({ type: "stage", label: "Running it once to show you" });
  try {
    const res = await runAutomationOnce(
      (await getAutomation(view.id, userId))!,
      { manual: true, onStage: (s) => emit({ type: "stage", label: automationStageLabel(s) }) },
    );
    if (res.status === "awaiting_approval") {
      emit({ type: "message", text: "First one's drafted and waiting for your approval above." });
    } else if (res.status === "scheduled") {
      emit({ type: "message", text: "First one's drafted and queued to post." });
    } else {
      emit({
        type: "message",
        text: `Agent's set up. Its first run found nothing to post yet${res.reason ? ` (${res.reason})` : ""} — it'll pick things up on its schedule.`,
      });
    }
  } catch (err) {
    console.error("automation interview first run failed", err);
    emit({ type: "message", text: "Agent's set up. Its first run didn't complete — hit Run now to retry." });
  }

  emit({ type: "result", data: { complete: true, automation: view, spec: turn.spec } });
}

/** Plain-language echo of the config, so the agent confirms what it just built. */
const DELIVERY_COPY: Record<string, string> = {
  approval: "it'll ask you before anything goes out",
  auto: "it posts on its own",
};
const CADENCE_COPY: Record<string, string> = {
  daily: "checking daily",
  weekly: "checking weekly",
  manual: "only when you run it",
};

/** One "run it now", streamed with its pipeline stages. */
export async function runAutomationOnceStreaming(userId: string, id: string, emit: Emit): Promise<void> {
  const a = await getAutomation(id, userId);
  if (!a) {
    emit({ type: "error", message: "That agent no longer exists." });
    return;
  }
  const res = await runAutomationOnce(a, {
    manual: true,
    onStage: (s) => emit({ type: "stage", label: automationStageLabel(s) }),
  });
  if (res.status === "awaiting_approval") {
    emit({ type: "message", text: "Drafted — it's waiting in your approvals." });
  } else if (res.status === "scheduled") {
    emit({ type: "message", text: "Drafted and queued to post." });
  } else {
    emit({ type: "message", text: res.reason ?? "Nothing to post right now." });
  }
  emit({ type: "result", data: { status: res.status, reason: res.reason } });
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
