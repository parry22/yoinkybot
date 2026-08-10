"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Menu01Icon, Cancel01Icon, TelegramIcon } from "@hugeicons/core-free-icons";
import { usePathname } from "next/navigation";
import { useTelegramLink } from "./use-telegram-link";
import styles from "./mobile-header.module.css";

function pageTitle(pathname: string): string {
  if (pathname === "/app") return "Knowledge";
  if (pathname.startsWith("/app/inbox")) return "Inbox";
  if (pathname.startsWith("/app/knowledge")) return "Knowledge";
  if (pathname.startsWith("/app/studio")) return "Studio";
  if (pathname.startsWith("/app/assets")) return "Assets";
  if (pathname.startsWith("/app/integrations")) return "Integrations";
  if (pathname.startsWith("/app/settings")) return "Settings";
  if (pathname.startsWith("/app/workspaces")) return "Workspaces";
  return "Yoinky";
}

export function MobileHeader({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const pathname = usePathname();
  const { open: openTelegram, busy } = useTelegramLink();

  return (
    <header className={styles.header}>
      <img src="/favicon.png" alt="" className={styles.logo} />
      <h1 className={styles.pageTitle}>{pageTitle(pathname)}</h1>
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
