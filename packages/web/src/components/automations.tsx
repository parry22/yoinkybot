"use client";

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUp01Icon } from "@hugeicons/core-free-icons";
import panel from "./panel.module.css";
import { useAgentStream } from "./use-agent-stream";
import { UpgradeCTA } from "./upgrade-cta";
import { AgentShimmer } from "./agent-shimmer";
import styles from "./automations.module.css";

type SourceType = "trend_ride" | "unlock_backlog" | "custom";

interface AutomationView {
  id: string;
  name: string;
  sourceType: SourceType;
  deliveryMode: "approval" | "auto";
  platform: "x" | "linkedin";
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

/** One line of the setup conversation. */
type Turn = { role: "user" | "assistant"; content: string };

/**
 * Auto Agent is a conversation, not a form.
 *
 * WHAT WAS HERE BEFORE. Three preset pills ("Describe it myself" / "Ride trends" /
 * "From my backlog"), two example-prompt chips, three dropdowns, and a brief box.
 * All of it rendered before the user had said anything, which is the reason it's
 * gone: pre-existing pills make you choose from the product's vocabulary instead
 * of being asked what you actually want posted. People picked a pill, typed one
 * sentence, and got an agent that knew nothing about their angles or their hooks.
 *
 * WHAT IT IS NOW. Yoinky interviews you - what the agent is for, what shape of
 * post, which angles, which hooks, then cadence and delivery - one question at a
 * time, with suggested answers that come from YOUR niche and arrive as part of
 * each question rather than sitting in the UI in advance. On the last turn the
 * server builds the agent and runs it once, so you see a real draft before you
 * leave the page.
 */
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
  const [turns, setTurns] = useState<Turn[]>([]);
  /** Suggestions for the question just asked. Server-authored, per question. */
  const [options, setOptions] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  /** A 402 is a wall, not an error: it gets the upgrade link rather than a line
   *  of grey hint text with nothing to click. Holds the wall's own copy, since
   *  "you can't set one up" and "the one you have can't run" are different walls. */
  const [paywall, setPaywall] = useState<string | null>(null);
  const { run, activity, busy } = useAgentStream();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, activity, busy]);

  // Grow the composer with its content.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`;
  }, [input]);

  async function refreshApprovals() {
    const res = await fetch("/api/automations/approvals").then((r) => r.json()).catch(() => ({ approvals: [] }));
    setApprovals(res.approvals ?? []);
  }

  /**
   * Send one interview turn. The whole transcript goes with it - the server is
   * stateless and re-derives the agent spec from it each time, so a correction
   * three turns later still lands.
   */
  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setErr("");
    setPaywall(null);
    setInput("");
    setOptions([]);
    const next: Turn[] = [...turns, { role: "user", content: t }];
    setTurns(next);

    await run(
      "/api/automations/interview/stream",
      { messages: next },
      {
        onMessage: (content) => setTurns((prev) => [...prev, { role: "assistant", content }]),
        onResult: (data) => {
          const d = (data ?? {}) as { complete?: boolean; options?: string[]; automation?: AutomationView };
          if (d.automation) {
            setAutomations((list) => {
              const exists = list.some((x) => x.id === d.automation!.id);
              return exists ? list.map((x) => (x.id === d.automation!.id ? d.automation! : x)) : [d.automation!, ...list];
            });
          }
          if (d.complete) {
            // Interview over: clear the thread so the box is ready for the next
            // agent rather than continuing to append to a finished setup.
            setOptions([]);
            void refreshApprovals();
          } else {
            setOptions(d.options ?? []);
          }
        },
        onError: (message, status) => {
          if (status === 402) setPaywall("Auto Agent is a paid feature - upgrade to set one up.");
          else setErr(message);
        },
      },
    );
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

  /** "Run now" - streamed, so the pipeline shows its work. */
  async function runNow(a: AutomationView) {
    setErr("");
    setPaywall(null);
    await run(
      "/api/automations/run/stream",
      { id: a.id },
      {
        onMessage: (content) => setTurns((prev) => [...prev, { role: "assistant", content }]),
        onResult: () => void refreshApprovals(),
        onError: (message, status) => {
          if (status === 402) setPaywall("Your trial has ended - upgrade to keep the agent running.");
          else setErr(message);
        },
      },
    );
  }

  const started = turns.length > 0;

  return (
    <div className={styles.agentRoot}>
      <div className={styles.agentScroll} ref={scrollRef}>
        <div className={styles.agentInner}>
          <div className={panel.head}>
            <div>
              <div className={panel.title}>Auto Agent</div>
              <div className={panel.subtitle}>
                Tell Yoinky what you want posted - say it however it comes out - and it&apos;ll ask about the angles,
                hooks and shape of post from there, then set it running.
                {/* A cap of 0 is the free plan, not an allowance: "Your plan covers
                 *  0 agent posts a month" read like a broken counter, so the zero
                 *  case drops the sentence and shows the wall below instead. */}
                {planCap !== null && planCap > 0 && ` Your plan covers ${planCap} agent posts a month.`}
              </div>
            </div>
          </div>

          {planCap === 0 && (
            <section className={styles.section}>
              <UpgradeCTA
                message="Your plan doesn't include agent posts - upgrade and Yoinky starts writing them for you."
                plan="growth"
              />
            </section>
          )}

          {approvals.length > 0 && (
            <section className={styles.section}>
              <div className={styles.sectionTitle}>Needs your approval</div>
              {approvals.map((a) => (
                <ApprovalCard
                  key={a.runId}
                  approval={a}
                  onPaywall={setPaywall}
                  onResolved={(runId) => setApprovals((list) => list.filter((x) => x.runId !== runId))}
                  onEdited={(runId, draft) =>
                    setApprovals((list) => list.map((x) => (x.runId === runId ? { ...x, draft } : x)))
                  }
                />
              ))}
            </section>
          )}

          {automations.length > 0 && (
            <section className={styles.section}>
              <div className={styles.sectionTitle}>Your agents</div>
              {automations.map((a) => (
                <div key={a.id} className={styles.card}>
                  <div className={styles.cardMain}>
                    <div className={styles.cardName}>{a.name}</div>
                    <div className={styles.cardMeta}>
                      {SOURCE_LABEL[a.sourceType]} · {CADENCE_LABEL[a.cadenceKind]} · {DELIVERY_LABEL[a.deliveryMode]} ·
                      {a.platform === "x" ? "X" : "LinkedIn"} · up to {a.monthlyCap}/mo
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
              ))}
            </section>
          )}

          {turns.length > 0 && (
            <div className={styles.thread}>
              {turns.map((t, i) => (
                <div
                  key={`${i}-${t.content.slice(0, 12)}`}
                  className={`${styles.turn} ${t.role === "user" ? styles.turnUser : styles.turnBot}`}
                >
                  {t.content}
                </div>
              ))}
            </div>
          )}

          {/* One shimmering line of the current action for the whole turn -
           *  same indicator as Compose (see agent-shimmer.tsx). */}
          {busy && (
            <AgentShimmer
              label={activity.find((a) => a.active)?.label ?? activity.at(-1)?.label ?? "Thinking it through"}
            />
          )}
        </div>
      </div>

      <div className={styles.agentDock}>
        <div className={styles.agentDockInner}>
          {paywall && (
            <div style={{ marginBottom: 10 }}>
              <UpgradeCTA message={paywall} plan="growth" />
            </div>
          )}

          {/* Suggestions belong to the question that was just asked, so they only
           *  exist after Yoinky asks something - never as standing UI furniture. */}
          {options.length > 0 && !busy && (
            <div className={styles.chips}>
              {options.map((o) => (
                <button key={o} className={styles.chip} onClick={() => void send(o)}>
                  {o}
                </button>
              ))}
            </div>
          )}

          <div className={styles.briefBox}>
            <textarea
              ref={taRef}
              className={styles.briefInput}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              placeholder={started ? "Answer, or say it your own way…" : "What should the agent post for you?"}
            />
            <div className={styles.briefFooter}>
              <span className={styles.briefHint}>
                {err || (canAutoAgent ? "" : "Hands-off posting is a Scale feature, so yours will ask you first")}
              </span>
              <button
                className={styles.briefSend}
                onClick={() => void send(input)}
                disabled={busy || !input.trim()}
                aria-label="Send"
              >
                <HugeiconsIcon icon={ArrowUp01Icon} size={16} strokeWidth={2} />
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
  onPaywall,
}: {
  approval: ApprovalView;
  onResolved: (runId: string) => void;
  onEdited: (runId: string, draft: string) => void;
  /** Verdicts are paid work (an "edit" re-drafts through the model), so a 402 has
   *  to surface - silently doing nothing looked like a broken button. */
  onPaywall: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function act(action: "approve" | "reject" | "edit") {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/automations/verdict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: approval.runId, action, instruction: action === "edit" ? instruction : undefined }),
      });
      if (res.status === 402) {
        onPaywall("Upgrade to approve, edit or reject what your agent wrote.");
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        draft?: string;
        reason?: string;
        capped?: boolean;
        error?: string;
      };

      // EVERY failure used to land here and do nothing at all: the button
      // un-greyed and the card sat there unchanged. So an approval that had
      // EXPIRED (the backend returns a real explanation - "that draft expired, I
      // gave you the post slot back"), an edit that hit the edit cap, a 429 from
      // the burst limiter, and a 500 were all indistinguishable from a dead
      // button. Telegram surfaced these reasons; the web never did.
      if (!res.ok || !data.ok) {
        if (data.capped) {
          setNote("that's as many edits as I'll do on one draft - approve it or reject it.");
        } else {
          setNote(data.reason ?? data.error ?? "couldn't do that just now - try again.");
        }
        return;
      }

      if (action === "edit") {
        if (data.draft) {
          onEdited(approval.runId, data.draft);
          setEditing(false);
          setInstruction("");
        }
      } else {
        onResolved(approval.runId);
      }
    } catch {
      setNote("network dropped - try again.");
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
      {note && <div className={styles.approvalNote}>{note}</div>}
    </div>
  );
}
