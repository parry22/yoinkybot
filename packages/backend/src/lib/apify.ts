import { config } from "../config.js";
import { currentUserId } from "../byok/context.js";
import { scraperKeyForUser } from "../byok/keys.js";

/**
 * Run an Apify actor synchronously and return its dataset items in one request.
 * Shared by the trends provider and the strategist's profile ingestion — Apify
 * hosts/maintains the scrapers so anti-bot upkeep and ban risk sit with them.
 * One retry on network/5xx errors — observed transient failures on cold actor
 * starts in practice, and a full /connect run is expensive to just fail outright.
 */
export async function runApifyActor(
  actorId: string,
  input: unknown,
  timeoutSecs = 180,
): Promise<unknown[]> {
  // BYOK: a lifetime user's own Apify token, when we're inside their work (see
  // byok/context.ts). Falls back to ours for every other plan and for any path
  // that hasn't set the ambient user — that fallback is intentional, so a missed
  // entry point costs us money rather than breaking the user's run.
  const byok = await scraperKeyForUser(currentUserId());
  const token = byok?.provider === "apify" ? byok.key : config.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN not configured");
  const id = actorId.replace("/", "~"); // API path form: user~actor-name
  const url = `https://api.apify.com/v2/acts/${id}/run-sync-get-dataset-items?timeout=${timeoutSecs}&memory=1024&format=json`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout((timeoutSecs + 20) * 1000),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        if (res.status < 500 || attempt === 1) throw new Error(`apify ${actorId} ${res.status}: ${body}`);
        lastErr = new Error(`apify ${actorId} ${res.status}: ${body}`);
        continue;
      }
      const items = (await res.json()) as unknown;
      return Array.isArray(items) ? items : [];
    } catch (err) {
      lastErr = err;
      if (attempt === 1) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
