import { query } from "../db/pool.js";
import { config } from "../config.js";
import { getBot } from "../telegram/bot.js";

export type FeedbackType = "feature_request" | "bug_report";

export interface FeedbackInput {
  type: string;
  category: string;
  message: string;
}

/**
 * Store one piece of in-app feedback and best-effort ping the operator on
 * Telegram so it isn't only visible by reading the table. The type is coerced to
 * one of the two known values; category is free-form (it's the dependent
 * second-dropdown choice) and message is required. Never throws for a delivery
 * failure — the row is the source of truth, the ping is a convenience.
 */
export async function submitFeedback(userId: string, input: FeedbackInput): Promise<{ ok: boolean }> {
  const type: FeedbackType = input.type === "bug_report" ? "bug_report" : "feature_request";
  const category = (input.category ?? "").trim().slice(0, 120);
  const message = (input.message ?? "").trim().slice(0, 4000);
  if (!message) return { ok: false };

  await query(`INSERT INTO feedback (user_id, type, category, message) VALUES ($1, $2, $3, $4)`, [
    userId,
    type,
    category || null,
    message,
  ]);

  const bot = getBot();
  if (bot && config.ADMIN_TELEGRAM_ID) {
    const label = type === "bug_report" ? "🐛 Bug report" : "💡 Feature request";
    try {
      await bot.api.sendMessage(
        Number(config.ADMIN_TELEGRAM_ID),
        `${label}${category ? ` · ${category}` : ""}\n\n${message}`,
      );
    } catch (err) {
      console.error("feedback admin notify failed", err);
    }
  }

  return { ok: true };
}
