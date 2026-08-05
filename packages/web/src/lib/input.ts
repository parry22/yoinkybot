import "server-only";

/**
 * Input bounds for free-text that reaches a model.
 *
 * The Telegram side is bounded for free - Telegram itself caps a message at 4096
 * characters - so nothing in the shared brain ever had to think about length.
 * The web routes had no such ceiling: `/api/chat` and `/api/chat/stream` took
 * `body.text` of any size and put it straight into the prompt. With input billed
 * per token, a handful of multi-megabyte turns is real money, and the burst
 * limiter doesn't help because the cost is per REQUEST, not per rate.
 *
 * 4000 is deliberately the Telegram ceiling rounded down, so a turn behaves the
 * same whichever surface it arrives on.
 */
export const TEXT_MAX = 4000;

/**
 * Read a bounded string field off a parsed JSON body.
 *
 * Truncates rather than rejecting: a long paste is a normal thing a person does,
 * and failing the turn outright would be worse product than answering the first
 * 4000 characters. Returns "" for anything that isn't a string, so callers keep
 * their existing empty-check.
 */
export function boundedText(value: unknown, max: number = TEXT_MAX): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
