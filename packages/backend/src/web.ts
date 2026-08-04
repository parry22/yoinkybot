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
export { createCheckout, createCustomerPortal, type BuyablePlan } from "./billing/dodo.js";

// BYOK — the lifetime plan brings its own LLM + scraper keys, so their spend
// bills their account. `byokStatus().complete` is the gate the app checks before
// letting a lifetime user do anything (see web/src/lib/byok-gate.ts).
export {
  byokStatus,
  saveKey,
  deleteKey,
  KEY_PROVIDERS,
  type KeyProvider,
  type ByokStatus,
  type ByokKeyView,
} from "./byok/keys.js";
// Read model for the Settings/Scheduled cap display.
export { scheduledStatus, type ScheduledStatus } from "./scheduling/service.js";

// "Sign in with X" / "Connect X" finalizer + status (web runs the OAuth itself)
export {
  finalizeXConnect,
  finalizeLinkedInConnect,
  connectLinkedInProfileFromWeb,
  getXConnectStatus,
  type XConnectStatus,
} from "./web/x-signin.js";

// Conversational brain, web-flavored (+ the streamed variant the chat UI uses)
export { runWebChatTurn, runWebChatTurnStreaming } from "./web/chat.js";
export type { AgentEvent, Emit } from "./web/stream.js";

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
  // "Scan now" is enqueue + poll, not a synchronous call: SDK-mode composition
  // spawns a subprocess, which a Vercel function cannot host (§3n).
  enqueueBuyerScan,
  buyerScanProgress,
  setBuyerSignalVerdict,
  type BuyerSignalView,
  type BuyerRadarStatus,
  type BuyerIcpView,
  type ScanResponse,
  type BuyerScanTicket,
  type BuyerScanProgress,
  type BuyerScanJobState,
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
  saveAutomationStreaming,
  runAutomationOnceStreaming,
  // The setup conversation that replaced the preset-pill form: one turn per call,
  // stateless (the client sends the transcript back), and on the last turn it
  // builds the agent and runs it once.
  runAutomationInterviewStreaming,
  listPendingApprovalsWeb,
  listAutomationRunsWeb,
  actOnRunWeb,
  type AutomationView,
  type PendingApprovalView,
  type RunView,
} from "./web/automations.js";
export type { AgentSpec, InterviewMessage } from "./automations/interview.js";

// Chat history for hydrating the transcript
export { loadChatHistory, type ChatHistoryEntry } from "./web/chat-history.js";

// Scheduled posts (read model for the Scheduled screen)
export { listScheduled, cancelScheduled, containsLink, type ScheduledPost } from "./scheduling/service.js";
export { createWebScheduledPost } from "./web/scheduled.js";
// Scheduled-post media: the web route owns the Blob upload (it holds the token),
// then stages the row here; the publisher on Railway fetches the URL at post time.
export {
  stageMedia,
  discardStagedMedia,
  mediaReadiness,
  mediaForScheduledPosts,
  ACCEPTED_MEDIA_TYPES,
  MEDIA_LIMITS,
  type StagedMediaView,
  type MediaReadiness,
} from "./web/media.js";

// In-app feedback (Feature Request / Bug Report from the Account menu)
export { submitFeedback, type FeedbackType, type FeedbackInput } from "./web/feedback.js";

// Per-user burst rate limiting for the money-spending routes (see lib/rate-limit.ts).
// Sits under the paywall and above the monthly caps: the caps bound the month,
// this bounds the minute.
export {
  consumeRateLimit,
  rateLimitMessage,
  RATE_LIMITS,
  type RateLimitBucket,
  type RateLimitResult,
} from "./lib/rate-limit.js";

// Content moderation (shared gate; ModerationError → 400 at the web boundary)
export { moderateText, assertClean, ModerationError, MODERATION_MESSAGE } from "./moderation/filter.js";

export { config } from "./config.js";
