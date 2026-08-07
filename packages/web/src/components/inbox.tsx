"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { KnowledgeObjectView } from "@yoink/backend/web";
import { usePageCount } from "./page-meta";
import styles from "./inbox-triage.module.css";

const TYPE_LABEL: Record<KnowledgeObjectView["objectType"], string> = {
  insight: "Insight",
  claim: "Claim",
  proof: "Proof",
  story: "Story",
  objection: "Objection",
  question: "Question",
  framework: "Framework",
  capability: "Capability",
  customer_quote: "Quote",
  language_phrase: "Phrase",
  market_signal: "Signal",
};

type ClassFilter =
  | "all"
  | "suggestions"
  | "insight"
  | "story"
  | "objection"
  | "proof"
  | "claim"
  | "other";

const FILTERS: Array<{ id: ClassFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "suggestions", label: "Suggestions" },
  { id: "insight", label: "Insights" },
  { id: "story", label: "Stories" },
  { id: "objection", label: "Objections" },
  { id: "proof", label: "Proof" },
  { id: "claim", label: "Claims" },
  { id: "other", label: "Other" },
];

type DemoItem = {
  id: string;
  kind: "demo";
  type: string;
  title: string;
  body: string;
};

const DEMO_ITEMS: DemoItem[] = [
  {
    id: "yoinky-demo-1",
    kind: "demo",
    type: "Suggestion",
    title: "Your pricing story is ready to reuse",
    body: "Buyers stall when they can’t see ROI in the first call. Three LinkedIn angles are waiting in Studio.",
  },
  {
    id: "yoinky-demo-2",
    kind: "demo",
    type: "Capture",
    title: "New objection from sales",
    body: "“We already have Gong notes — why add another system?” File it once; reuse the proof language everywhere.",
  },
  {
    id: "yoinky-demo-3",
    kind: "demo",
    type: "Nudge",
    title: "Customer stories went quiet",
    body: "4 product updates and 0 stories in 14 days. Stories are usually your strongest format.",
  },
];

