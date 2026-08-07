import "server-only";
import { entitlementsFor, isPaidOrExempt, type Entitlements, type User } from "@yoink/backend/web";

/**
 * The web-side paywall gate. Returns the user's plan entitlements when they're
 * allowed past the paywall (paid/trialing/exempt), or null when they should be
 * walled - the caller then returns a 402. Mirrors the Telegram `upgradeWall`
 * (both go through `isPaidOrExempt`), closing the gap where web routes ran paid
 * work (twitterapi.io / LLM) for free/expired users.
 */
export async function requirePaid(user: User): Promise<Entitlements | null> {
  const allowed = await isPaidOrExempt({ id: user.id, telegram_id: user.telegram_id });
  if (!allowed) return null;
  return entitlementsFor(user.id);
}

/** Standard 402 body for paywall denials. */
export function upgradeRequiredResponse() {
  return Response.json(
    { error: "upgrade_required", message: "Upgrade to keep using this feature." },
    { status: 402 },
  );
}

/** Standard 402 body for numeric plan-cap denials. */
export function capReachedResponse(cap: string, message: string) {
  return Response.json({ error: "cap_reached", cap, message }, { status: 402 });
}
