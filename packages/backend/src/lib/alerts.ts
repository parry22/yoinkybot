import { config } from "../config.js";
import { getBot } from "../telegram/bot.js";

/**
 * Operational alerting with zero external dependencies: critical failures DM
 * the admin through the bot itself. Throttled per key so a crash-looping job
 * pages once an hour, not once a second. No ADMIN_TELEGRAM_ID → silent no-op
 * (dev default).
 */

const THROTTLE_MS = 60 * 60 * 1000;
const lastSent = new Map<string, number>();

export async function alertAdmin(key: string, message: string): Promise<void> {
  if (!config.ADMIN_TELEGRAM_ID) return;
  const now = Date.now();
  const last = lastSent.get(key) ?? 0;
  if (now - last < THROTTLE_MS) return;
  lastSent.set(key, now);

  try {
    await getBot()?.api.sendMessage(Number(config.ADMIN_TELEGRAM_ID), `🚨 ${message}`.slice(0, 3800));
  } catch (err) {
    console.error("admin alert delivery failed", err);
  }
}