/** Demos only when the real queue is empty, and never in production unless explicitly enabled. */
function demosAllowed(): boolean {
  if (process.env.NEXT_PUBLIC_SHOW_DEMOS === "true") return true;
  if (process.env.NEXT_PUBLIC_SHOW_DEMOS === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function preview(text: string, max = 120) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function isOtherType(type: KnowledgeObjectView["objectType"]) {
  return !["insight", "story", "objection", "proof", "claim"].includes(type);
}

function chipColors(label: string): { background: string; color: string } {
  const key = label.toLowerCase();
  if (key.includes("suggest")) return { background: "#f8d5e4", color: "#9b2f5c" };
  if (key.includes("nudge")) return { background: "#f3e0c8", color: "#8a5520" };
  if (key.includes("capture")) return { background: "#d7e6ec", color: "#355f6f" };
  if (key.includes("insight")) return { background: "#d9e7f0", color: "#355f6f" };
  if (key.includes("story")) return { background: "#f0dfc8", color: "#8a5520" };
  if (key.includes("objection")) return { background: "#efd4d9", color: "#7a3544" };
  if (key.includes("proof")) return { background: "#d6ebe1", color: "#356554" };
  if (key.includes("claim")) return { background: "#e5daf0", color: "#5d4572" };
  return { background: "#ebe9e4", color: "#5f5e5b" };
}

function TypeChip({ label }: { label: string }) {
  const tone = chipColors(label);
  return (
    <span
      className={styles.chip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 24,
        padding: "0 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 560,
        letterSpacing: "0.01em",
        lineHeight: 1,
        whiteSpace: "nowrap",
        background: tone.background,
        color: tone.color,
      }}
    >
      {label}
    </span>
  );
}

export function Inbox({
  workspaceName,
  initialItems,
  canReview,
}: {
  workspaceName: string;
  initialItems: KnowledgeObjectView[];
  canReview: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const initialQueue = initialItems.filter((item) => item.status === "proposed" || item.status === "reviewed");
  const [demo, setDemo] = useState(() => (demosAllowed() && initialQueue.length === 0 ? DEMO_ITEMS : []));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClassFilter>("all");
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (demosAllowed() && initialQueue.length === 0) return DEMO_ITEMS[0]?.id ?? null;
    return initialQueue[0]?.id ?? null;
  });

  const queue = useMemo(
    () => items.filter((item) => item.status === "proposed" || item.status === "reviewed"),
    [items],
  );

  // Never count demos as real inbox volume; only show them when the queue is empty.
  const activeDemos = demosAllowed() && queue.length === 0 ? demo : [];

  const counts = useMemo(() => {
    const map: Record<ClassFilter, number> = {
      all: queue.length + activeDemos.length,
      suggestions: activeDemos.length,
      insight: queue.filter((item) => item.objectType === "insight").length,
      story: queue.filter((item) => item.objectType === "story").length,
      objection: queue.filter((item) => item.objectType === "objection").length,
      proof: queue.filter((item) => item.objectType === "proof").length,
      claim: queue.filter((item) => item.objectType === "claim").length,
      other: queue.filter((item) => isOtherType(item.objectType)).length,
    };
    return map;
  }, [queue, activeDemos]);

  const visibleDemo = useMemo(() => {
    if (filter === "all" || filter === "suggestions") return activeDemos;
    return [];
  }, [activeDemos, filter]);

  const visibleQueue = useMemo(() => {
    if (filter === "suggestions") return [];
    if (filter === "all") return queue;
    if (filter === "other") return queue.filter((item) => isOtherType(item.objectType));
    return queue.filter((item) => item.objectType === filter);
  }, [queue, filter]);

  const total = queue.length;
  usePageCount(total);
  const activeDemo =
    visibleDemo.find((item) => item.id === activeId) ?? activeDemos.find((item) => item.id === activeId) ?? null;
  const activeReal = visibleQueue.find((item) => item.id === activeId) ?? queue.find((item) => item.id === activeId) ?? null;

  async function act(objectId: string, status: "approved" | "rejected" | "reviewed") {
    setBusyId(objectId);
    const response = await fetch("/api/knowledge", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectId, status }),
    });
    const data = (await response.json().catch(() => ({}))) as { object?: KnowledgeObjectView };
    if (response.ok && data.object) {
      setItems((current) => current.map((item) => (item.id === objectId ? data.object! : item)));
      setActiveId((current) => (current === objectId ? null : current));
    }
    setBusyId(null);
  }

  function dismissDemo(id: string) {
    setDemo((current) => {
      const next = current.filter((item) => item.id !== id);
      setActiveId((currentActive) => (currentActive === id ? next[0]?.id ?? null : currentActive));
      return next;
    });
  }

  return (
    <div className={styles.page}>
      <div className={`${styles.shell} ${activeId ? styles.shellDetailOpen : ""}`}>
        <aside className={styles.listPane}>
          <div className={styles.filters} role="tablist" aria-label="Inbox classification">
            {FILTERS.map((item) => {
              if (item.id !== "all" && counts[item.id] === 0) return null;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === item.id}
                  className={`${styles.filter} ${filter === item.id ? styles.filterOn : ""}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    height: 30,
                    padding: "0 12px",
                    borderRadius: 999,
                  }}
                  onClick={() => setFilter(item.id)}
                >
                  <span>{item.label}</span>
                  <span
                    className={styles.filterCount}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: 18,
                      height: 18,
                      padding: "0 5px",
                      borderRadius: 999,
                      background: "var(--hover, #ebe7e0)",
                      color: "var(--ink-500, #96938b)",
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {counts[item.id]}
                  </span>
                </button>
              );
            })}
          </div>

          <div className={styles.list}>
            {visibleDemo.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`${styles.row} ${activeId === item.id ? styles.rowActive : ""}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 10,
                  width: "100%",
                  textAlign: "left",
                }}
                onClick={() => setActiveId(item.id)}
              >
                <TypeChip label={item.type} />
                <span className={styles.rowCopy}>
                  <span className={styles.rowTitle}>{item.title}</span>
                  <span className={styles.rowPreview}>{preview(item.body, 72)}</span>
                </span>
              </button>
            ))}
            {visibleQueue.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`${styles.row} ${activeId === item.id ? styles.rowActive : ""}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 10,
                  width: "100%",
                  textAlign: "left",
                }}
                onClick={() => setActiveId(item.id)}
              >
                <TypeChip label={TYPE_LABEL[item.objectType]} />
                <span className={styles.rowCopy}>
                  <span className={styles.rowTitle}>{item.title}</span>
                  <span className={styles.rowPreview}>{preview(item.body, 72)}</span>
                </span>
              </button>
            ))}
            {visibleDemo.length === 0 && visibleQueue.length === 0 && (
              <p className={styles.emptyList}>
                {queue.length === 0
                  ? "Inbox is clear. New captures and suggestions will land here."
                  : "Nothing in this class yet."}
              </p>
            )}
          </div>
        </aside>

        <section className={styles.detailPane}>
          {activeId && (
            <button type="button" className={styles.mobileBack} onClick={() => setActiveId(null)}>
              <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
              Inbox
            </button>
          )}
          {activeDemo ? (
            <>
              <div className={styles.detailMeta}>
                <TypeChip label={activeDemo.type} />
              </div>
              <h1>{activeDemo.title}</h1>
              <p>{activeDemo.body}</p>
              <div className={styles.detailActions}>
                <Link href="/app/studio" className={styles.primaryAction}>Open in Studio</Link>
                <button type="button" className={styles.quietAction} onClick={() => dismissDemo(activeDemo.id)}>
                  Dismiss
                </button>
              </div>
            </>
          ) : activeReal ? (
            <>
              <div className={styles.detailMeta}>
                <TypeChip label={TYPE_LABEL[activeReal.objectType]} />
              </div>
              <h1>{activeReal.title}</h1>
              <p>{preview(activeReal.body, 420)}</p>
              <div className={styles.detailActions}>
                {canReview ? (
                  <>
                    <button
                      type="button"
                      className={styles.primaryAction}
                      disabled={busyId === activeReal.id}
                      onClick={() => void act(activeReal.id, "approved")}
                    >
                      <HugeiconsIcon icon={Tick02Icon} size={14} />
                      Keep
                    </button>
                    <button
                      type="button"
                      className={styles.quietAction}
                      disabled={busyId === activeReal.id}
                      onClick={() => void act(activeReal.id, "reviewed")}
                    >
                      File
                    </button>
                    <button
                      type="button"
                      className={styles.quietAction}
                      disabled={busyId === activeReal.id}
                      onClick={() => void act(activeReal.id, "rejected")}
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={14} />
                      Discard
                    </button>
                  </>
                ) : (
                  <span className={styles.readonly}>Editor access required</span>
                )}
                <Link href={`/app/knowledge?focus=${activeReal.id}`} className={styles.quietAction}>
                  View in Knowledge
                </Link>
              </div>
            </>
          ) : (
            <div className={styles.emptyDetail}>
              <p>
                {queue.length === 0
                  ? `${workspaceName}'s inbox is empty. Capture something to start triage.`
                  : `Select an item from ${workspaceName}'s inbox.`}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
