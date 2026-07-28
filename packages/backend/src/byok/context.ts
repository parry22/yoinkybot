/**
 * "Whose work is this?" — an ambient user id for BYOK key resolution.
 *
 * The LLM gateway already receives `req.userId` on every call, so it resolves a
 * BYOK key directly. The SCRAPERS don't: `runApifyActor` and the twitterapi.io
 * helpers are called from ingestion, trends, analytics and radar code that is
 * several frames removed from whoever triggered it, and threading a userId
 * through all of it would touch dozens of signatures for one feature.
 *
 * AsyncLocalStorage carries it instead. `runAsUser` is set once at each entry
 * point where a unit of work begins for a known user, and anything underneath —
 * however deep — can ask `currentUserId()`.
 *
 * THE FALLBACK IS DELIBERATELY SAFE. Miss an entry point and `currentUserId()`
 * returns null, the scraper uses OUR key, and the work still succeeds — we just
 * don't save the money on that path. The alternative failure (throwing, or
 * silently doing nothing) would break the product for a paying user, which is
 * far worse than a missed saving. So this degrades toward "works, costs us",
 * never toward "broken".
 */
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<{ userId: string }>();

/** Run `fn` with `userId` as the ambient BYOK identity. */
export function runAsUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ userId }, fn);
}

/** The ambient user id, or null outside any `runAsUser` scope. */
export function currentUserId(): string | null {
  return store.getStore()?.userId ?? null;
}
