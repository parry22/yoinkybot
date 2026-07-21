"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { TelegramIcon } from "@hugeicons/core-free-icons";

/** Opens the bot with a short-lived link token so /start links this web account
 *  to Telegram (idempotent if already linked). */
export function TelegramConnectButton({ linked }: { linked: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function go() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/telegram/link", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.open(data.url, "_blank", "noopener,noreferrer");
      } else {
        setError("Couldn't open that. Try again.");
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      {linked && <span className="pill pillAccent">Linked</span>}
      <button type="button" className="btnGhost" onClick={go} disabled={busy}>
        <HugeiconsIcon icon={TelegramIcon} size={16} strokeWidth={1.8} />
        {busy ? "Opening…" : "Go to Telegram"}
      </button>
      {error && <span style={{ fontSize: 12, color: "var(--ink-600)" }}>{error}</span>}
    </div>
  );
}
