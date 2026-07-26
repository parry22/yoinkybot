import type { Channel } from "../telegram/actions.js";

/**
 * Live progress for the web surfaces (§3i). The bot's affordance for "I'm working"
 * is a sequence of Telegram messages plus a typing indicator; the web needs the
 * same information as discrete events so it can render an activity list while the
 * agent works, instead of a silent spinner.
 *
 * The seam is the existing `Channel`. `collectingChannel()` pushes what the agent
 * says into an array; `streamingChannel()` hands each utterance to a callback the
 * moment it happens. Nothing in `converseWithUser` / `runDraft` /
 * `runAutomationOnce` changes — they already talk to a Channel.
 *
 * IMPORTANT (learned the hard way in the SDK migration): the labels are OURS, not
 * the model's. Under enforced structured output the model does not reliably narrate
 * between tool calls, which is why the chat layer needs deterministic `TOOL_BEATS`
 * at all. So every stage label here is written by code — never parsed out of model
 * output — and is therefore always present and always accurate about *which* step
 * is running.
 */

export type AgentEvent =
  /** A step the agent has just started. Render as an activity row. */
  | { type: "stage"; label: string }
  /** Something the agent said to the user — a real transcript message. */
  | { type: "message"; text: string }
  /** Terminal success, with whatever payload the caller needs. */
  | { type: "result"; data?: unknown }
  /** Terminal failure, already in user-facing language. */
  | { type: "error"; message: string };

export type Emit = (event: AgentEvent) => void;

/**
 * A Channel that forwards each utterance as a `message` event instead of
 * collecting it. `typing()` is a no-op: the web renders progress from explicit
 * `stage` events, which say what is happening rather than just that something is.
 */
export function streamingChannel(emit: Emit): Channel {
  return {
    say: async (text: string) => {
      if (text && text.trim()) emit({ type: "message", text });
    },
    typing: async () => {},
  };
}

/** Human labels for the chat tools, so the activity list reads like intent. */
const TOOL_LABELS: Record<string, string> = {
  draft_post: "Writing a post in your voice",
  repurpose: "Reshaping it for the platform",
  search_memory: "Searching everything you've told me",
  find_trends: "Searching X and the web for what's live",
  offer_angles: "Working out angles you could take",
  check_draft: "Checking it against your positions",
  show_plan: "Pulling up your plan",
  show_positions: "Reading your stated positions",
  show_status: "Checking where you are",
  refresh_diagnosis: "Re-reading your whole body of work",
  connect_account: "Connecting your account",
  schedule_post: "Queuing it for later",
  forget: "Finding what to delete",
  correct_classification: "Correcting how I read that",
  clear_everything: "Preparing a full reset",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? "Working on it";
}

/** Labels for `generateDraft`'s internal pipeline (drafting/draft.ts DraftStage). */
const DRAFT_STAGE_LABELS: Record<string, string> = {
  voice: "Loading your voice profile",
  memory: "Retrieving relevant memories",
  research: "Nothing of yours on this — searching X for what's live",
  evidence: "Reading what's actually worked for you",
  context: "Checking what's live on X right now",
  writing: "Writing the draft",
  polishing: "Polishing the phrasing",
};

export function draftStageLabel(stage: string): string {
  return DRAFT_STAGE_LABELS[stage] ?? "Working on it";
}

/** Labels for one automation run (automations/run.ts AutomationStage). */
const AUTOMATION_STAGE_LABELS: Record<string, string> = {
  caps: "Checking your monthly agent budget",
  select: "Picking what's worth posting",
  moderate: "Running the content check",
  drafting: "Writing it in your voice",
  delivering: "Sending it for your approval",
};

export function automationStageLabel(stage: string): string {
  return AUTOMATION_STAGE_LABELS[stage] ?? "Working on it";
}
