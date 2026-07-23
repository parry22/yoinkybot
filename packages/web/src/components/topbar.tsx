"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { TelegramIcon } from "@hugeicons/core-free-icons";
import { UserButton } from "@clerk/nextjs";
import type { TrialInfo } from "@yoink/backend/web";
import { TrialPill } from "./trial-banner";
import styles from "./topbar.module.css";

export function TopBar({ telegramUrl, trial }: { telegramUrl: string; trial: TrialInfo | null }) {
  return (
    <header className={styles.topbar}>
      <div className={styles.spacer} />
      {trial && <TrialPill trial={trial} />}
      <a
        className={styles.telegram}
        href={telegramUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        <HugeiconsIcon icon={TelegramIcon} size={18} strokeWidth={1.8} />
        <span>Telegram</span>
      </a>
      <UserButton />
    </header>
  );
}
