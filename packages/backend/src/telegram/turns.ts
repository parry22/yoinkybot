/**
 * Per-user turn serialization with burst merging.
 *
 * Two things break the "talking to a person" illusion without this:
 * 1. Concurrent turns — two quick messages run two LLM turns in parallel,
 *    racing chat history and strategist state (the session machine's
 *    read-modify-write on users.strategist_state is not concurrency-safe).
 * 2. Fragment replies — people type one thought as three messages. Answering
 *    each fragment separately reads like a bot; a person waits and answers the
 *    whole thought once.
 *
 * So: one turn runs per user at a time. Anything that arrives mid-turn is
 * buffered and merged (joined with newlines) into a single follow-up turn.
 * In-memory is correct here — the deploy is a single instance by design
 * (see docs/INTERNAL.md §1).
 */

import { runAsUser } from "../byok/context.js";

interface Slot<C> {
  pending?: { texts: string[]; carrier: C };
}

const running = new Map<string, Slot<unknown>>();

/** Max fragments merged into one turn; beyond this the rest are dropped with a log. */
const MAX_MERGED = 12;

export async function runSerializedTurn<C>(
  userId: string,
  text: string,
  carrier: C,
  handler: (mergedText: string, carrier: C) => Promise<void>,
): Promise<void> {
  const slot = running.get(userId) as Slot<C> | undefined;
  if (slot) {
    // A turn is in flight — buffer this message into the next one.
    if (!slot.pending) slot.pending = { texts: [], carrier };
    if (slot.pending.texts.length < MAX_MERGED) slot.pending.texts.push(text);
    else console.warn(`turn buffer full for user ${userId}; dropping a fragment`);
    slot.pending.carrier = carrier;
    return;
  }

  const mySlot: Slot<C> = {};
  running.set(userId, mySlot);
  let currentText = text;
  let currentCarrier = carrier;
  try {
    for (;;) {
      try {
        // Ambient BYOK identity for the whole turn: every tool the chat brain
        // reaches for underneath — drafts, searches, scrapes — resolves this
        // user's own keys rather than ours (byok/context.ts).
        await runAsUser(userId, () => handler(currentText, currentCarrier));
      } catch (err) {
        // The handler owns user-facing error replies; this is the last-resort
        // guard so one failed turn can't wedge the queue.
        console.error("serialized turn failed", err);
      }
      const next = mySlot.pending;
      if (!next) break;
      mySlot.pending = undefined;
      currentText = next.texts.join("\n");
      currentCarrier = next.carrier;
    }
  } finally {
    running.delete(userId);
  }
}

/** True if a turn is currently running for this user (used by tests). */
export function hasActiveTurn(userId: string): boolean {
  return running.has(userId);
}
