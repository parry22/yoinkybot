/**
 * The web app's entry point into the backend. `packages/web` imports domain
 * functions from here (`@yoink/backend/web`) and calls them in-process, sharing
 * the same Postgres. This barrel keeps that surface explicit — nothing here
 * starts the Fastify server or the Telegram bot (that's `index.ts`).
 */

// Auth + identity
export type { User } from "./lib/auth.js";
export {
  userForSession,
  createSession,
  findOrCreateUserByEmail,
  findOrCreateUserByXId,
  findUserByClerkId,
  findOrCreateUserByClerkId,
  createLoginToken,
  consumeLoginToken,
  createTelegramLinkToken,
} from "./lib/auth.js";

// Trial + billing (7-day free trial → Dodo subscription-with-trial → self-serve portal)
export {
  trialInfo,
  billingOverview,
  startTrial,
  setIntendedPlan,
  entitlementsFor,
  isPaidOrExempt,
  withinCap,
  remainingFor,
  type TrialInfo,
  type BillingOverview,
  type Entitlements,
  type Plan,
} from "./billing/entitlements.js";
export { createCheckout, createCustomerPortal } from "./billing/dodo.js";
// Read model for the Settings/Scheduled cap display.
export { scheduledStatus, type ScheduledStatus } from "./scheduling/service.js";

// "Sign in with X" / "Connect X" finalizer + status (web runs the OAuth itself)
export { finalizeXConnect, getXConnectStatus, type XConnectStatus } from "./web/x-signin.js";

// Conversational brain, web-flavored
export { runWebChatTurn } from "./web/chat.js";

// Strategist state + stated profile
export { getStage, getState } from "./strategist/state.js";
export { getProfile, PROFILE_FIELDS, GOAL_OPTIONS, TONE_TAXONOMY } from "./strategist/profile.js";
export type { BrandProfile, ProfileField } from "./strategist/profile.js";

// Structured onboarding form (web wizard + Settings profile editor)
export {
  submitProfileForm,
  skipProfileFields,
  profileCompletionFields,
  type ProfileFormFields,
} from "./web/onboarding-form.js";

// Inspiration feed (Trends & Virals — read models over delivered surfacings)
export {
  listTrendInspiration,
  listViralInspiration,
  refreshInspirationForWeb,
  type TrendInspiration,
  type ViralInspiration,
} from "./web/inspiration.js";

// Buyer Radar (find in-market prospects, draft approval-only replies)
export {
  listBuyerSignals,
  buyerRadarStatus,
  getBuyerIcp,
  buyerIcpPrefill,
  saveBuyerIcp,
  scanBuyerSignals,
  setBuyerSignalVerdict,
  type BuyerSignalView,
  type BuyerRadarStatus,
  type BuyerIcpView,
  type ScanResponse,
} from "./web/buyers-radar.js";

// Diagnosis, plan, beliefs (read models for the panels)
export { currentDiagnosis } from "./strategist/diagnosis.js";
export type { Diagnosis } from "./strategist/diagnosis.js";
export { getPlan } from "./strategist/plan.js";
export type { PlanView } from "./strategist/plan.js";

// Growth — gamified board fusing diagnosis + plan into next-best-actions
export {
  getGrowthState,
  type GrowthState,
  type GrowthQuest,
  type GrowthMilestone,
  type ScorePart,
} from "./web/growth.js";
export { activePositions } from "./memory/positions.js";
export type { Position } from "./memory/positions.js";

// Ship (draft) + read models
export {
  runWebDraft,
  listDrafts,
  listConnectedAccounts,
  type DraftRow,
  type ConnectedAccountRow,
} from "./web/actions.js";

// X analytics
export {
  getAnalytics,
  getReplyAnalytics,
  type AnalyticsData,
  type AnalyticsPost,
  type HeatCell,
  type FormatStat,
  type WeeklyPoint,
  type YoinkImpact,
  type AgentScorecard,
  type ReplyAnalytics,
} from "./web/analytics.js";

// Automations (multi-automation "auto agent", replaces the single autopilot)
export {
  listAutomationsForWeb,
  getAutomationForWeb,
  saveAutomationFromWeb,
  setAutomationEnabledWeb,
  runAutomationOnceWeb,
  listPendingApprovalsWeb,
  listAutomationRunsWeb,
  actOnRunWeb,
  type AutomationView,
  type PendingApprovalView,
  type RunView,
} from "./web/automations.js";

// Chat history for hydrating the transcript
export { loadChatHistory, type ChatHistoryEntry } from "./web/chat-history.js";

// Scheduled posts (read model for the Scheduled screen)
export { listScheduled, type ScheduledPost } from "./scheduling/service.js";
export { createWebScheduledPost } from "./web/scheduled.js";

// Content moderation (shared gate; ModerationError → 400 at the web boundary)
export { moderateText, assertClean, ModerationError, MODERATION_MESSAGE } from "./moderation/filter.js";

export { config } from "./config.js";
