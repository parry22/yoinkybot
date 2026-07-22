"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import panel from "./panel.module.css";
import styles from "./automations.module.css";

interface AutomationView {
  id: string;
  name: string;
  sourceType: "trend_ride" | "unlock_backlog";
  deliveryMode: "approval" | "auto";
  cadenceKind: "daily" | "weekly" | "manual";
  cadenceMeta: Record<string, unknown>;
  monthlyCap: number;
  respectQuietHours: boolean;
  pillarScope: string[] | null;
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

const SOURCE_LABEL: Record<AutomationView["sourceType"], string> = {
  trend_ride: "Rides trends in your niche",
  unlock_backlog: "Posts from your backlog",
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

interface FormState {
  id: string;
  name: string;
  sourceType: AutomationView["sourceType"];
  deliveryMode: AutomationView["deliveryMode"];
  cadenceKind: AutomationView["cadenceKind"];
  monthlyCap: number;
}

const BLANK: FormState = {
  id: "",
  name: "",
  sourceType: "trend_ride",
  deliveryMode: "approval",
  cadenceKind: "daily",
  monthlyCap: 30,
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
  const [editing, setEditing] = useState<null | typeof BLANK>(null);
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
    });
  }

  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <div className={panel.head}>
          <div>
            <div className={panel.title}>Automations</div>
            <div className={panel.subtitle}>Set one up once and Yoinky runs it. You stay in control.</div>
          </div>
          <button className="btnPrimary" onClick={() => setEditing({ ...BLANK })}>
            <HugeiconsIcon icon={Add01Icon} size={16} strokeWidth={2} />
            New automation
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
              No automations yet. Create one and Yoinky will draft posts for you, on your cadence, in your voice.
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
  initial: typeof BLANK;
  onClose: () => void;
  onSaved: (view: AutomationView) => void;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof typeof BLANK>(k: K, v: (typeof BLANK)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    if (!form.name.trim()) {
      setErr("give it a name");
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
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>{form.id ? "Edit automation" : "New automation"}</div>

        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input
            className={styles.input}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. AI trends to X"
            autoFocus
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>What it posts</span>
          <select className={styles.input} value={form.sourceType} onChange={(e) => set("sourceType", e.target.value as typeof BLANK.sourceType)}>
            <option value="trend_ride">Rides trends in your niche</option>
            <option value="unlock_backlog">Posts from your backlog</option>
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>How it delivers</span>
          <select className={styles.input} value={form.deliveryMode} onChange={(e) => set("deliveryMode", e.target.value as typeof BLANK.deliveryMode)}>
            <option value="approval">Ask me first (I approve each post)</option>
            <option value="auto">Post on its own</option>
          </select>
          {form.deliveryMode === "auto" && (
            <span className={styles.hint}>
              The first few still come to you first, and every post lands in your queue where you can cancel it before it goes out.
            </span>
          )}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>How often</span>
          <select className={styles.input} value={form.cadenceKind} onChange={(e) => set("cadenceKind", e.target.value as typeof BLANK.cadenceKind)}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="manual">Only when I run it</option>
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Max posts per month</span>
          <input
            className={styles.input}
            type="number"
            min={1}
            max={200}
            value={form.monthlyCap}
            onChange={(e) => set("monthlyCap", Number(e.target.value) || 30)}
          />
        </label>

        {err && <div className={styles.err}>{err}</div>}
        <div className={styles.modalActions}>
          <button className={styles.ghost} onClick={onClose}>
            Cancel
          </button>
          <button className="btnPrimary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
