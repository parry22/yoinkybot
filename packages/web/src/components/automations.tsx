"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, AiMagicIcon, FireIcon, ArchiveIcon } from "@hugeicons/core-free-icons";
import panel from "./panel.module.css";
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
}: {
  initialAutomations: AutomationView[];
  initialApprovals: ApprovalView[];
}) {
  const [automations, setAutomations] = useState(initialAutomations);
  const [approvals, setApprovals] = useState(initialApprovals);
  const [editing, setEditing] = useState<null | FormState>(null);
  const [toast, setToast] = useState<string | null>(null);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  async function toggle(a: AutomationView) {
    const next = !a.enabled;
    setAutomations((list) => list.map((x) => (x.id === a.id ? { ...x, enabled: next } : x)));
    await fetch("/api/automations/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: a.id, enabled: next }),
    }).catch(() => {});
  }

  async function runNow(a: AutomationView) {
    flash("running…");
    try {
      const res = await fetch("/api/automations/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: a.id }),
      });
      const data = await res.json();
      if (data.status === "awaiting_approval") flash("drafted, check Telegram or below to approve");
      else if (data.status === "scheduled") flash("drafted and queued to post");
      else flash(data.reason ?? "nothing to post right now");
      await refreshApprovals();
    } catch {
      flash("couldn't run that");
    }
  }

  async function refreshApprovals() {
    const res = await fetch("/api/automations/approvals").then((r) => r.json()).catch(() => ({ approvals: [] }));
    setApprovals(res.approvals ?? []);
  }

  function edit(a: AutomationView) {
    setEditing({
      id: a.id,
      name: a.name,
      sourceType: a.sourceType,
      deliveryMode: a.deliveryMode,
      cadenceKind: a.cadenceKind,
      monthlyCap: a.monthlyCap,
      brief: a.brief ?? "",
    });
  }

  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <div className={panel.head}>
          <div>
            <div className={panel.title}>Auto Agent</div>
            <div className={panel.subtitle}>Describe an agent once and Yoinky runs it. You stay in control.</div>
          </div>
          <button className="btnPrimary" onClick={() => setEditing({ ...BLANK })}>
            <HugeiconsIcon icon={Add01Icon} size={16} strokeWidth={2} />
            New agent
          </button>
        </div>

        {toast && <div className={styles.toast}>{toast}</div>}

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
          {automations.length === 0 ? (
            <div className={styles.empty}>
              No agents yet. Describe one in your own words and Yoinky will draft posts for you, on your cadence, in your voice.
            </div>
          ) : (
            automations.map((a) => (
              <div key={a.id} className={styles.card}>
                <div className={styles.cardMain} onClick={() => edit(a)}>
                  <div className={styles.cardName}>{a.name}</div>
                  <div className={styles.cardMeta}>
                    {SOURCE_LABEL[a.sourceType]} · {CADENCE_LABEL[a.cadenceKind]} · {DELIVERY_LABEL[a.deliveryMode]}
                  </div>
                  {a.pendingApprovals > 0 && (
                    <div className={styles.pendingTag}>{a.pendingApprovals} waiting on you</div>
                  )}
                </div>
                <div className={styles.cardActions}>
                  <button className={styles.runBtn} onClick={() => runNow(a)}>
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
      </div>

      {editing && (
        <ConfigModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(view) => {
            setAutomations((list) => {
              const exists = list.some((x) => x.id === view.id);
              return exists ? list.map((x) => (x.id === view.id ? view : x)) : [view, ...list];
            });
            setEditing(null);
          }}
        />
      )}
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

function ConfigModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: FormState;
  onClose: () => void;
  onSaved: (view: AutomationView) => void;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const isCustom = form.sourceType === "custom";

  function appendExample(text: string) {
    setForm((f) => ({ ...f, brief: f.brief.trim() ? `${f.brief.trim()} ${text}` : text }));
  }

  async function save() {
    if (isCustom && !form.brief.trim()) {
      setErr("Tell the agent what to do — describe it in the box above.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/automations/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "could not save");
        return;
      }
      onSaved(data.automation);
    } catch {
      setErr("could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>{form.id ? "Edit agent" : "New Auto Agent"}</div>

        {/* Conversational lead-in — the brief is the hero, options support it. */}
        <div className={styles.assistantRow}>
          <span className={styles.assistantAvatar}>
            <HugeiconsIcon icon={AiMagicIcon} size={16} strokeWidth={1.8} />
          </span>
          <div className={styles.assistantBubble}>
            Tell me what this agent should do — in your own words. Or pick a starting point.
          </div>
        </div>

        <div className={styles.modeGrid}>
          {MODES.map((m) => {
            const active = form.sourceType === m.type;
            return (
              <button
                key={m.type}
                type="button"
                className={`${styles.modeCard} ${active ? styles.modeCardActive : ""}`}
                onClick={() => set("sourceType", m.type)}
              >
                <span className={styles.modeIcon}>
                  <HugeiconsIcon icon={m.icon} size={16} strokeWidth={1.8} />
                </span>
                <span className={styles.modeTitle}>{m.title}</span>
                <span className={styles.modeBlurb}>{m.blurb}</span>
              </button>
            );
          })}
        </div>

        <label className={styles.field}>
          <span className={styles.label}>{isCustom ? "What should it do?" : "Extra guidance (optional)"}</span>
          <textarea
            className={styles.briefArea}
            value={form.brief}
            onChange={(e) => set("brief", e.target.value)}
            rows={isCustom ? 4 : 2}
            maxLength={1000}
            autoFocus
            placeholder={
              isCustom
                ? "e.g. Every morning, turn the most interesting AI-infra story into a punchy take in my voice, and tie it back to what we're building at Acme."
                : "Anything to steer it — angle, hook, topics to favor or avoid…"
            }
          />
          {isCustom && (
            <div className={styles.exampleChips}>
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" className={styles.exampleChip} onClick={() => appendExample(ex)}>
                  {ex.length > 42 ? ex.slice(0, 42) + "…" : ex}
                </button>
              ))}
            </div>
          )}
        </label>

        <div className={styles.optionsRow}>
          <label className={styles.optionCol}>
            <span className={styles.label}>How it delivers</span>
            <select className={styles.input} value={form.deliveryMode} onChange={(e) => set("deliveryMode", e.target.value as FormState["deliveryMode"])}>
              <option value="approval">Ask me first</option>
              <option value="auto">Post on its own</option>
            </select>
          </label>
          <label className={styles.optionCol}>
            <span className={styles.label}>How often</span>
            <select className={styles.input} value={form.cadenceKind} onChange={(e) => set("cadenceKind", e.target.value as FormState["cadenceKind"])}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="manual">When I run it</option>
            </select>
          </label>
          <label className={styles.optionCol}>
            <span className={styles.label}>Cap / month</span>
            <input
              className={styles.input}
              type="number"
              min={1}
              max={200}
              value={form.monthlyCap}
              onChange={(e) => set("monthlyCap", Number(e.target.value) || 30)}
            />
          </label>
        </div>

        {form.deliveryMode === "auto" && (
          <span className={styles.hint}>
            The first few still come to you first, and every post lands in your queue where you can cancel it before it goes out.
          </span>
        )}

        <label className={styles.field}>
          <span className={styles.label}>Name (optional)</span>
          <input
            className={styles.input}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="We'll name it from your brief if you leave this blank"
          />
        </label>

        {err && <div className={styles.err}>{err}</div>}
        <div className={styles.modalActions}>
          <button className={styles.ghost} onClick={onClose}>
            Cancel
          </button>
          <button className="btnPrimary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
