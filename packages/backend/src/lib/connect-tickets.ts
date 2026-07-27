/**
 * Connect tickets — the thing that replaced `?u=<user id>` on
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
 * In memory, like the PKCE state map next to it, for the reason documented in
 * docs/INTERNAL.md: this backend is single-instance. A restart drops in-flight
 * tickets, and the user gets an honest "start the connect again" page instead of
 * a bind to the wrong account. If this ever scales horizontally, move both to
 * Postgres together.
 */
import { randomBytes } from "node:crypto";
import type { Platform } from "./types.js";

interface ConnectTicket {
  userId: string;
  platform: Platform;
  expiresAt: number;
}

const tickets = new Map<string, ConnectTicket>();
const TICKET_TTL_MS = 15 * 60 * 1000;

function sweep(): void {
  const now = Date.now();
  for (const [key, t] of tickets) if (t.expiresAt < now) tickets.delete(key);
}

/** Mint a ticket for an already-identified user. Callers must be authenticated. */
export function mintConnectTicket(userId: string, platform: Platform): string {
  sweep();
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { userId, platform, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

/**
 * Resolve a ticket to its user, or null if it's unknown, expired, or was minted
 * for the other platform (so one leg's ticket can't be replayed against the
 * other).
 */
export function readConnectTicket(ticket: string | undefined, platform: Platform): string | null {
  if (!ticket) return null;
  const found = tickets.get(ticket);
  if (!found) return null;
  if (found.expiresAt < Date.now()) {
    tickets.delete(ticket);
    return null;
  }
  if (found.platform !== platform) return null;
  return found.userId;
}
