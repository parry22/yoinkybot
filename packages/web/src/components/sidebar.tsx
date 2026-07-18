"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BubbleChatIcon,
  QuillWrite02Icon,
  Calendar03Icon,
  Settings05Icon,
  Logout01Icon,
  Sun03Icon,
  Moon02Icon,
} from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";
import styles from "./sidebar.module.css";

type NavItem = { href: string; label: string; icon: typeof BubbleChatIcon };

const NAV: NavItem[] = [
  { href: "/app", label: "Chat", icon: BubbleChatIcon },
  { href: "/app/compose", label: "Compose", icon: QuillWrite02Icon },
  { href: "/app/scheduled", label: "Scheduled", icon: Calendar03Icon },
  { href: "/app/settings", label: "Settings", icon: Settings05Icon },
];

export function Sidebar({
  user,
  onboarding,
}: {
  user: { email: string; initials: string };
  onboarding: boolean;
}) {
  const pathname = usePathname();

  return (
    <aside className={styles.sidebar} aria-label="Yoinky navigation">
      <div className={styles.brandRow}>
        <img src="/favicon.png" alt="" className={styles.dot} />
        Yoinky
      </div>

      {onboarding && (
        <Link href="/app/onboarding" className="btnPrimary" style={{ marginTop: 18, width: "100%" }}>
          Finish setup
        </Link>
      )}

      <nav className={styles.nav}>
        <p className={styles.navLabel}>Workspace</p>
        {NAV.map((item) => {
          const active = item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
            >
              <HugeiconsIcon icon={item.icon} size={18} strokeWidth={1.8} />
              <span>{item.label}</span>
              {item.href === "/app/onboarding" && onboarding && <span className={styles.badge}>setup</span>}
            </Link>
          );
        })}
      </nav>

      <div className={styles.spacer} />

      <div className={styles.profileRow}>
        <div className={styles.profileLeft}>
          <span className={styles.avatar}>{user.initials}</span>
          <span className={styles.userName}>{user.email}</span>
        </div>
        <div className={styles.actions}>
          <ThemeToggle />
          <form action="/api/auth/logout" method="post">
            <button type="submit" className={styles.iconButton} aria-label="Sign out" title="Sign out">
              <HugeiconsIcon icon={Logout01Icon} size={18} strokeWidth={1.8} />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const stored = (localStorage.getItem("yoink-theme") as "light" | "dark" | null) ?? null;
    const initial =
      stored ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(initial);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("yoink-theme", next);
  }

  return (
    <button type="button" className={styles.iconButton} onClick={toggle} aria-label="Toggle theme" title="Toggle theme">
      <HugeiconsIcon icon={theme === "dark" ? Sun03Icon : Moon02Icon} size={18} strokeWidth={1.8} />
    </button>
  );
}
