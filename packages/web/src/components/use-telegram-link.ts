"use client";

import { useState } from "react";

/**
 * Opens the Yoinky Telegram bot through a one-time link token
 * (`POST /api/telegram/link` → `?start=<token>`) so `/start` links this Clerk
 * account to the chat on open — a plain t.me link arrives unlinked and the
 * auth-gated bot turns it away. Shared by the sidebar's "Telegram Bot" item and
 * the mobile header's icon button so both stay consistent.
 */
export function useTelegramLink() {
  const [busy, setBusy] = useState(false);

  async function open() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/telegram/link", { method: "POST" });
      const data = await res.json();
      if (data.url) window.open(data.url, "_blank", "noopener,noreferrer");
    } catch {
      /* transient failure — the user can tap again */
    } finally {
      setBusy(false);
    }
  }

  return { open, busy };
}
