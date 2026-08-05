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
import { streamingChannel, toolLabel, draftStageLabel, type Emit } from "./stream.js";
import { runAsUser } from "../byok/context.js";

/** One steady-state chat turn: bounded multi-tool loop, capture, final reply. */
export async function runWebChatTurn(user: User, text: string): Promise<{ messages: string[] }> {
  // Chat tools (connect, schedule, refresh diagnosis) may enqueue jobs.
  await ensureBoss();
  const { channel, messages } = collectingChannel();
  // Ambient BYOK identity - same as the Telegram turn (telegram/turns.ts).
  await runAsUser(user.id, async () => {
    const result = await converseWithUser(user.id, text, { executeTool: chatToolExecutor(user, channel) });
    await deliverTurnOutput(user, text, result, channel);
  });
  return { messages };
}

/**
 * The same turn, streamed. Identical brain, identical tool code path - the only
 * differences are that the Channel forwards each utterance as it happens instead
 * of collecting it, and the tool executor is wrapped so every tool call announces
 * itself first ("Searching everything you've told me").
 *
 * That wrapper is why the activity list is trustworthy: the label comes from the
 * tool the model actually invoked, written by us, before the tool runs - not from
 * model narration, which under enforced structured output frequently isn't there.
 */
export async function runWebChatTurnStreaming(user: User, text: string, emit: Emit): Promise<void> {
  await ensureBoss();
  // Tracks whether anything at all has reached the user this turn. A turn that
  // ends having said nothing is the "it just sits there" failure - the activity
  // rows tick over, the last one finishes, and the transcript never gains a line,
  // so the page looks frozen at exactly the moment the work finished. The tail
  // below guarantees a closing message rather than trusting the model to produce
  // one (under structured output it frequently returns reply:"").
  let said = false;
  const spoke: Emit = (event) => {
    if (event.type === "message" && event.text.trim()) said = true;
    emit(event);
  };
  const channel = streamingChannel(spoke);
  // Drafting is the slowest thing a turn can do (retrieval, sometimes live
  // research, then a long generation). Its internal stages are forwarded so that
  // wait reads as six specific steps rather than one unmoving "Writing a post".
  const execute = chatToolExecutor(user, channel, {
    onDraftStage: (stage) => emit({ type: "stage", label: draftStageLabel(stage) }),
  });

  emit({ type: "stage", label: "Thinking it through" });

  try {
    // Ambient BYOK identity, same as the non-streaming turn above.
    const result = await runAsUser(user.id, () =>
      converseWithUser(user.id, text, {
        executeTool: async (tool, replyBeat) => {
          emit({ type: "stage", label: toolLabel(tool.name) });
          return execute(tool, replyBeat);
        },
      }),
    );
    await runAsUser(user.id, () => deliverTurnOutput(user, text, result, channel));
    if (!said) {
      // Reached only when the model returned an empty reply AND no tool spoke.
      spoke({ type: "message", text: "that one came back empty on my side. say it again and i'll have another go?" });
    }
  } catch (err) {
    console.error("streamed chat turn failed mid-turn", err);
    // An error event still closes the UI's activity list, so the page never
    // stays stuck on a spinning row.
    emit({ type: "error", message: "That turn broke on my side - try again." });
    return;
  }
  emit({ type: "result" });
}
