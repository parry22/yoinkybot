export interface ContentBriefView {
  id: string;
  workspaceId: string;
  objective: string;
  audienceId: string;
  audienceName: string;
  buyingStage: string;
  territoryName: string | null;
  supportingClaim: string;
  primaryProof: string;
  desiredBeliefShift: string;
  channel: "x" | "linkedin";
  format: string;
  primaryEmotion: string | null;
  reasonNow: string | null;
  ctaText: string | null;
  campaignName: string | null;
  status: "idea" | "draft" | "ready" | "in_production" | "completed" | "archived";
  sourceCount: number;
}

export type AssetStatus = "draft" | "needs_review" | "approved" | "scheduled" | "published" | "rejected" | "archived";

export const CONTENT_ASSET_TYPES = [
  "x_post",
  "linkedin_post",
  "short_video_script",
  "youtube_video_script",
  "newsletter_section",
  "blog_outline",
  "sales_enablement",
  "carousel_outline",
  "community_prompt",
  "reddit_post",
  "email",
  "slides_outline",
  "landing_page_section",
] as const;
export type ContentAssetType = (typeof CONTENT_ASSET_TYPES)[number];

export interface AssetCheckResult {
  status: "clear" | "position_conflict" | "narrative_drift" | "unsupported_claim" | "prohibited_claim" | "confidential_source" | "intentional_evolution";
  issues: string[];
  checkedAt: string;
}

export interface ContentAssetView {
  id: string;
  workspaceId: string;
  briefId: string;
  assetType: ContentAssetType;
  parentAssetId: string | null;
  title: string;
  status: AssetStatus;
  content: string;
  version: number;
  checks: AssetCheckResult | null;
  sourceCount: number;
  createdAt: string;
}
