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
  ChatFeedbackIcon,
} from "@hugeicons/core-free-icons";
import type { TrialInfo } from "@yoink/backend/web";
import { TrialPill } from "./trial-banner";
import { useTelegramLink } from "./use-telegram-link";
import { FeedbackModal } from "./feedback-modal";
import { AccountSwitcher } from "./account-switcher";
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

export function Sidebar({
  open,
  trial,
  onNavigate,
}: {
  /** Mobile drawer state — a no-op class on desktop, where the sidebar is always visible. */
  open: boolean;
  /** Shown as a mobile-only pill (the persistent top bar covers Telegram there instead). */
  trial: TrialInfo | null;
  /** Called after a nav link is tapped, so the mobile drawer closes on navigation. */
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const { open: openTelegram, busy: tgBusy } = useTelegramLink();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  function renderGroup(label: string, items: NavItem[], extra?: React.ReactNode) {
    return (
      <div key={label}>
        <p className={styles.navLabel}>{label}</p>
        {items.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
            >
              <HugeiconsIcon icon={item.icon} size={18} strokeWidth={1.8} />
              <span>{item.label}</span>
            </Link>
          );
        })}
        {extra}
      </div>
    );
  }

  /* Telegram is one of the surfaces you talk to the agent through, so it sits
   * with Compose and Auto Agent under "Agent" and looks exactly like them. It's
   * a button rather than a Link because the destination is a one-time linking
   * URL minted per click (see use-telegram-link.ts), not a static route. */
  const telegramItem = (
    <button
      type="button"
      className={styles.navItem}
      onClick={() => {
        openTelegram();
        onNavigate();
      }}
      disabled={tgBusy}
      title="Open the Yoinky bot in Telegram"
    >
      <HugeiconsIcon icon={TelegramIcon} size={18} strokeWidth={1.8} />
      <span>{tgBusy ? "Opening…" : "Telegram"}</span>
    </button>
  );

  /* Feedback sits under Account, right below Settings. It's a button (not a
   * Link) because it opens a popup rather than navigating to a route. */
  const feedbackItem = (
    <button
      type="button"
      className={styles.navItem}
      onClick={() => {
        setFeedbackOpen(true);
        onNavigate();
      }}
      title="Send a feature request or bug report"
    >
      <HugeiconsIcon icon={ChatFeedbackIcon} size={18} strokeWidth={1.8} />
      <span>Feedback</span>
    </button>
  );

  return (
    <aside className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`} aria-label="Yoinky navigation">
      <div className={styles.brandRow}>
        <img src="/favicon.png" alt="" className={styles.dot} />
        Yoinky
      </div>

      {/* Mobile-only: the top bar's compact Telegram icon covers Telegram there,
       *  but the trial "Add card" CTA lives here instead, under the menu. */}
      {trial && (
        <div className={styles.mobileTrial}>
          <TrialPill trial={trial} />
        </div>
      )}

      <nav className={styles.nav}>
        {renderGroup("Agent", AGENT_NAV, telegramItem)}
        {renderGroup("Grow", GROW_NAV)}
        {renderGroup("Account", ACCOUNT_NAV, feedbackItem)}
      </nav>

      {/* Pinned to the floor of the sidebar via `margin-top: auto` — switching
        * here swaps the whole workspace (a Clerk session maps 1:1 to a `users`
        * row), which is why it sits apart from the nav groups rather than
        * inside "Account". */}
      <AccountSwitcher onNavigate={onNavigate} />

      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </aside>
  );
}
