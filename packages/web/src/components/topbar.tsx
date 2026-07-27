"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { TelegramIcon } from "@hugeicons/core-free-icons";
import { UserButton } from "@clerk/nextjs";
import type { TrialInfo } from "@yoink/backend/web";
import { TrialPill } from "./trial-banner";
import { useTelegramLink } from "./use-telegram-link";
import styles from "./topbar.module.css";

/**
 * Telegram opens through `useTelegramLink`, same as the sidebar item and the
 * mobile header. This used to be a plain `<a href={config.TELEGRAM_BOT_URL}>`,
 * which is precisely the failure that hook exists to prevent: a bare t.me link
 * arrives at the bot with no `?start=<token>`, so the chat is never linked to
 * the Clerk account and the auth-gated bot turns the user away.
 */
export function TopBar({ trial }: { trial: TrialInfo | null }) {
  const { open: openTelegram, busy } = useTelegramLink();

  return (
    <header className={styles.topbar}>
      <div className={styles.spacer} />
      {trial && <TrialPill trial={trial} />}
      <button type="button" className={styles.telegram} onClick={openTelegram} disabled={busy}>
        <HugeiconsIcon icon={TelegramIcon} size={18} strokeWidth={1.8} />
        <span>Telegram</span>
      </button>
      <UserButton />
    </header>
  );
}
