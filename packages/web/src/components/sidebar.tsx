"use client";

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
    </aside>
  );
}
