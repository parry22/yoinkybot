"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SparklesIcon } from "@hugeicons/core-free-icons";
import panel from "./panel.module.css";
import styles from "./agent.module.css";

type Scheduled = { id: string; platform: string; content: string; scheduledFor: string };
type AgentState = { enabled: boolean; scheduled: Scheduled[] };

const STEPS = [
  { t: "Finds the right topics", d: "It scans your niche and your own backlog of unsaid ideas for what's worth posting now." },
  { t: "Drafts in your voice", d: "Each post is written from your own thinking, in the voice it learned from your X." },
  { t: "Schedules at the right time", d: "Posts land in your queue at a sensible slot, cancellable before they go out." },
  { t: "Learns from performance", d: "It watches what lands and leans into what works. See Analytics for the read." },
];

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function Automation({
  initialState,
  topPosts,
}: {
  initialState: AgentState;
  topPosts: { text: string; impressions: number }[];
}) {
  const [state, setState] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function toggle() {
    const next = !state.enabled;
    setState((s) => ({ ...s, enabled: next }));
    await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "toggle", on: next }),
    }).catch(() => setState((s) => ({ ...s, enabled: !next })));
  }

  async function runNow() {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      });
      const data = await res.json();
      setMsg(data.result?.message ?? "done");
      if (data.state) setState(data.state);
    } catch {
      setMsg("network error, try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <div className={panel.head}>
          <div>
            <div className={panel.title}>Automation</div>
            <div className={panel.subtitle}>Let Yoinky run the whole loop for you: find, draft, and schedule on autopilot.</div>
          </div>
        </div>

        <div className={`${styles.toggleCard} ${state.enabled ? styles.toggleCardOn : ""}`}>
          <div>
            <div className={styles.toggleTitle}>Autopilot {state.enabled ? "is on" : "is off"}</div>
            <div className={styles.toggleDesc}>
              When on, Yoinky runs a full cycle for you about once a day. Nothing posts without a review window,
              everything it queues is cancellable before it goes out.
            </div>
          </div>
          <button
            className={`${styles.switch} ${state.enabled ? styles.switchOn : ""}`}
            onClick={toggle}
            aria-label="Toggle autopilot"
          >
            <span className={styles.knob} />
          </button>
        </div>

        <div className={panel.section}>
          <div className={panel.sectionLabel}>What autopilot does each cycle</div>
          {STEPS.map((s, i) => (
            <div key={i} className={styles.stepRow} style={{ alignItems: "flex-start" }}>
              <span className={styles.stepNum}>{i + 1}</span>
              <span>
                <b style={{ color: "var(--ink-900)" }}>{s.t}.</b> {s.d}
              </span>
            </div>
          ))}
          <div className={styles.runRow} style={{ marginTop: 16 }}>
            <button className="btnPrimary" onClick={runNow} disabled={busy}>
              <HugeiconsIcon icon={SparklesIcon} size={15} strokeWidth={1.8} />
              {busy ? "Running a cycle…" : "Run one cycle now"}
            </button>
            {msg && <span className={styles.runMsg}>{msg}</span>}
          </div>
        </div>

        <div className={panel.section}>
          <div className={panel.sectionLabel}>Queued by autopilot ({state.scheduled.length})</div>
          {state.scheduled.length === 0 ? (
            <div className={styles.emptyNote}>Nothing queued yet. Turn autopilot on, or run a cycle now.</div>
          ) : (
            state.scheduled.map((p) => (
              <div key={p.id} className={styles.queueRow}>
                <div className={styles.queueWhen}>X · {whenLabel(p.scheduledFor)}</div>
                <div className={styles.queueContent}>{p.content}</div>
              </div>
            ))
          )}
        </div>

        {topPosts.length > 0 && (
          <div className={panel.section}>
            <div className={panel.sectionLabel}>What it learns from (your top posts)</div>
            {topPosts.slice(0, 5).map((p, i) => (
              <div key={i} className={styles.stepRow} style={{ alignItems: "flex-start" }}>
                <span className={styles.stepNum}>{i + 1}</span>
                <span>
                  {p.text.length > 110 ? p.text.slice(0, 110) + "…" : p.text}
                  <b style={{ color: "var(--ink-900)", marginLeft: 6 }}>
                    {p.impressions >= 1000 ? (p.impressions / 1000).toFixed(1) + "k" : p.impressions} impressions
                  </b>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
