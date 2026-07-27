"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Menu01Icon, Cancel01Icon, TelegramIcon } from "@hugeicons/core-free-icons";
import { UserButton } from "@clerk/nextjs";
import { useTelegramLink } from "./use-telegram-link";
import styles from "./mobile-header.module.css";

/**
 * The mobile top bar (hidden entirely on desktop — see the CSS module):
 * logo icon on the left, then a Telegram icon that's ALWAYS visible (opens the
 * bot directly, no need to open the menu first), the Clerk account button, then
 * the hamburger that toggles the sidebar drawer. Everything else that used to
 * crowd the old mobile strip (nav links, the trial "Add card" pill) now lives
 * inside the drawer itself.
 *
 * The account button is here because the only other one is in the desktop top
 * bar, which is `display: none` under 1000px — so on a phone there was no way to
 * manage the account or sign out at all.
 */
export function MobileHeader({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { open: openTelegram, busy } = useTelegramLink();

  return (
    <header className={styles.header}>
      <img src="/favicon.png" alt="Yoinky" className={styles.logo} />
      <div className={styles.spacer} />
      <button
        type="button"
        className={styles.iconBtn}
        onClick={openTelegram}
        disabled={busy}
        aria-label="Open the Yoinky bot in Telegram"
        title="Open the Yoinky bot in Telegram"
      >
        <HugeiconsIcon icon={TelegramIcon} size={20} strokeWidth={1.8} />
      </button>
      <span className={styles.user}>
        <UserButton />
      </span>
      <button
        type="button"
        className={styles.iconBtn}
        onClick={onToggle}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
      >
        <HugeiconsIcon icon={open ? Cancel01Icon : Menu01Icon} size={22} strokeWidth={1.8} />
      </button>
    </header>
  );
}
