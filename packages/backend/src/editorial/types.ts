export interface ProductionHealth {
  captureToKnowledgeHours:number|null;
  briefToPublicationHours:number|null;
  approvalHours:number|null;
  assetsLast30Days:number;
  sourceUtilizationPct:number|null;
  repurposingRatio:number|null;
  originalProofPct:number|null;
}
export interface KnowledgePerformanceRow { id:string;title:string;objectType:string;assetCount:number;publicationCount:number;conversionCount:number;influencedValue:number;activation:"unused"|"active"|"overused"; }
export interface TerritoryPerformanceRow { id:string;name:string;assetCount:number;publicationCount:number;conversionCount:number;influencedValue:number; }
export interface SourceUtilizationRow { id:string;name:string;sourceType:string;knowledgeCount:number;usedKnowledgeCount:number;assetCount:number; }
export interface KnowledgeTypeSummary { objectType:string;objectCount:number;assetCount:number;conversionCount:number;unusedCount:number; }
export interface ConversionRateRow { id:string;name:string;publications:number;conversions:number;rate:number|null; }
export interface EditorialReviewView { id:string;periodStart:string;periodEnd:string;summary:string;winningTerritories:string[];weakTerritories:string[];winningKnowledgeObjects:string[];commercialNotes:string[];recommendedActions:string[];createdAt:string; }
export interface WorkspaceIntelligenceView { production:ProductionHealth;knowledge:KnowledgePerformanceRow[];knowledgeTypes:KnowledgeTypeSummary[];territories:TerritoryPerformanceRow[];sources:SourceUtilizationRow[];ctaRates:ConversionRateRow[];territoryRates:ConversionRateRow[];audienceQuality:{verifiedIdentities:number;inferredInteractions:number;note:string};commercial:{events:number;influencedLeads:number;influencedOpportunities:number;influencedRevenue:number;currency:string|null};reviews:EditorialReviewView[]; }
