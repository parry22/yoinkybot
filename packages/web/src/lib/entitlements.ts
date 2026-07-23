import "server-only";
import { entitlementsFor, isPaidOrExempt, type Entitlements, type User } from "@yoink/backend/web";

/**
 * The web-side paywall gate. Returns the user's plan entitlements when they're
 * allowed past the paywall (paid/trialing/exempt), or null when they should be
 * walled — the caller then returns a 402. Mirrors the Telegram `upgradeWall`
 * (both go through `isPaidOrExempt`), closing the gap where web routes ran paid
 * work (twitterapi.io / LLM) for free/expired users.
 */
export async function requirePaid(user: User): Promise<Entitlements | null> {
  const allowed = await isPaidOrExempt({ id: user.id, telegram_id: user.telegram_id });
  if (!allowed) return null;
  return entitlementsFor(user.id);
}
