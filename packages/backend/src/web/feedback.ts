import { query, queryOne } from "../db/pool.js";
import { config } from "../config.js";
import { getBot } from "../telegram/bot.js";

export type FeedbackType = "feature_request" | "bug_report";

/**
 * Hard daily ceiling per user, enforced here rather than only at the route so
 * ANY caller (a future Telegram command, a script) inherits it. The web route's
 * burst limiter (lib/rate-limit.ts, 5/hour) is the first line; this is the one
 * that stops a patient drip from filling the operator's inbox overnight.
 */
const MAX_PER_DAY = 12;

export interface FeedbackInput {
  type: string;
  category: string;
  message: string;
}

/**
 * Store one piece of in-app feedback, then deliver it. Primary channel is email
 * to FEEDBACK_EMAIL_TO (parry@meetyoinky.com by default) via Resend's HTTP API;
 * the Telegram admin ping is a secondary that also covers the case where the web
 * process has no bot instance. Both are best-effort — the DB row is the source
 * of truth and a delivery failure never throws.
 */
export async function submitFeedback(
  userId: string,
  input: FeedbackInput,
): Promise<{ ok: boolean; reason?: string }> {
  const type: FeedbackType = input.type === "bug_report" ? "bug_report" : "feature_request";
  const category = (input.category ?? "").trim().slice(0, 120);
  const message = (input.message ?? "").trim().slice(0, 4000);
  if (!message) return { ok: false };

  // Daily ceiling. Counted BEFORE the insert so the row itself doesn't count,
  // and before any delivery so a capped user costs us nothing.
  const today = await queryOne<{ n: string }>(
    `SELECT count(*)::text n FROM feedback WHERE user_id = $1 AND created_at >= now() - interval '24 hours'`,
    [userId],
  );
  if (Number(today?.n ?? 0) >= MAX_PER_DAY) {
    return { ok: false, reason: "that's a lot of feedback for one day — I've got it, give me a chance to read it" };
  }

  await query(`INSERT INTO feedback (user_id, type, category, message) VALUES ($1, $2, $3, $4)`, [
    userId,
    type,
    category || null,
    message,
  ]);

  // Who sent it, for context + reply-to.
  const user = await queryOne<{ email: string | null; telegram_id: string | null }>(
    `SELECT email, telegram_id FROM users WHERE id = $1`,
    [userId],
  );
  const label = type === "bug_report" ? "🐛 Bug report" : "💡 Feature request";
  const who = user?.email ?? `user ${userId}`;

  // Primary: email to the operator inbox.
  if (config.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: config.FEEDBACK_EMAIL_FROM,
          to: [config.FEEDBACK_EMAIL_TO],
          // Reply-to the user so the operator can answer them directly.
          ...(user?.email ? { reply_to: user.email } : {}),
          subject: `${label}${category ? ` · ${category}` : ""} — from ${who}`,
          text:
            `${label}\n` +
            `From: ${who}${user?.telegram_id ? ` (telegram ${user.telegram_id})` : ""}\n` +
            `Category: ${category || "—"}\n\n` +
            `${message}\n`,
        }),
      });
      if (!res.ok) {
        console.error("feedback email failed", res.status, await res.text().catch(() => ""));
      }
    } catch (err) {
      console.error("feedback email error", err);
    }
  }

  // Secondary: Telegram admin ping (only fires where a bot instance exists).
  const bot = getBot();
  if (bot && config.ADMIN_TELEGRAM_ID) {
    try {
      await bot.api.sendMessage(
        Number(config.ADMIN_TELEGRAM_ID),
        `${label}${category ? ` · ${category}` : ""} — from ${who}\n\n${message}`,
      );
    } catch (err) {
      console.error("feedback admin notify failed", err);
    }
  }

  return { ok: true };
}
