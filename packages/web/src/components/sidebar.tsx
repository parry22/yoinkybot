"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  InboxIcon,
  Knowledge01Icon,
  QuillWrite02Icon,
  FolderLibraryIcon,
  Plug01Icon,
  Settings05Icon,
} from "@hugeicons/core-free-icons";
import type { TrialInfo, WorkspaceSummary } from "@yoink/backend/web";
import { TrialPill } from "./trial-banner";
import { AccountSwitcher } from "./account-switcher";
import styles from "./sidebar.module.css";

type NavItem = { href: string; label: string; icon: typeof InboxIcon };

const PRIMARY_NAV: NavItem[] = [
  { href: "/app", label: "Inbox", icon: InboxIcon },
  { href: "/app/knowledge", label: "Knowledge", icon: Knowledge01Icon },
  { href: "/app/studio", label: "Studio", icon: QuillWrite02Icon },
  { href: "/app/assets", label: "Assets", icon: FolderLibraryIcon },
  { href: "/app/integrations", label: "Integrations", icon: Plug01Icon },
];

export function Sidebar({
  open,
  trial,
  workspaces,
  onNavigate,
}: {
  open: boolean;
  trial: TrialInfo | null;
  workspaces: WorkspaceSummary[];
  onNavigate: () => void;
}) {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/app") return pathname === "/app";
    return pathname.startsWith(href);
  }

  return (
    <aside className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`} aria-label="Yoinky navigation">
      <div className={styles.brand}>
        <img src="/favicon.png" alt="Yoinky" className={styles.brandMark} />
      </div>

      {trial && (
        <div className={styles.mobileTrial}>
          <TrialPill trial={trial} />
        </div>
      )}

      <nav className={styles.nav}>
        {PRIMARY_NAV.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
            >
              <HugeiconsIcon icon={item.icon} size={20} strokeWidth={1.7} />
              <span className={styles.navLabel} role="tooltip">
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className={styles.footer}>
        <Link
          href="/app/settings"
          onClick={onNavigate}
          className={`${styles.navItem} ${isActive("/app/settings") ? styles.navItemActive : ""}`}
          aria-label="Settings"
          aria-current={isActive("/app/settings") ? "page" : undefined}
        >
          <HugeiconsIcon icon={Settings05Icon} size={20} strokeWidth={1.7} />
          <span className={styles.navLabel} role="tooltip">
            Settings
          </span>
        </Link>
        <AccountSwitcher onNavigate={onNavigate} compact workspaces={workspaces} />
      </div>
    </aside>
  );
}
