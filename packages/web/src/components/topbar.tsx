"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { TelegramIcon } from "@hugeicons/core-free-icons";
import styles from "./topbar.module.css";

export function TopBar({ telegramUrl }: { telegramUrl: string }) {
  return (
    <header className={styles.topbar}>
      <div className={styles.spacer} />
      <a
        className={styles.telegram}
        href={telegramUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        <HugeiconsIcon icon={TelegramIcon} size={18} strokeWidth={1.8} />
        <span>Telegram</span>
      </a>
    </header>
  );
}
