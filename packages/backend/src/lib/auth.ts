import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query, queryOne } from "../db/pool.js";

export interface User {
  id: string;
  telegram_id: string | null;
  email: string | null;
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
  return (await queryOne(`INSERT INTO users (telegram_id) VALUES ($1) RETURNING *`, [
    telegramId,
  ])) as unknown as User;
}

export async function findOrCreateUserByEmail(email: string): Promise<User> {
  const existing = (await queryOne(`SELECT * FROM users WHERE email = $1`, [email])) as User | undefined;
  if (existing) return existing;
  return (await queryOne(`INSERT INTO users (email) VALUES ($1) RETURNING *`, [email])) as unknown as User;
}
