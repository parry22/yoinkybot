"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link01Icon } from "@hugeicons/core-free-icons";
import styles from "./connect-accounts.module.css";

type Account = { handle: string; status: string } | null;

/* How far the account has got, in words. The pill used to read "read · 82 posts";
 * the corpus size is an implementation detail — it invites the user to judge
 * whether 82 is enough instead of just telling them the account is ready. */
const STATUS_LABEL: Record<string, string> = {
  ingested: "connected",
  ingesting: "reading your posts…",
  pending: "starting…",
  failed: "couldn't read this account",
  posting_connected: "posting connected",
};

/** X connection status + a reconnect link (goes through the web X OAuth). */
export function XConnectRow({ account }: { account: Account }) {
  return (
    <div>
      {account && (
        <div className={styles.account}>
          <div className={styles.accountLeft}>
            <div className={styles.accountHandle}>{account.handle}</div>
            <div className={styles.accountPlatform}>X</div>
          </div>
          <span className={`${styles.statusPill} ${account.status === "ingested" ? styles.statusIngested : ""}`}>
            {STATUS_LABEL[account.status] ?? account.status}
          </span>
        </div>
      )}

      <div className={styles.connectRow}>
        <a href="/api/auth/x/start" className="btnGhost">
          <HugeiconsIcon icon={Link01Icon} size={14} strokeWidth={1.8} />
          {account ? "Reconnect X" : "Connect X"}
        </a>
      </div>
    </div>
  );
}

/** LinkedIn has two intentionally separate pieces: official OAuth for member
 * publishing, and a public profile URL for voice/performance history. */
export function LinkedInConnectRow({ account }: { account: Account }) {
  const [profileUrl, setProfileUrl] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function connectHistory() {
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/connect/linkedin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMessage(data.error ?? "could not connect LinkedIn history");
      else {
        setMessage("Reading your LinkedIn posts now. Metrics and voice evidence will update automatically.");
        setProfileUrl("");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {account && (
        <div className={styles.account}>
          <div className={styles.accountLeft}>
            <div className={styles.accountHandle}>{account.handle}</div>
            <div className={styles.accountPlatform}>LinkedIn</div>
          </div>
          <span className={`${styles.statusPill} ${account.status === "ingested" ? styles.statusIngested : ""}`}>
            {STATUS_LABEL[account.status] ?? account.status}
          </span>
        </div>
      )}

      <div className={styles.connectRow}>
        <a href="/api/auth/linkedin/start" className="btnGhost">
          <HugeiconsIcon icon={Link01Icon} size={14} strokeWidth={1.8} />
          {account ? "Reconnect LinkedIn posting" : "Connect LinkedIn posting"}
        </a>
      </div>
      <div className={styles.connectRow} style={{ alignItems: "stretch", marginTop: 10 }}>
        <input
          value={profileUrl}
          onChange={(event) => setProfileUrl(event.target.value)}
          placeholder="https://www.linkedin.com/in/your-name"
          aria-label="LinkedIn profile URL"
          style={{ flex: 1, minWidth: 240, padding: "9px 11px", borderRadius: 8, border: "1px solid var(--border)" }}
        />
        <button className="btnGhost" onClick={() => void connectHistory()} disabled={saving || !profileUrl.trim()}>
          {saving ? "Connecting…" : account?.status === "ingested" ? "Refresh profile" : "Read my posts"}
        </button>
      </div>
      {message && <div style={{ marginTop: 8, fontSize: 13 }}>{message}</div>}
    </div>
  );
}
