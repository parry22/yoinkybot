"use client";

import { useClerk } from "@clerk/nextjs";

/**
 * Opens Clerk's account-management modal (email, password, connected social
 * logins, active sessions, delete account) from Settings - so users manage
 * their auth without leaving the app.
 */
export function ManageAccountButton() {
  const { openUserProfile } = useClerk();
  return (
    <button type="button" className="btnGhost" onClick={() => openUserProfile()}>
      Manage account
    </button>
  );
}
