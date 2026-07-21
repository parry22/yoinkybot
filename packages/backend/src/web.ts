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
  createLoginToken,
  consumeLoginToken,
  createTelegramLinkToken,
} from "./lib/auth.js";

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
  type ReplyAnalytics,
} from "./web/analytics.js";

// Agent (auto) mode
export {
  getAgentState,
  getAgentEnabled,
  setAgentEnabled,
  runAgentCycle,
  type AgentState,
  type AgentCycleResult,
} from "./web/agent.js";

// Chat history for hydrating the transcript
export { loadChatHistory, type ChatHistoryEntry } from "./web/chat-history.js";

// Scheduled posts (read model for the Scheduled screen)
export { listScheduled, type ScheduledPost } from "./scheduling/service.js";

export { config } from "./config.js";
