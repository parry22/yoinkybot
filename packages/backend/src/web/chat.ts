/**
 * Web-facing wrapper around the same conversational brain the Telegram bot
 * uses. The bot delivers replies by sending Telegram messages through a
 * `Channel`; here we swap in a collecting channel that just gathers the text, so
 * an HTTP handler can return the turn's messages as JSON. All the real logic
 * (tool loop, capture) is shared, unchanged. (The web's onboarding intake is a
 * separate, structured form path - see `web/onboarding-form.ts` - not this
 * conversational one, which stays Telegram-only.)
 */
import type { User } from "../lib/auth.js";
import { converseWithUser } from "../telegram/conversation.js";
import { chatToolExecutor, deliverTurnOutput } from "../telegram/actions.js";
import { ensureBoss } from "../jobs/boss.js";
import { collectingChannel } from "./channel.js";

/** One steady-state chat turn: bounded multi-tool loop, capture, final reply. */
export async function runWebChatTurn(user: User, text: string): Promise<{ messages: string[] }> {
  // Chat tools (connect, schedule, refresh diagnosis) may enqueue jobs.
  await ensureBoss();
  const { channel, messages } = collectingChannel();
  const result = await converseWithUser(user.id, text, { executeTool: chatToolExecutor(user, channel) });
  await deliverTurnOutput(user, text, result, channel);
  return { messages };
}
