"use client";

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiMagicIcon, FireIcon, ArchiveIcon } from "@hugeicons/core-free-icons";
import panel from "./panel.module.css";
import { useAgentStream } from "./use-agent-stream";
import styles from "./automations.module.css";

type SourceType = "trend_ride" | "unlock_backlog" | "custom";

interface AutomationView {
  id: string;
  name: string;
  sourceType: SourceType;
  deliveryMode: "approval" | "auto";
  cadenceKind: "daily" | "weekly" | "manual";
  cadenceMeta: Record<string, unknown>;
  monthlyCap: number;
  respectQuietHours: boolean;
  pillarScope: string[] | null;
  brief: string | null;
  enabled: boolean;
  pendingApprovals: number;
  lastRunAt: string | null;
}
interface ApprovalView {
  runId: string;
  automationName: string;
  draft: string;
  media: string | null;
  createdAt: string;
}

const SOURCE_LABEL: Record<SourceType, string> = {
  trend_ride: "Rides trends in your niche",
  unlock_backlog: "Posts from your backlog",
  custom: "Your own brief",
};
const DELIVERY_LABEL: Record<AutomationView["deliveryMode"], string> = {
  approval: "Asks you first",
  auto: "Posts on its own",
};
const CADENCE_LABEL: Record<AutomationView["cadenceKind"], string> = {
  daily: "Daily",
  weekly: "Weekly",
  manual: "Manual",
};

// The three ways to start an agent. Custom is the free-form, govork-style path
// and is the default; the two presets are deterministic sources that can still
// take the brief as extra guidance.
const MODES: { type: SourceType; icon: typeof AiMagicIcon; title: string; blurb: string }[] = [
  { type: "custom", icon: AiMagicIcon, title: "Describe it myself", blurb: "Free-form. Say exactly what to post, in your words." },
  { type: "trend_ride", icon: FireIcon, title: "Ride trends", blurb: "Yoinky watches your niche and rides what's moving." },
  { type: "unlock_backlog", icon: ArchiveIcon, title: "From my backlog", blurb: "Works through the ideas already in your plan." },
];

// Quick prompts that drop a starting sentence into the brief.
const EXAMPLES = [
  "Turn the biggest story in my niche into a punchy take in my voice.",
  "Share one lesson from what I shipped this week.",
  "Take a spicy opinion I'd stand behind and make it a short thread.",
  "Reframe a customer question I keep getting as a helpful post.",
];

interface FormState {
  id: string;
  name: string;
  sourceType: SourceType;
  deliveryMode: AutomationView["deliveryMode"];
  cadenceKind: AutomationView["cadenceKind"];
  monthlyCap: number;
  brief: string;
}

const BLANK: FormState = {
  id: "",
  name: "",
  sourceType: "custom",
  deliveryMode: "approval",
  cadenceKind: "daily",
  monthlyCap: 30,
  brief: "",
};

