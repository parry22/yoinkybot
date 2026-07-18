import { query } from "../db/pool.js";

export interface ChatHistoryEntry {
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

/** Recent chat transcript for a user, oldest-first, for hydrating the web UI. */
export async function loadChatHistory(userId: string, limit = 60): Promise<ChatHistoryEntry[]> {
  const rows = await query<ChatHistoryEntry>(
    `SELECT role, content, created_at::text AS created_at
     FROM chat_messages WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.reverse();
}
