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
  createLoginToken,
  consumeLoginToken,
} from "./lib/auth.js";

// Conversational brain (chat + onboarding), web-flavored
export {
  runWebChatTurn,
  initWebOnboarding,
  runWebOnboardingTurn,
  skipOnboardingStep,
  skipOnboardingAll,
  type OnboardingTurn,
} from "./web/chat.js";

// Strategist state + stated profile
export { getStage, getState } from "./strategist/state.js";
export { getProfile } from "./strategist/profile.js";
export type { BrandProfile } from "./strategist/profile.js";

// Diagnosis, plan, beliefs (read models for the panels)
export { currentDiagnosis } from "./strategist/diagnosis.js";
export type { Diagnosis } from "./strategist/diagnosis.js";
export { getPlan } from "./strategist/plan.js";
export type { PlanView } from "./strategist/plan.js";
export { activePositions } from "./memory/positions.js";
export type { Position } from "./memory/positions.js";

// Connect + ship (draft) + their read models
export {
  runWebConnect,
  runWebDraft,
  listDrafts,
  listConnectedAccounts,
  type DraftRow,
  type ConnectedAccountRow,
} from "./web/actions.js";

// Chat history for hydrating the transcript
export { loadChatHistory, type ChatHistoryEntry } from "./web/chat-history.js";

// Scheduled posts (read model for the Scheduled screen)
export { listScheduled, type ScheduledPost } from "./scheduling/service.js";

export { config } from "./config.js";
