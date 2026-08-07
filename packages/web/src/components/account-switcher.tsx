"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useClerk, useSessionList, useUser } from "@clerk/nextjs";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Building02Icon,
  Logout03Icon,
  Settings02Icon,
  Tick02Icon,
  UnfoldMoreIcon,
  UserAdd01Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import type { WorkspaceSummary } from "@yoink/backend/web";
import styles from "./account-switcher.module.css";

export function AccountSwitcher({
  onNavigate,
  compact = false,
  workspaces = [],
}: {
  onNavigate?: () => void;
  compact?: boolean;
  workspaces?: WorkspaceSummary[];
}) {
  const { user, isLoaded: userLoaded } = useUser();
  const { sessions, setActive, isLoaded: sessionsLoaded } = useSessionList();
  const { openUserProfile, openSignIn, signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [switchingWorkspace, setSwitchingWorkspace] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!userLoaded || !user) return null;

  const label = (u: { fullName?: string | null; primaryEmailAddress?: { emailAddress: string } | null }) =>
    u.fullName?.trim() || u.primaryEmailAddress?.emailAddress || "Account";
  const email = (u: { primaryEmailAddress?: { emailAddress: string } | null }) =>
    u.primaryEmailAddress?.emailAddress ?? "";

  const others = (sessions ?? []).filter((s) => s.user && s.user.id !== user.id);

  async function switchTo(sessionId: string) {
    if (!setActive) return;
    setSwitchingTo(sessionId);
    try {
      await setActive({
        session: sessionId,
        navigate: async ({ decorateUrl }) => {
          window.location.href = decorateUrl("/app");
        },
      });
    } catch (err) {
      console.error("account switch failed", err);
      setSwitchingTo(null);
    }
  }

  async function selectWorkspace(workspaceId: string) {
    const active = workspaces.find((workspace) => workspace.active);
    if (workspaceId === active?.id) {
      setOpen(false);
      return;
    }
    setSwitchingWorkspace(workspaceId);
    setWorkspaceError("");
    const response = await fetch("/api/workspaces", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (response.ok) {
      window.location.assign("/app");
      return;
    }
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    setWorkspaceError(data.error ?? "Could not switch workspace.");
    setSwitchingWorkspace(null);
  }

  return (
    <div className={`${styles.wrap} ${compact ? styles.wrapCompact : ""}`} ref={wrapRef}>
      {open && (
        <div className={`${styles.menu} ${compact ? styles.menuCompact : ""}`} role="menu">
          {others.length > 0 && (
            <>
              <p className={styles.menuLabel}>Switch to</p>
              {others.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  disabled={switchingTo !== null}
                  onClick={() => switchTo(s.id)}
                >
                  <img src={s.user!.imageUrl} alt="" className={styles.avatarSm} />
                  <span className={styles.menuText}>
                    <span className={styles.menuName}>{label(s.user!)}</span>
                    {email(s.user!) && <span className={styles.menuMail}>{email(s.user!)}</span>}
                  </span>
                  {switchingTo === s.id && <span className={styles.switching}>…</span>}
                </button>
              ))}
              <div className={styles.divider} />
            </>
          )}

          <p className={styles.menuLabel}>Signed in as</p>
          <div className={`${styles.menuItem} ${styles.menuItemStatic}`}>
            <img src={user.imageUrl} alt="" className={styles.avatarSm} />
            <span className={styles.menuText}>
              <span className={styles.menuName}>{label(user)}</span>
              {email(user) && <span className={styles.menuMail}>{email(user)}</span>}
            </span>
            <HugeiconsIcon icon={Tick02Icon} size={15} strokeWidth={2.2} className={styles.tick} />
          </div>

          {workspaces.length > 0 && (
            <>
              <div className={styles.divider} />
              <p className={styles.menuLabel}>Workspaces</p>
              {workspaceError && <p className={styles.menuError}>{workspaceError}</p>}
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  disabled={switchingWorkspace !== null}
                  onClick={() => void selectWorkspace(workspace.id)}
                >
                  <span className={styles.workspaceMark}>
                    <HugeiconsIcon
                      icon={workspace.workspaceType === "company" ? Building02Icon : UserCircleIcon}
                      size={15}
                    />
                  </span>
                  <span className={styles.menuText}>
                    <span className={styles.menuName}>{workspace.name}</span>
                    <span className={styles.menuMail}>{workspace.role}</span>
                  </span>
                  {workspace.active && <HugeiconsIcon icon={Tick02Icon} size={15} className={styles.tick} />}
                  {switchingWorkspace === workspace.id && <span className={styles.switching}>…</span>}
                </button>
              ))}
              <Link
                href="/app/workspaces/new"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
              >
                <HugeiconsIcon icon={Add01Icon} size={17} strokeWidth={1.8} />
                <span className={styles.menuText}>Add workspace</span>
              </Link>
            </>
          )}

          <div className={styles.divider} />

          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              openSignIn({});
            }}
          >
            <HugeiconsIcon icon={UserAdd01Icon} size={17} strokeWidth={1.8} />
            <span className={styles.menuText}>Add another account</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              onNavigate?.();
              openUserProfile();
            }}
          >
            <HugeiconsIcon icon={Settings02Icon} size={17} strokeWidth={1.8} />
            <span className={styles.menuText}>Manage account</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.signOut}`}
            onClick={() => {
              setOpen(false);
              void signOut({ redirectUrl: "/" });
            }}
          >
            <HugeiconsIcon icon={Logout03Icon} size={17} strokeWidth={1.8} />
            <span className={styles.menuText}>Sign out</span>
          </button>
        </div>
      )}

      <button
        type="button"
        className={`${styles.trigger} ${compact ? styles.triggerCompact : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={email(user) || label(user)}
        aria-label={email(user) || label(user)}
        disabled={!sessionsLoaded}
      >
        <img src={user.imageUrl} alt="" className={styles.avatar} />
        <span className={styles.triggerText}>
          <span className={styles.triggerName}>{label(user)}</span>
          {email(user) && <span className={styles.triggerMail}>{email(user)}</span>}
        </span>
        <HugeiconsIcon icon={UnfoldMoreIcon} size={16} strokeWidth={1.8} className={styles.chev} />
      </button>
    </div>
  );
}
