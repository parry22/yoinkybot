import type { Api, Transformer } from "grammy";
import { query, queryOne } from "../db/pool.js";
import { findUserIdByTelegramId } from "../lib/auth.js";

/**
 * Telegram gives bots no "list messages in a chat" API, so actually clearing
 * the visible chat when a user wipes their account requires tracking every
 * message_id as it happens. This module is that tracking: one row per message
 * (in or out), plus the batch-delete sweep run before wiping the DB.
 */

export async function recordMessage(userId: string, chatId: number, messageId: number): Promise<void> {
  try {
    await query(`INSERT INTO telegram_messages (user_id, chat_id, message_id) VALUES ($1,$2,$3)`, [
      userId,
      chatId,
      messageId,
    ]);
  } catch (err) {
    console.error("message-log: failed to record message", err);
  }
}

/**
 * Global outgoing-API transformer: every Bot API call that returns a `Message`
 * (sendMessage, sendVoice, editMessageText that returns a Message, …) gets its
 * chat_id + message_id recorded. Filtering on "does the response carry a
 * message_id" - rather than a hardcoded method list - means any future
 * send-shaped call is covered automatically, and non-message calls
 * (answerCallbackQuery, setMyCommands, getFile, …) are naturally skipped.
 * Registered once on `bot.api.config`; grammY re-applies it to every per-update
 * Api instance (ctx.api) automatically, so this also covers direct `bot.api.*`
 * calls made from job/worker code with no ctx in scope.
 */
export const trackOutgoingMessages: Transformer = async (prev, method, payload, signal) => {
  const result = await prev(method, payload, signal);
  try {
    const msg = (result as { ok: boolean; result?: unknown }).result as
      | { message_id?: number; chat?: { id?: number } }
      | undefined;
    if (result.ok && msg && typeof msg.message_id === "number" && typeof msg.chat?.id === "number") {
      const userId = await findUserIdByTelegramId(msg.chat.id);
      if (userId) await recordMessage(userId, msg.chat.id, msg.message_id);
    }
  } catch (err) {
    console.error("message-log: outgoing capture failed", err);
  }
  return result;
};

/** Split an array into chunks of at most `size` - deleteMessages caps at 100 ids/call. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const DELETE_BATCH_SIZE = 100;

/**
 * Best-effort delete of every tracked message in this user's chat(s). Chunks
 * into batches of 100 (the API limit); if a batch call itself fails (e.g. one
 * stale id in it), falls back to deleting that batch's messages one at a time
 * so a single bad id can't sink the rest. Never throws - the wipe must still
 * hit the DB even if Telegram deletion is partial (message too old, chat gone).
 */
export async function deleteAllTrackedMessages(api: Api, userId: string): Promise<{ attempted: number; deleted: number }> {
  const rows = await query<{ chat_id: string; message_id: string }>(
    `SELECT chat_id::text, message_id::text FROM telegram_messages WHERE user_id = $1`,
    [userId],
  );
  const byChat = new Map<string, number[]>();
  for (const r of rows) {
    const ids = byChat.get(r.chat_id) ?? [];
    ids.push(Number(r.message_id));
    byChat.set(r.chat_id, ids);
  }

  let deleted = 0;
  for (const [chatId, ids] of byChat) {
    for (const batch of chunk(ids, DELETE_BATCH_SIZE)) {
      try {
        await api.deleteMessages(chatId, batch);
        deleted += batch.length;
      } catch {
        for (const id of batch) {
          try {
            await api.deleteMessage(chatId, id);
            deleted++;
          } catch {
            // message already gone / too old to delete - best effort, move on
          }
        }
      }
    }
  }
  return { attempted: rows.length, deleted };
}

export async function clearMessageLog(userId: string): Promise<void> {
  await query(`DELETE FROM telegram_messages WHERE user_id = $1`, [userId]);
}

/** Read-only lookup used by tests only - not exercised in the hot path. */
export async function trackedMessageCount(userId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(`SELECT count(*)::text n FROM telegram_messages WHERE user_id = $1`, [userId]);
  return Number(row?.n ?? 0);
}
