export type DistributionStepType = "primary_publish" | "secondary_channel" | "founder_amplification" | "team_amplification" | "partner_seeding" | "community_placement" | "sales_reuse" | "resurface";

export interface DistributionStepView {
  id: string;
  assetId: string | null;
  assetTitle: string | null;
  assetType: string | null;
  campaignId: string | null;
  campaignName: string | null;
  stepType: DistributionStepType;
  status: "recommended" | "planned" | "scheduled" | "completed" | "skipped";
  instructions: string;
  scheduledAt: string | null;
  completedAt: string | null;
}

export interface CampaignView { id:string;name:string;objective:string;status:"draft"|"active"|"completed"|"archived";startAt:string;endAt:string|null; }

export interface ConversionActionView {
  id: string;
  name: string;
  actionType: string;
  destination: string;
  commitmentLevel: "low" | "medium" | "high";
  status: string;
  trackedUrl?: string;
}

export interface ConversionEventView {
  id: string;
  actionName: string;
  assetTitle: string | null;
  eventType: string;
  influenceKind: "observed" | "influenced";
  value: number | null;
  currency: string | null;
  occurredAt: string;
}
