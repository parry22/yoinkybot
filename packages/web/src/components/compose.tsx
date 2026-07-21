"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import panel from "./panel.module.css";
import styles from "./compose.module.css";

type Draft = { id: string; content: string; platform: string; created_at?: string };

export function Compose({ initialDrafts }: { initialDrafts: Draft[] }) {
  const platform = "x" as const;
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>(initialDrafts);

  async function write() {
    const t = topic.trim();
    if (!t || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, topic: t }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't write that one.");
      } else {
        const fresh: Draft[] = (data.messages ?? []).map((content: string, i: number) => ({
          id: `new-${Date.now()}-${i}`,
          content,
          platform,
        }));
        setDrafts((d) => [...fresh, ...d]);
        setTopic("");
      }
    } catch {
      setError("Network error - try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <div className={panel.head}>
          <div>
            <div className={panel.title}>Compose</div>
            <div className={panel.subtitle}>Turn a thought into a post in your voice.</div>
          </div>
        </div>

        <div className={styles.composer}>
          <textarea
            className={styles.input}
            placeholder='What&apos;s the post about? e.g. "the lesson from shipping the redesign"'
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
          <div className={styles.composerFooter}>
            <span className={styles.hint}>{error || "Writing for X"}</span>
            <button className="btnPrimary" disabled={busy || !topic.trim()} onClick={write}>
              {busy ? "Writing…" : "Write it"}
            </button>
          </div>
        </div>

        {drafts.length > 0 && (
          <>
            <div className={styles.sectionLabel}>Drafts</div>
            {drafts.map((d) => (
              <DraftCard key={d.id} draft={d} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function DraftCard({ draft }: { draft: Draft }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(draft.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked - no-op */
    }
  }
  return (
    <div className={styles.draftCard}>
      <div className={styles.draftTop}>
        <span className="pill">{draft.platform === "linkedin" ? "LinkedIn" : "X"}</span>
        <button className={styles.copyBtn} onClick={copy}>
          <HugeiconsIcon icon={copied ? CheckmarkCircle02Icon : Copy01Icon} size={14} strokeWidth={1.8} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className={styles.draftBody}>{draft.content}</div>
    </div>
  );
}
