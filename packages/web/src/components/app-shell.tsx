"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { TrialInfo } from "@yoink/backend/web";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { MobileHeader } from "./mobile-header";
import styles from "@/app/app/shell.module.css";

/**
 * Client wrapper coordinating the mobile drawer's open/closed state between
 * the mobile header's hamburger button and the sidebar itself - the two live
 * in separate components and layout.tsx is a server component, so this is the
 * one place that actually owns `navOpen`. On desktop none of this state matters
 * (the sidebar is always visible via CSS; the mobile header renders nothing).
 */
export function AppShell({ trial, children }: { trial: TrialInfo | null; children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();

  // Tapping a nav link inside the drawer should close it.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Rotating a device or resizing past the mobile breakpoint with the drawer
  // open shouldn't leave a stale backdrop sitting over the desktop layout.
  useEffect(() => {
    function onResize() {
      if (window.innerWidth > 1000) setNavOpen(false);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div className={styles.platform}>
      <MobileHeader open={navOpen} onToggle={() => setNavOpen((v) => !v)} />
      {navOpen && <div className={styles.backdrop} onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <Sidebar open={navOpen} trial={trial} onNavigate={() => setNavOpen(false)} />
      <main className={styles.workspace}>
        {/* No telegramUrl prop any more: all three Telegram entry points (sidebar,
            mobile header, top bar) mint their own start-token link via
            useTelegramLink, so the bare bot URL isn't threaded through here. */}
        <TopBar trial={trial} />
        <div className={styles.content}>{children}</div>
      </main>
    </div>
  );
}
