import { InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { foundingSeatsLeft } from "./dodo.js";

/**
 * The single source of truth for what upgrading unlocks. Shown in three places —
 * the `/upgrade` command, the post-diagnosis paywall, and the repeated wall
 * message a free user gets on every further action — so the benefits copy never
 * drifts. Update this list as paid features ship.
 */
export const UPGRADE_BENEFITS =
  "here's what unlocking gets you:\n" +
  "• drafting in your voice — any thought becomes a post that sounds like you wrote it\n" +
  "• trend + viral spotlights — i catch what's blowing up in your lane and hand you the angle\n" +
  "• consistency checks — i flag when a draft contradicts something you've already said\n" +
  "• repurposing — reshape a post across platforms, or pull scattered takes into one piece\n" +
  "• me, day to day — chat, resurfacing the right idea at the right time, replies to your mentions";

/** The short line that leads the repeated paywall message (kept identical every time). */
export const WALL_PROMPT =
  "you've got your full brand diagnosis, that's the free part. everything past it runs on the paid plan.";

/**
 * Build the upgrade offer (benefits copy + checkout buttons). Async because the
 * Founding seat count is read live. Founding is only offered when a founding
 * product is configured (an unconfigured button just errors at checkout).
 */
export async function buildUpgradeOffer(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const kb = new InlineKeyboard();
  if (config.DODO_PRODUCT_FOUNDING) {
    const seats = await foundingSeatsLeft().catch(() => 0);
    kb.text(seats > 0 ? `Founding (${seats} left, price locked)` : "Founding (full)", "bill:founding").row();
  }
  kb.text(`Go paid — ${config.PAID_PRICE_LABEL}`, "bill:paid");
  const text = `${UPGRADE_BENEFITS}\n\n${config.PAID_PRICE_LABEL}, cancel anytime.`;
  return { text, keyboard: kb };
}
