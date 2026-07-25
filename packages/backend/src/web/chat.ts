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
import { streamingChannel, toolLabel, type Emit } from "./stream.js";

/** One steady-state chat turn: bounded multi-tool loop, capture, final reply. */
export async function runWebChatTurn(user: User, text: string): Promise<{ messages: string[] }> {
  // Chat tools (connect, schedule, refresh diagnosis) may enqueue jobs.
  await ensureBoss();
  const { channel, messages } = collectingChannel();
  const result = await converseWithUser(user.id, text, { executeTool: chatToolExecutor(user, channel) });
  await deliverTurnOutput(user, text, result, channel);
  return { messages };
}

/**
 * The same turn, streamed. Identical brain, identical tool code path — the only
 * differences are that the Channel forwards each utterance as it happens instead
 * of collecting it, and the tool executor is wrapped so every tool call announces
 * itself first ("Searching everything you've told me").
 *
 * That wrapper is why the activity list is trustworthy: the label comes from the
 * tool the model actually invoked, written by us, before the tool runs — not from
 * model narration, which under enforced structured output frequently isn't there.
 */
export async function runWebChatTurnStreaming(user: User, text: string, emit: Emit): Promise<void> {
  await ensureBoss();
  const channel = streamingChannel(emit);
  const execute = chatToolExecutor(user, channel);

  emit({ type: "stage", label: "Thinking it through" });

  const result = await converseWithUser(user.id, text, {
    executeTool: async (tool, replyBeat) => {
      emit({ type: "stage", label: toolLabel(tool.name) });
      return execute(tool, replyBeat);
    },
  });
  await deliverTurnOutput(user, text, result, channel);
  emit({ type: "result" });
}
