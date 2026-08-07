"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { TelegramIcon } from "@hugeicons/core-free-icons";
import { usePathname } from "next/navigation";
import type { TrialInfo } from "@yoink/backend/web";
import { TrialPill } from "./trial-banner";
import { useTelegramLink } from "./use-telegram-link";
import { usePageMeta } from "./page-meta";
import styles from "./topbar.module.css";

function pageTitle(pathname: string): string {
  if (pathname === "/app") return "Inbox";
  if (pathname.startsWith("/app/knowledge")) return "Knowledge";
  if (pathname.startsWith("/app/studio")) return "Studio";
  if (pathname.startsWith("/app/assets")) return "Assets";
  if (pathname.startsWith("/app/integrations")) return "Integrations";
  if (pathname.startsWith("/app/narrative")) return "Narrative";
  if (pathname.startsWith("/app/briefs")) return "Briefs";
  if (pathname.startsWith("/app/distribution")) return "Distribution";
  if (pathname.startsWith("/app/analytics")) return "Analytics";
  if (pathname.startsWith("/app/compose")) return "Compose";
  if (pathname.startsWith("/app/scheduled")) return "Scheduled";
  if (pathname.startsWith("/app/automations")) return "Automations";
  if (pathname.startsWith("/app/inspiration")) return "Inspiration";
  if (pathname.startsWith("/app/growth")) return "Growth";
  if (pathname.startsWith("/app/buyers-radar")) return "Buyers Radar";
  if (pathname.startsWith("/app/settings")) return "Settings";
  if (pathname.startsWith("/app/workspaces")) return "Workspaces";
  return "Yoinky";
}

export function TopBar({ trial }: { trial: TrialInfo | null }) {
  const pathname = usePathname();
  const { open: openTelegram, busy } = useTelegramLink();
  const meta = usePageMeta();
  const title = pageTitle(pathname);
  const showCount = pathname === "/app" && meta?.count != null;

  return (
    <header className={styles.topbar}>
      <h1 className={styles.pageTitle}>
        {title}
        {showCount && <span className={styles.pageCount}>{meta.count}</span>}
      </h1>
      <div className={styles.spacer} />
      {trial && <TrialPill trial={trial} />}
      <button
        type="button"
        className={styles.telegram}
        onClick={openTelegram}
        disabled={busy}
        title="Capture via Telegram"
        aria-label="Capture via Telegram"
      >
        <HugeiconsIcon icon={TelegramIcon} size={18} strokeWidth={1.8} />
        <span>Capture</span>
      </button>
    </header>
  );
}
