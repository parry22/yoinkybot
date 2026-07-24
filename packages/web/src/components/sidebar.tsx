"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BotIcon,
  QuillWrite02Icon,
  Calendar03Icon,
  FireIcon,
  RadarIcon,
  Analytics01Icon,
  Target01Icon,
  Settings05Icon,
  TelegramIcon,
} from "@hugeicons/core-free-icons";
import styles from "./sidebar.module.css";

type NavItem = { href: string; label: string; icon: typeof BotIcon };

const AGENT_NAV: NavItem[] = [
  { href: "/app/compose", label: "Compose", icon: QuillWrite02Icon },
  { href: "/app/automations", label: "Auto Agent", icon: BotIcon },
];

const GROW_NAV: NavItem[] = [
  { href: "/app/growth", label: "Growth", icon: Target01Icon },
  { href: "/app/inspiration", label: "Inspiration", icon: FireIcon },
  { href: "/app/buyers-radar", label: "Buyers Radar", icon: RadarIcon },
  { href: "/app/analytics", label: "Analytics", icon: Analytics01Icon },
];

const ACCOUNT_NAV: NavItem[] = [
  { href: "/app/scheduled", label: "Scheduled", icon: Calendar03Icon },
  { href: "/app/settings", label: "Settings", icon: Settings05Icon },
];

export function Sidebar() {
  const pathname = usePathname();
  const [tgBusy, setTgBusy] = useState(false);

  // Open the bot through a one-time link token so /start links this Clerk
  // account to the Telegram chat (idempotent if already linked). A plain
  // t.me link would arrive unlinked and the auth-gated bot would turn it away.
  async function openTelegram() {
    if (tgBusy) return;
    setTgBusy(true);
    try {
      const res = await fetch("/api/telegram/link", { method: "POST" });
      const data = await res.json();
      if (data.url) window.open(data.url, "_blank", "noopener,noreferrer");
    } catch {
      /* transient failure — the user can tap again */
    } finally {
      setTgBusy(false);
    }
  }

  function renderGroup(label: string, items: NavItem[]) {
    return (
      <div key={label}>
        <p className={styles.navLabel}>{label}</p>
        {items.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}>
              <HugeiconsIcon icon={item.icon} size={18} strokeWidth={1.8} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    );
  }

  return (
    <aside className={styles.sidebar} aria-label="Yoinky navigation">
      <div className={styles.brandRow}>
        <img src="/favicon.png" alt="" className={styles.dot} />
        Yoinky
      </div>

      <nav className={styles.nav}>
        {renderGroup("Agent", AGENT_NAV)}
        {renderGroup("Grow", GROW_NAV)}
        {renderGroup("Account", ACCOUNT_NAV)}
      </nav>

      <button
        type="button"
        className={`${styles.navItem} ${styles.telegramItem}`}
        onClick={openTelegram}
        disabled={tgBusy}
        title="Open the Yoinky bot in Telegram"
      >
        <HugeiconsIcon icon={TelegramIcon} size={18} strokeWidth={1.8} />
        <span>{tgBusy ? "Opening…" : "Telegram Bot"}</span>
      </button>
    </aside>
  );
}
