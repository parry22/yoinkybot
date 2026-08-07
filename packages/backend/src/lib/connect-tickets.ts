/**
 * Connect tickets - the thing that replaced `?u=<user id>` on
 * `/oauth/:platform/start`.
 *
 * WHY. That route is UNAUTHENTICATED by necessity: it's the first hop of a
 * browser OAuth handshake, opened from a Telegram button, with no session to
 * read. It used to take the raw `users.id` in the query string, on the reasoning
 * that a UUID isn't enumerable. But non-enumerable is not the same as
 * unforgeable, and identity in a URL that anyone can construct is an
 * account-linking primitive in both directions:
 *   - hand a victim a link carrying the ATTACKER's id → the victim authorizes X
 *     and their write token is stored on the attacker's row;
 *   - use a leaked victim id → the attacker binds their own account to the
 *     victim's row and inherits the posting connection.
 *
 * So identity leaves the URL entirely. The bot, which HAS an authenticated
 * Telegram context, mints an opaque ticket at message-build time; the link
 * carries only that. A ticket is 32 random bytes, is bound to one platform, and
 * expires in 15 minutes.
 *
 * Deliberately REUSABLE inside its window rather than single-use: a user who
 * taps the link, backs out of X's consent screen, and taps the same message
 * again is doing something completely normal and must not be dead-ended.
 *
 * Stored in Postgres (migration 0057) so a Railway restart doesn't strand
 * in-flight connect links. OAuth PKCE/CSRF state is separate and single-consume
 * (see lib/oauth-state.ts).
 */
import { randomBytes } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import type { Platform } from "./types.js";

const TICKET_TTL_MS = 15 * 60 * 1000;

async function sweep(): Promise<void> {
  await query(`DELETE FROM oauth_connect_tickets WHERE expires_at < now()`).catch(() => {});
}

/** Mint a ticket for an already-identified user. Callers must be authenticated. */
export async function mintConnectTicket(userId: string, platform: Platform): Promise<string> {
  await sweep();
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS).toISOString();
  await query(
    `INSERT INTO oauth_connect_tickets (ticket, user_id, platform, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [ticket, userId, platform, expiresAt],
  );
  return ticket;
}

/**
 * Resolve a ticket to its user, or null if it's unknown, expired, or was minted
 * for the other platform (so one leg's ticket can't be replayed against the
 * other).
 */
export async function readConnectTicket(
  ticket: string | undefined,
  platform: Platform,
): Promise<string | null> {
  if (!ticket) return null;
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM oauth_connect_tickets
      WHERE ticket = $1 AND platform = $2 AND expires_at >= now()`,
    [ticket, platform],
  );
  return row?.user_id ?? null;
}
