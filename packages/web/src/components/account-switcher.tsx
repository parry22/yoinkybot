"use client";

import { useEffect, useRef, useState } from "react";
import { useClerk, useSessionList, useUser } from "@clerk/nextjs";
import { HugeiconsIcon } from "@hugeicons/react";
import { UnfoldMoreIcon, UserAdd01Icon, Settings02Icon, Logout03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import styles from "./account-switcher.module.css";

/**
 * The account switcher, pinned to the bottom of the sidebar.
 *
 * WHY THIS IS A REAL FEATURE HERE, not just a login menu: a Clerk session maps
 * 1:1 to a `users` row via `clerk_user_id` (lib/session.ts), and everything -
 * the connected X account, the memory graph, the diagnosis, the plan, the
 * billing - hangs off that row. So switching accounts switches the entire
 * workspace. That's the agency/multi-brand case: run your own brand and a
 * client's without signing out and back in.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PREREQUISITE: the Clerk instance must have multi-session ENABLED.
 * As of writing, production has `single_session_mode: true`, which means Clerk
 * will only ever hold ONE session on the client - `sessions` below always has
 * length 1 and there is nothing to switch to. It's a dashboard-only toggle
 * (Clerk exposes no Backend API for it, same as social connections):
 *   Clerk dashboard → Configure → Sessions → "Multi-session handling".
 * Verify with:
 *   curl -s "https://clerk.meetyoinky.com/v1/environment?_clerk_js_version=5" \
 *     -H "Origin: https://app.meetyoinky.com" | jq .auth_config.single_session_mode
 * The component is written to be CORRECT EITHER WAY - with one session it is a
 * clean account menu, and it grows the switcher list the moment a second
 * session can exist. Nothing here breaks or misleads while the toggle is off.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function AccountSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { user, isLoaded: userLoaded } = useUser();
  const { sessions, setActive, isLoaded: sessionsLoaded } = useSessionList();
  const { openUserProfile, openSignIn, signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape. Both matter: this sits at the very bottom
  // of a fixed drawer on mobile, where a stray tap elsewhere should dismiss it.
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

  // Every OTHER signed-in session. Empty under single-session mode, which is
  // why the "Switch to" group below renders conditionally rather than showing
  // an empty heading.
  const others = (sessions ?? []).filter((s) => s.user && s.user.id !== user.id);

  async function switchTo(sessionId: string) {
    if (!setActive) return;
    setSwitchingTo(sessionId);
    try {
      await setActive({
        session: sessionId,
        // A FULL document load, deliberately - not router.push. Switching the
        // session changes which `users` row every server component reads, and
        // Next's client router cache would happily serve the previous account's
        // rendered output (their drafts, their diagnosis, their plan). Showing
        // one account's data under another's name is the one failure this
        // feature must not have, so correctness beats the snappier transition.
        navigate: async ({ decorateUrl }) => {
          window.location.href = decorateUrl("/app");
        },
      });
    } catch (err) {
      console.error("account switch failed", err);
      setSwitchingTo(null);
    }
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      {open && (
        <div className={styles.menu} role="menu">
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

          {/* Current account, marked - so the menu always answers "who am I?"
            * even when there is only one session and nothing to switch to. */}
          <p className={styles.menuLabel}>Signed in as</p>
          <div className={`${styles.menuItem} ${styles.menuItemStatic}`}>
            <img src={user.imageUrl} alt="" className={styles.avatarSm} />
            <span className={styles.menuText}>
              <span className={styles.menuName}>{label(user)}</span>
              {email(user) && <span className={styles.menuMail}>{email(user)}</span>}
            </span>
            <HugeiconsIcon icon={Tick02Icon} size={15} strokeWidth={2.2} className={styles.tick} />
          </div>

          <div className={styles.divider} />

          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              // Under multi-session this adds a second account and leaves the
              // current one signed in. Under single-session Clerk handles the
              // flow itself rather than us guessing at its behaviour.
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
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={email(user) || label(user)}
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
