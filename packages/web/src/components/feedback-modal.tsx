"use client";

import { useState } from "react";
import { Modal } from "./modal";
import styles from "./feedback-modal.module.css";

type FeedbackType = "feature_request" | "bug_report";

/** The second dropdown's options depend on the first choice (feature vs bug). */
const CATEGORIES: Record<FeedbackType, string[]> = {
  feature_request: [
    "Compose & drafting",
    "Auto Agent",
    "Buyers Radar",
    "Analytics",
    "Growth",
    "Scheduling",
    "Telegram",
    "Billing & plans",
    "Something else",
  ],
  bug_report: [
    "Something's broken",
    "Wrong or confusing result",
    "Visual glitch",
    "Slow or stuck",
    "Data looks wrong",
    "Billing issue",
  ],
};

const TYPE_LABEL: Record<FeedbackType, string> = {
  feature_request: "Feature request",
  bug_report: "Bug report",
};

/**
 * The Account → Feedback popup: pick Feature Request or Bug Report, then a
 * category whose options follow from that pick, then a message. Posts to
 * /api/feedback and resets on success.
 */
export function FeedbackModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [type, setType] = useState<FeedbackType>("feature_request");
  const [category, setCategory] = useState(CATEGORIES.feature_request[0]!);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setType("feature_request");
    setCategory(CATEGORIES.feature_request[0]!);
    setMessage("");
    setBusy(false);
    setDone(false);
    setErr(null);
  }

  function close() {
    reset();
    onClose();
  }

  function onTypeChange(next: FeedbackType) {
    setType(next);
    // The category list changes with the type, so reset to that list's first.
    setCategory(CATEGORIES[next][0]!);
  }

  async function submit() {
    if (!message.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, category, message: message.trim() }),
      });
      if (!res.ok) {
        setErr("Couldn't send that — please try again.");
        return;
      }
      setDone(true);
    } catch {
      setErr("Couldn't send that — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close}>
      {done ? (
        <div className={styles.doneWrap}>
          <div className={styles.doneTitle}>Thanks — got it.</div>
          <p className={styles.doneBody}>
            Your {TYPE_LABEL[type].toLowerCase()} is in front of the team. We read every one.
          </p>
          <button className="btnPrimary" onClick={close}>
            Done
          </button>
        </div>
      ) : (
        <div className={styles.form}>
          <div className={styles.title}>Send feedback</div>
          <p className={styles.sub}>Tell us what to build next, or what went wrong.</p>

          <label className={styles.field}>
            <span className={styles.label}>What is it?</span>
            <select
              className={styles.select}
              value={type}
              onChange={(e) => onTypeChange(e.target.value as FeedbackType)}
            >
              <option value="feature_request">Feature request</option>
              <option value="bug_report">Bug report</option>
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{type === "bug_report" ? "What kind of problem?" : "Which part?"}</span>
            <select className={styles.select} value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES[type].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{type === "bug_report" ? "What happened?" : "What would you like?"}</span>
            <textarea
              className={styles.textarea}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder={
                type === "bug_report"
                  ? "What you did, what you expected, what happened instead…"
                  : "Describe the feature and what it would help you do…"
              }
              autoFocus
            />
          </label>

          {err && <div className={styles.err}>{err}</div>}

          <div className={styles.actions}>
            <button className="btnGhost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btnPrimary" onClick={submit} disabled={busy || !message.trim()}>
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
