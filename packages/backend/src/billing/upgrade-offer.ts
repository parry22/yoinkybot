import { InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { foundingSeatsLeft } from "./dodo.js";

/**
 * The single source of truth for what upgrading unlocks. Shown in three places -
 * the `/upgrade` command, the post-diagnosis paywall, and the repeated wall
 * message a free user gets on every further action - so the benefits copy never
 * drifts. Update this list as paid features ship.
 */
export const UPGRADE_BENEFITS =
  "here's what unlocking gets you:\n" +
  "• drafting in your voice - any thought becomes a post that sounds like you wrote it\n" +
  "• trend + viral spotlights - i catch what's blowing up in your lane and hand you the angle\n" +
  "• consistency checks - i flag when a draft contradicts something you've already said\n" +
  "• repurposing - reshape a post across platforms, or pull scattered takes into one piece\n" +
  "• me, day to day - chat, resurfacing the right idea at the right time, replies to your mentions";

/** The short line that leads the repeated paywall message (kept identical every time). */
export const WALL_PROMPT =
  "you've got your full brand diagnosis, that's the free part. everything past it runs on the paid plan.";

/**
 * Build the upgrade offer (benefits copy + checkout buttons). Async because the
 * Founding seat count is read live. A plan is only offered when its Dodo product
 * is configured - an unconfigured button just errors at checkout.
 *
 * Scale used to be missing entirely: the offer showed one "Go paid" button, so
 * Telegram could sell Growth and nothing else. Every Scale sale had to happen on
 * the web, even though the bot is where the paywall is actually hit.
 */
export async function buildUpgradeOffer(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const kb = new InlineKeyboard();
  let buttons = 0;

  if (config.DODO_PRODUCT_FOUNDING) {
    const seats = await foundingSeatsLeft().catch(() => 0);
    kb.text(seats > 0 ? `Founding (${seats} left, price locked)` : "Founding (full)", "bill:founding").row();
    buttons++;
  }
  if (config.DODO_PRODUCT_PAID) {
    kb.text(`Growth - ${config.PAID_PRICE_LABEL}`, "bill:paid").row();
    buttons++;
  }
  if (config.DODO_PRODUCT_SCALE) {
    kb.text(`Scale - ${config.SCALE_PRICE_LABEL}`, "bill:scale").row();
    buttons++;
  }

  // Both tiers get named in the copy so the choice reads as a choice, not as an
  // upsell hiding behind a button.
  const priceLine = [
    config.DODO_PRODUCT_PAID ? `growth ${config.PAID_PRICE_LABEL}` : null,
    config.DODO_PRODUCT_SCALE ? `scale ${config.SCALE_PRICE_LABEL} (adds the hands-off agent)` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const text = buttons
    ? `${UPGRADE_BENEFITS}\n\n${priceLine}. cancel anytime.`
    : // No product configured at all - don't dangle a button that can only fail.
      `${UPGRADE_BENEFITS}\n\ncheckout's not wired up right now. give it a bit and try again.`;
  return { text, keyboard: kb };
}
