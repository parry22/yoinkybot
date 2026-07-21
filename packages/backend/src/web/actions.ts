/**
 * Web wrappers for the "ship" part of the loop - same bot logic (entitlements,
 * allowance, persistence), collected into a JSON-friendly shape. Connecting an
 * account is handled by the OAuth flow (routes/oauth.ts) directly, not here -
 * see `web/oauth-connect.ts` for the web-facing helper.
 */
import type { User } from "../lib/auth.js";
import { runDraft } from "../telegram/actions.js";
import { query } from "../db/pool.js";
import { collectingChannel } from "./channel.js";

/** Generate + persist a draft in the user's voice. Respects the paywall/allowance. */
export async function runWebDraft(
  user: User,
  platform: "x" | "linkedin",
  topic: string,
): Promise<{ messages: string[] }> {
  const { channel, messages } = collectingChannel();
  await runDraft(user, topic, platform, channel);
  return { messages };
}

export interface DraftRow {
  id: string;
  content: string;
  platform: string;
  note: string;
  created_at: string;
}

export async function listDrafts(userId: string, limit = 20): Promise<DraftRow[]> {
  return query<DraftRow>(
    `SELECT id, content, platform, note, created_at::text AS created_at
     FROM drafts WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
}

export interface ConnectedAccountRow {
  platform: string;
  handle: string;
  status: string;
  post_count: number;
  last_ingested_at: string | null;
}

export async function listConnectedAccounts(userId: string): Promise<ConnectedAccountRow[]> {
  return query<ConnectedAccountRow>(
    `SELECT platform, handle, status, post_count, last_ingested_at::text AS last_ingested_at
     FROM connected_accounts WHERE user_id = $1 ORDER BY platform`,
    [userId],
  );
}