export function Automations({
  initialAutomations,
  initialApprovals,
  canAutoAgent,
  planCap,
}: {
  initialAutomations: AutomationView[];
  initialApprovals: ApprovalView[];
  /** Scale-only: whether the user's plan allows hands-off AUTO delivery. */
  canAutoAgent: boolean;
  /** Auto Agent posts/month the plan allows (Growth 5 / Scale 90). */
  planCap: number | null;
}) {
  const [automations, setAutomations] = useState(initialAutomations);
  const [approvals, setApprovals] = useState(initialApprovals);
  const [form, setForm] = useState<FormState>({ ...BLANK });
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const { run, activity, busy } = useAgentStream();
  const taRef = useRef<HTMLTextAreaElement>(null);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const editingExisting = Boolean(form.id);

  // Grow the brief box with its content.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`;
  }, [form.brief]);

  async function toggle(a: AutomationView) {
    const next = !a.enabled;
    setAutomations((list) => list.map((x) => (x.id === a.id ? { ...x, enabled: next } : x)));
    await fetch("/api/automations/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: a.id, enabled: next }),
    }).catch(() => {});
  }

  async function refreshApprovals() {
    const res = await fetch("/api/automations/approvals").then((r) => r.json()).catch(() => ({ approvals: [] }));
    setApprovals(res.approvals ?? []);
  }

  /** "Run now" — streamed, so the pipeline shows its work. */
  async function runNow(a: AutomationView) {
    setErr("");
    setNote(null);
    await run(
      "/api/automations/run/stream",
      { id: a.id },
      {
        onMessage: (text) => setNote(text),
        onResult: () => void refreshApprovals(),
        onError: (message, status) =>
          setErr(status === 402 ? "Your trial has ended — upgrade to keep the agent running." : message),
      },
    );
  }

  /** Send the brief: creates (or updates) the agent, streamed. */
  async function submit() {
    if (busy) return;
    if (form.sourceType === "custom" && !form.brief.trim()) {
      setErr("Tell the agent what to do — describe it in the box.");
      return;
    }
    setErr("");
    setNote(null);
    await run(
      "/api/automations/save/stream",
      { ...form, id: form.id || undefined },
      {
        onMessage: (text) => setNote(text),
        onResult: (data) => {
          const view = (data as { automation?: AutomationView } | undefined)?.automation;
          if (view) {
            setAutomations((list) => {
              const exists = list.some((x) => x.id === view.id);
              return exists ? list.map((x) => (x.id === view.id ? view : x)) : [view, ...list];
            });
          }
          setForm({ ...BLANK });
        },
        onError: (message, status) =>
          setErr(status === 402 ? "Auto Agent is a paid feature — upgrade to set one up." : message),
      },
    );
  }

  function loadForEdit(a: AutomationView) {
    setNote(null);
    setErr("");
    setForm({
      id: a.id,
      name: a.name,
      sourceType: a.sourceType,
      deliveryMode: a.deliveryMode,
      cadenceKind: a.cadenceKind,
      monthlyCap: a.monthlyCap,
      brief: a.brief ?? "",
    });
    taRef.current?.focus();
  }

  return (
    <div className={styles.agentRoot}>
      {/* everything you already have, at the top */}
      <div className={styles.agentScroll}>
        <div className={styles.agentInner}>
          <div className={panel.head}>
            <div>
              <div className={panel.title}>Auto Agent</div>
              <div className={panel.subtitle}>
                Describe an agent once and Yoinky runs it. You stay in control.
                {planCap !== null && ` Your plan covers ${planCap} agent posts a month.`}
              </div>
            </div>
          </div>

          {approvals.length > 0 && (
            <section className={styles.section}>
              <div className={styles.sectionTitle}>Needs your approval</div>
              {approvals.map((a) => (
                <ApprovalCard
                  key={a.runId}
                  approval={a}
                  onResolved={(runId) => setApprovals((list) => list.filter((x) => x.runId !== runId))}
                  onEdited={(runId, draft) =>
                    setApprovals((list) => list.map((x) => (x.runId === runId ? { ...x, draft } : x)))
                  }
                />
              ))}
            </section>
          )}

          <section className={styles.section}>
            <div className={styles.sectionTitle}>Your agents</div>
            {automations.length === 0 ? (
              <div className={styles.empty}>
                No agents yet. Describe one below in your own words and Yoinky will draft posts for you, on your
                cadence, in your voice.
              </div>
            ) : (
              automations.map((a) => (
                <div key={a.id} className={styles.card}>
                  <div className={styles.cardMain} onClick={() => loadForEdit(a)}>
                    <div className={styles.cardName}>{a.name}</div>
                    <div className={styles.cardMeta}>
                      {SOURCE_LABEL[a.sourceType]} · {CADENCE_LABEL[a.cadenceKind]} · {DELIVERY_LABEL[a.deliveryMode]} ·
                      up to {a.monthlyCap}/mo
                    </div>
                    {a.pendingApprovals > 0 && <div className={styles.pendingTag}>{a.pendingApprovals} waiting on you</div>}
                  </div>
                  <div className={styles.cardActions}>
                    <button className={styles.runBtn} onClick={() => runNow(a)} disabled={busy}>
                      Run now
                    </button>
                    <button
                      className={`${styles.toggle} ${a.enabled ? styles.on : ""}`}
                      onClick={() => toggle(a)}
                      aria-label={a.enabled ? "pause" : "enable"}
                    >
                      <span className={styles.knob} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>

          {/* what the agent is doing, right where you're looking */}
          {activity.length > 0 && (
            <div className={styles.agentActivity}>
              {activity.map((a, i) => (
                <div
                  key={`${a.label}-${i}`}
                  className={`${styles.agentActivityRow} ${a.active ? styles.agentActivityRowActive : ""}`}
                >
                  {a.active ? <span className={styles.agentSpin} /> : <span className={styles.agentTick}>✓</span>}
                  <span className={styles.agentActivityLabel}>{a.label}</span>
                </div>
              ))}
            </div>
          )}
          {note && <div className={styles.agentNote}>{note}</div>}
        </div>
      </div>

      {/* the composer: settings directly above the box, box at the bottom */}
      <div className={styles.agentDock}>
        <div className={styles.agentDockInner}>
          <div className={styles.chips}>
            {MODES.map((m) => (
              <button
                key={m.type}
                className={styles.chip}
                onClick={() => set("sourceType", m.type)}
                style={
                  form.sourceType === m.type
                    ? { borderColor: "var(--accent-border)", color: "var(--accent)", background: "var(--accent-soft)" }
                    : undefined
                }
                title={m.blurb}
              >
                {m.title}
              </button>
            ))}
            {form.sourceType === "custom" &&
              EXAMPLES.slice(0, 2).map((ex) => (
                <button key={ex} className={styles.chip} onClick={() => set("brief", ex)}>
                  {ex.length > 42 ? `${ex.slice(0, 42)}…` : ex}
                </button>
              ))}
          </div>

          <div className={styles.settingsRow}>
            <label className={styles.settingCol}>
              <span className={styles.settingLabel}>How it delivers</span>
              <select
                className={styles.settingInput}
                value={form.deliveryMode}
                onChange={(e) => set("deliveryMode", e.target.value as FormState["deliveryMode"])}
              >
                <option value="approval">Ask me first</option>
                {canAutoAgent ? (
                  <option value="auto">Post on its own</option>
                ) : (
                  <option value="auto" disabled>
                    Post on its own (Scale)
                  </option>
                )}
              </select>
            </label>
            <label className={styles.settingCol}>
              <span className={styles.settingLabel}>How often</span>
              <select
                className={styles.settingInput}
                value={form.cadenceKind}
                onChange={(e) => set("cadenceKind", e.target.value as FormState["cadenceKind"])}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="manual">When I run it</option>
              </select>
            </label>
            <label className={styles.settingCol}>
              <span className={styles.settingLabel}>Cap / month{planCap !== null ? ` (max ${planCap})` : ""}</span>
              <input
                className={styles.settingInput}
                type="number"
                min={1}
                max={planCap ?? 200}
                value={form.monthlyCap}
                onChange={(e) => set("monthlyCap", Number(e.target.value) || 1)}
              />
            </label>
          </div>

          <div className={styles.briefBox}>
            <textarea
              ref={taRef}
              className={styles.briefInput}
              value={form.brief}
              onChange={(e) => set("brief", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={1}
              placeholder={
                form.sourceType === "custom"
                  ? "Describe the agent in your own words…"
                  : "Extra guidance (optional)…"
              }
            />
            <div className={styles.briefFooter}>
              <span className={styles.briefHint}>
                {err ||
                  (editingExisting
                    ? `Updating “${form.name || "this agent"}” — Enter to save`
                    : "Enter to create · Shift+Enter for a new line")}
              </span>
              {editingExisting && (
                <button className={styles.chip} onClick={() => setForm({ ...BLANK })}>
                  Cancel
                </button>
              )}
              <button className={styles.briefSend} onClick={() => void submit()} disabled={busy}>
                {busy ? "Working…" : editingExisting ? "Save agent" : "Create agent"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ApprovalCard({
  approval,
  onResolved,
  onEdited,
}: {
  approval: ApprovalView;
  onResolved: (runId: string) => void;
  onEdited: (runId: string, draft: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  async function act(action: "approve" | "reject" | "edit") {
    setBusy(true);
    try {
      const res = await fetch("/api/automations/verdict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: approval.runId, action, instruction: action === "edit" ? instruction : undefined }),
      });
      const data = await res.json();
      if (action === "edit") {
        if (data.ok && data.draft) {
          onEdited(approval.runId, data.draft);
          setEditing(false);
          setInstruction("");
        }
      } else if (data.ok) {
        onResolved(approval.runId);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.approval}>
      <div className={styles.approvalFrom}>{approval.automationName}</div>
      <div className={styles.approvalDraft}>{approval.draft}</div>
      {approval.media && <div className={styles.approvalMedia}>📎 {approval.media}</div>}
      {editing ? (
        <div className={styles.editRow}>
          <input
            className={styles.editInput}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="what should i change?"
            autoFocus
          />
          <button className={styles.runBtn} onClick={() => act("edit")} disabled={busy || !instruction.trim()}>
            {busy ? "…" : "Apply"}
          </button>
          <button className={styles.ghost} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className={styles.approvalActions}>
          <button className="btnPrimary" onClick={() => act("approve")} disabled={busy}>
            Approve
          </button>
          <button className={styles.ghost} onClick={() => setEditing(true)} disabled={busy}>
            Edit
          </button>
          <button className={styles.ghost} onClick={() => act("reject")} disabled={busy}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
