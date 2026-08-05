import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { track, identify } from "../analytics/posthog.js";
import { startTrial } from "../billing/entitlements.js";

export interface User {
  id: string;
  telegram_id: string | null;
  email: string | null;
  clerk_user_id: string | null;
  settings: Record<string, unknown>;
  created_at: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// --- Web sessions -----------------------------------------------------------

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(userId: string): Promise<string> {
  const token = newToken("sess");
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days')`,
    [userId, hashToken(token)],
  );
  void SESSION_TTL_MS;
  return token;
}

export async function userForSession(token: string): Promise<User | undefined> {
  return queryOne<User & Record<string, never>>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  ) as Promise<User | undefined>;
}

// --- Email magic-link login --------------------------------------------------

/** Mint a single-use, 30-minute login token for an email address. Returns the
 *  raw token to embed in the magic link; only its hash is stored. */
export async function createLoginToken(email: string): Promise<string> {
  const token = newToken("login");
  await query(
    `INSERT INTO login_tokens (token_hash, email, expires_at)
     VALUES ($1, $2, now() + interval '30 minutes')`,
    [hashToken(token), email.trim().toLowerCase()],
  );
  return token;
}

/** Consume a login token (single use) and return the matching user, creating one
 *  by email on first sign-in. Undefined if the token is unknown/expired/used. */
export async function consumeLoginToken(token: string): Promise<User | undefined> {
  const row = await queryOne<{ email: string }>(
    `UPDATE login_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING email`,
    [hashToken(token)],
  );
  if (!row) return undefined;
  return findOrCreateUserByEmail(row.email);
}

// --- Telegram deep-link linking ----------------------------------------------

export async function createTelegramLinkToken(userId: string): Promise<string> {
  const token = randomBytes(12).toString("base64url");
  await query(
    `INSERT INTO telegram_link_tokens (token, user_id, expires_at) VALUES ($1, $2, now() + interval '15 minutes')`,
    [token, userId],
  );
  return token;
}

/** Consume a link token and attach the telegram id to that user. */
export async function consumeTelegramLinkToken(token: string, telegramId: number): Promise<User | undefined> {
  const row = await queryOne<{ user_id: string }>(
    `UPDATE telegram_link_tokens SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [token],
  );
  if (!row) return undefined;
  // Detach this telegram id from any OTHER account first (a re-link, or a stray
  // legacy telegram-only row) so the UNIQUE(telegram_id) constraint can't block
  // attaching it to the intended web account.
  await query(`UPDATE users SET telegram_id = NULL WHERE telegram_id = $1 AND id <> $2`, [telegramId, row.user_id]);
  return (await queryOne(`UPDATE users SET telegram_id = $1 WHERE id = $2 RETURNING *`, [
    telegramId,
    row.user_id,
  ])) as User | undefined;
}

// --- Users -------------------------------------------------------------------

export async function findOrCreateUserByTelegram(telegramId: number): Promise<User> {
  const existing = (await queryOne(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId])) as
    | User
    | undefined;
  if (existing) return existing;
  const created = (await queryOne(`INSERT INTO users (telegram_id) VALUES ($1) RETURNING *`, [
    telegramId,
  ])) as unknown as User;
  // First time we've seen this Telegram user - the top of the funnel.
  identify(created.id, { source: "telegram", created_at: created.created_at });
  track(created.id, "user_signed_up", { source: "telegram" });
  return created;
}

/** Read-only lookup - never creates a row. Used by the outgoing message tracker
 *  so a DM to a non-app chat (e.g. an admin alert) doesn't spawn a stray user. */
export async function findUserIdByTelegramId(telegramId: number): Promise<string | null> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM users WHERE telegram_id = $1`, [telegramId]);
  return row?.id ?? null;
}

/** Read-only: the full user row for a Telegram id, or null. The Telegram bot is
 *  now auth-gated - a user must have linked this telegram_id to a web account,
 *  so the bot looks up (never creates) and turns unlinked visitors away. */
export async function findUserByTelegramId(telegramId: number): Promise<User | null> {
  const row = (await queryOne(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId])) as User | undefined;
  return row ?? null;
}

/** Find or create a user by their X account id - the "Sign in with X" identity. */
export async function findOrCreateUserByXId(xUserId: string): Promise<User> {
  const existing = (await queryOne(`SELECT * FROM users WHERE x_user_id = $1`, [xUserId])) as User | undefined;
  if (existing) return existing;
  const created = (await queryOne(`INSERT INTO users (x_user_id) VALUES ($1) RETURNING *`, [
    xUserId,
  ])) as unknown as User;
  identify(created.id, { source: "x", created_at: created.created_at });
  track(created.id, "user_signed_up", { source: "x" });
  return created;
}

export async function findOrCreateUserByEmail(email: string): Promise<User> {
  const existing = (await queryOne(`SELECT * FROM users WHERE email = $1`, [email])) as User | undefined;
  if (existing) return existing;
  return (await queryOne(`INSERT INTO users (email) VALUES ($1) RETURNING *`, [email])) as unknown as User;
}

/** Read-only lookup by Clerk user id - the web app's fast path on every request. */
export async function findUserByClerkId(clerkUserId: string): Promise<User | undefined> {
  return (await queryOne(`SELECT * FROM users WHERE clerk_user_id = $1`, [clerkUserId])) as User | undefined;
}

/**
 * Map a Clerk-authenticated identity to our user row. Clerk is now the web app's
 * identity provider, so this is called on the first request of a session:
 *   1. Already mapped by clerk id → return it (backfilling a newly-known email).
 *   2. A pre-Clerk row with the same email (old Google/magic-link/X user) → attach
 *      the clerk id to it, so existing accounts carry over without duplication.
 *   3. Otherwise a brand-new signup → create the row AND start the 7-day trial.
 * The trial only starts on genuine account creation (step 3), never on carryover.
 */
export async function findOrCreateUserByClerkId(clerkUserId: string, email: string | null): Promise<User> {
  const byClerk = await findUserByClerkId(clerkUserId);
  if (byClerk) {
    if (email && !byClerk.email) {
      const updated = (await queryOne(`UPDATE users SET email = $2 WHERE id = $1 RETURNING *`, [
        byClerk.id,
        email.trim().toLowerCase(),
      ])) as User | undefined;
      return updated ?? byClerk;
    }
    return byClerk;
  }

  if (email) {
    const byEmail = (await queryOne(`SELECT * FROM users WHERE email = $1`, [email.trim().toLowerCase()])) as
      | User
      | undefined;
    if (byEmail) {
      const linked = (await queryOne(`UPDATE users SET clerk_user_id = $2 WHERE id = $1 RETURNING *`, [
        byEmail.id,
        clerkUserId,
      ])) as User | undefined;
      // A returning account that predates the trial system still gets one on its
      // first Clerk sign-in (idempotent: no-op if a subscription row exists).
      if (linked) await startTrial(linked.id).catch((err) => console.error("startTrial (carryover) failed", err));
      return linked ?? byEmail;
    }
  }

  const created = (await queryOne(`INSERT INTO users (clerk_user_id, email) VALUES ($1, $2) RETURNING *`, [
    clerkUserId,
    email ? email.trim().toLowerCase() : null,
  ])) as unknown as User;
  await startTrial(created.id).catch((err) => console.error("startTrial (signup) failed", err));
  identify(created.id, { source: "clerk", created_at: created.created_at });
  track(created.id, "user_signed_up", { source: "clerk" });
  return created;
}
