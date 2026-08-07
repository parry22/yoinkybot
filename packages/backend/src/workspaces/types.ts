export const WORKSPACE_ROLES = ["owner", "admin", "strategist", "editor", "contributor", "viewer"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type WorkspaceType = "personal" | "company";
export type ExpertType = "founder" | "executive" | "product" | "engineering" | "sales" | "customer_success" | "marketing" | "external_expert" | "other" | "subject_matter_expert" | "customer" | "partner";

export interface WorkspaceSummary {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  slug: string;
  workspaceType: WorkspaceType;
  description: string | null;
  primaryObjective: string | null;
  primaryObjectiveKey: string | null;
  industry: string | null;
  website: string | null;
  role: WorkspaceRole;
  active: boolean;
  defaultExpertId: string | null;
  defaultExpertName: string | null;
}

export interface WorkspaceContext extends WorkspaceSummary {
  userId: string;
}

export interface ExpertView {
  id: string;
  workspaceId: string;
  linkedUserId: string | null;
  name: string;
  title: string | null;
  expertType: ExpertType;
  bio: string | null;
  isDefault: boolean;
  isPublicVoice: boolean;
}

export interface CreateCompanyWorkspaceInput {
  name: string;
  description?: string | null;
  primaryObjective?: string | null;
  primaryObjectiveKey?: string | null;
  industry?: string | null;
  website?: string | null;
  founderName?: string | null;
  founderTitle?: string | null;
}

export interface WorkspaceMemberView { userId:string;email:string|null;role:WorkspaceRole;joinedAt:string; }
export interface WorkspaceSourceView { id:string;name:string;sourceType:string;permissionLevel:string;status:string;lastIngestedAt:string|null; }
export interface WorkspaceAdminView { id:string;name:string;organizationName:string;workspaceType:WorkspaceType;description:string|null;primaryObjective:string|null;primaryObjectiveKey:string|null;industry:string|null;website:string|null;role:WorkspaceRole;telegramDelivery:boolean;members:WorkspaceMemberView[];experts:ExpertView[];sources:WorkspaceSourceView[]; }
export interface WorkspaceHomeView { recentKnowledge:Array<{id:string;title:string;objectType:string;status:string}>;briefsNeedingApproval:number;assetsInProduction:number;upcomingPublications:Array<{id:string;title:string;platform:string;scheduledFor:string}>;recentConversions:Array<{id:string;eventType:string;assetTitle:string|null;occurredAt:string}>;nextAction:{label:string;description:string;href:string}; }
