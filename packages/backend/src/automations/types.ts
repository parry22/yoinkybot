/** Domain types for the multi-automation system (§3l). Types only. */

export type SourceType = "trend_ride" | "unlock_backlog" | "custom";
export type DeliveryMode = "approval" | "auto";
export type CadenceKind = "daily" | "weekly" | "manual";
export type RunStatus =
  | "drafting"
  | "awaiting_approval"
  | "approved"
  | "scheduled"
  | "posted"
  | "rejected"
  | "edited"
  | "failed"
  | "skipped"
  /** An approval nobody answered, aged out by the reaper — see store.expireStaleApprovals. */
  | "expired";

export interface Automation {
  id: string;
  user_id: string;
  profile_id: string;
  name: string;
  source_type: SourceType;
  delivery_mode: DeliveryMode;
  platform: "x" | "linkedin";
  enabled: boolean;
  cadence_kind: CadenceKind;
  cadence_meta: { days?: string[]; hour?: number } & Record<string, unknown>;
  respect_quiet_hours: boolean;
  monthly_cap: number;
  pillar_scope: string[] | null;
  /** Free-text instruction: the seed for 'custom', extra guidance for presets. */
  brief: string | null;
  warmup_count: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  user_id: string;
  status: RunStatus;
  source_ref: Record<string, unknown> | null;
  draft_body: string | null;
  media_suggestion: string | null;
  agent_steps: unknown;
  scheduled_post_id: string | null;
  verdict_reason: string | null;
  edit_count: number;
  created_at: string;
  updated_at: string;
}
