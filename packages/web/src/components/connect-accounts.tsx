"use client";

import { useState } from "react";
import styles from "./connect-accounts.module.css";

type Account = {
  platform: string;
  handle: string;
  status: string;
  post_count: number;
  last_ingested_at: string | null;
};

export function ConnectAccounts({ initial }: { initial: Account[] }) {
  const [accounts] = useState<Account[]>(initial);
  const [xHandle, setXHandle] = useState("");
  const [liUrl, setLiUrl] = useState("");
  const [busy, setBusy] = useState<"x" | "linkedin" | null>(null);
  const [msg, setMsg] = useState("");

  async function connect(platform: "x" | "linkedin", handle: string) {
    if (!handle.trim() || busy) return;
    setBusy(platform);
    setMsg("");
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, handle: handle.trim() }),
      });
      const data = await res.json();
      setMsg(res.ok ? (data.messages ?? []).join("\n") || "Started." : data.error ?? "Couldn't start that.");
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {accounts.length > 0 &&
        accounts.map((a) => (
          <div key={a.platform} className={styles.account}>
            <div className={styles.accountLeft}>
              <div className={styles.accountHandle}>{a.handle}</div>
              <div className={styles.accountPlatform}>{a.platform === "linkedin" ? "LinkedIn" : "X"}</div>
            </div>
            <span className={`${styles.statusPill} ${a.status === "ingested" ? styles.statusIngested : ""}`}>
              {a.status === "ingested" ? `read · ${a.post_count} posts` : a.status}
            </span>
          </div>
        ))}

      <div className={styles.rowLabel}>Connect X</div>
      <div className={styles.form}>
        <input
          className="field"
          placeholder="@yourhandle"
          value={xHandle}
          onChange={(e) => setXHandle(e.target.value)}
        />
        <button className="btnGhost" disabled={busy === "x" || !xHandle.trim()} onClick={() => connect("x", xHandle)}>
          {busy === "x" ? "Starting…" : "Connect"}
        </button>
      </div>

      <div className={styles.rowLabel}>Connect LinkedIn</div>
      <div className={styles.form}>
        <input
          className="field"
          placeholder="https://linkedin.com/in/you"
          value={liUrl}
          onChange={(e) => setLiUrl(e.target.value)}
        />
        <button
          className="btnGhost"
          disabled={busy === "linkedin" || !liUrl.trim()}
          onClick={() => connect("linkedin", liUrl)}
        >
          {busy === "linkedin" ? "Starting…" : "Connect"}
        </button>
      </div>

      {msg && <p className={styles.msg}>{msg}</p>}
    </div>
  );
}
