"use client";

import { useState } from "react";
import type { ByokStatus, KeyProvider } from "@yoink/backend/web";
import styles from "./byok-settings.module.css";

const LABELS: Record<KeyProvider, string> = {
  openrouter: "Model key (OpenRouter)",
  twitterapi: "Reader key (twitterapi.io)",
  apify: "Reader key (Apify)",
};

const ORDER: KeyProvider[] = ["openrouter", "twitterapi", "apify"];

/**
 * BYOK key management for a lifetime user, in Settings.
 *
 * Mirrors the setup gate but for the ongoing case: rotate a key, or remove one.
 * A stored key is never displayed — only its last four characters, which is
 * enough to answer "which key is this?" without the page ever holding the
 * secret. Replacing means pasting a new one; there is no reveal.
 */
export function ByokSettings({ initial }: { initial: ByokStatus }) {
  const [status, setStatus] = useState<ByokStatus>(initial);
  const [editing, setEditing] = useState<KeyProvider | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const byProvider = new Map(status.keys.map((k) => [k.provider, k]));

  async function save(provider: KeyProvider) {
    if (!value.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/byok", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, key: value.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; status?: ByokStatus };
      if (!res.ok || !data.status) {
        setErr(data.error ?? "Couldn't save that key.");
        return;
      }
      setStatus(data.status);
      setEditing(null);
      setValue("");
    } catch {
      setErr("Network dropped — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(provider: KeyProvider) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/byok?provider=${provider}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { status?: ByokStatus };
      if (data.status) setStatus(data.status);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className={styles.lede}>
        Yoinky runs on your own keys, so usage bills to you at cost with nothing capped.
        {!status.complete && " Some features stay off until both a model key and a reader key are in."}
      </p>

      {ORDER.map((provider) => {
        const k = byProvider.get(provider);
        const isEditing = editing === provider;
        return (
          <div key={provider} className={styles.row}>
            <div className={styles.info}>
              <span className={styles.label}>{LABELS[provider]}</span>
              <span className={styles.value}>
                {k ? (
                  <>
                    ····{k.last4}
                    {k.validatedAt ? <span className={styles.ok}> · working</span> : <span className={styles.warn}> · unverified</span>}
                  </>
                ) : (
                  <span className={styles.none}>not set</span>
                )}
              </span>
            </div>

            {isEditing ? (
              <div className={styles.editRow}>
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the new key"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && save(provider)}
                  autoFocus
                />
                <button className="btnGhost" onClick={() => save(provider)} disabled={busy || !value.trim()}>
                  {busy ? "Checking…" : "Save"}
                </button>
                <button
                  className="btnGhost"
                  onClick={() => {
                    setEditing(null);
                    setValue("");
                    setErr(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className={styles.actions}>
                <button
                  className="btnGhost"
                  onClick={() => {
                    setEditing(provider);
                    setValue("");
                    setErr(null);
                  }}
                >
                  {k ? "Replace" : "Add"}
                </button>
                {k && (
                  <button className="btnGhost" onClick={() => remove(provider)} disabled={busy}>
                    Remove
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {err && <div className={styles.err}>{err}</div>}
    </div>
  );
}
