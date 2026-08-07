export interface EditorialTerritoryView {
  id: string;
  name: string;
  audienceProblem: string | null;
  companyPerspective: string | null;
  commercialRelevance: string | null;
  proofRequirements: string | null;
  recurringFormats: string[];
  topicsToAvoid: string[];
  status: "draft" | "active" | "archived";
}

export interface NarrativeSystemView {
  id: string;
  workspaceId: string;
  version: number;
  status: "draft" | "active" | "superseded" | "archived";
  categoryThesis: string;
  problemNarrative: string;
  pointOfView: string;
  uniqueMechanism: string;
  primaryPromise: string;
  approvedAt: string | null;
  territories: EditorialTerritoryView[];
}

export interface NarrativeFields {
  categoryThesis: string;
  problemNarrative: string;
  pointOfView: string;
  uniqueMechanism: string;
  primaryPromise: string;
}

export interface WorkspaceAudienceView {
  id: string;
  name: string;
  roleType: string;
  description: string | null;
  needs: string[];
  objections: string[];
  successDefinition: string | null;
}

export interface BuyerJourneyQuestionView {
  id: string;
  audienceId: string | null;
  audienceName: string | null;
  stage: string;
  question: string;
  priority: number;
  status: "open" | "covered" | "archived";
}

export interface NarrativeMessageView {
  id: string;
  narrativeSystemId: string;
  messageType: string;
  audienceName: string | null;
  problem: string | null;
  newInsight: string | null;
  mechanism: string | null;
  evidenceSummary: string | null;
  desiredAction: string | null;
  status: "draft" | "active" | "archived";
}

export interface ClaimRegistryView {
  id: string;
  knowledgeObjectId: string;
  claimText: string;
  riskLevel: "low" | "medium" | "high" | "regulated";
  approvalStatus: "pending" | "approved" | "rejected" | "prohibited";
  evidenceRequirements: string | null;
  evidenceObjectIds: string[];
  allowedContexts: string[];
  prohibitedContexts: string[];
  approvedAt: string | null;
  expiresAt: string | null;
}

export interface NarrativeArchitectureView {
  audiences: WorkspaceAudienceView[];
  journeyQuestions: BuyerJourneyQuestionView[];
  messages: NarrativeMessageView[];
  claims: ClaimRegistryView[];
}
