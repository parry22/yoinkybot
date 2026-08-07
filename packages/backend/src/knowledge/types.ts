export const KNOWLEDGE_OBJECT_TYPES = [
  "insight", "claim", "proof", "story", "objection", "question", "framework",
  "capability", "customer_quote", "language_phrase", "market_signal",
] as const;

export const PERMISSION_LEVELS = [
  "public", "internal", "restricted", "confidential", "never_use_for_generation",
] as const;

export const WORKSPACE_SOURCE_TYPES = [
  "manual_text", "voice_note", "uploaded_transcript", "founder_interview",
  "x_history", "linkedin_history", "product_update", "customer_call",
  "sales_call", "support_item", "internal_document", "market_research",
] as const;

export type KnowledgeObjectType = (typeof KNOWLEDGE_OBJECT_TYPES)[number];
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
export type WorkspaceSourceType = (typeof WORKSPACE_SOURCE_TYPES)[number];
export type KnowledgeStatus = "proposed" | "reviewed" | "approved" | "rejected" | "archived";

export interface KnowledgeObjectView {
  id: string;
  workspaceId: string;
  objectType: KnowledgeObjectType;
  title: string;
  body: string;
  status: KnowledgeStatus;
  confidence: number;
  permissionLevel: PermissionLevel;
  sourceCaptureId: string;
  sourceId: string;
  sourceName: string;
  speakerName: string | null;
  speakerExpertId: string | null;
  audienceIds: string[];
  territoryIds: string[];
  buyingStage: string | null;
  commercialRelevance: string | null;
  createdAt: string;
}

export interface TranscriptInput {
  title: string;
  transcript: string;
  sourceType?: WorkspaceSourceType;
  speakerExpertId?: string | null;
  permissionLevel?: PermissionLevel;
  /** Internal pipeline hook for an already-created voice or integration capture. */
  existingCaptureId?: string;
}
