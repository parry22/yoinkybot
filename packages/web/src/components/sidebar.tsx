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
  BookOpen01Icon,
  NoteIcon,
  Share08Icon,
  Analytics01Icon,
  Edit02Icon,
  Calendar03Icon,
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

const SECONDARY_NAV: NavItem[] = [
  { href: "/app/narrative", label: "Narrative", icon: BookOpen01Icon },
  { href: "/app/briefs", label: "Briefs", icon: NoteIcon },
  { href: "/app/distribution", label: "Distribution", icon: Share08Icon },
  { href: "/app/analytics", label: "Analytics", icon: Analytics01Icon },
  { href: "/app/compose", label: "Compose", icon: Edit02Icon },
  { href: "/app/scheduled", label: "Scheduled", icon: Calendar03Icon },
];

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
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
}

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
        {PRIMARY_NAV.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} onNavigate={onNavigate} />
        ))}
        <div className={styles.navDivider} aria-hidden="true" />
        {SECONDARY_NAV.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} onNavigate={onNavigate} />
        ))}
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
