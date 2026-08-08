"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { KnowledgeObjectView } from "@yoink/backend/web";
import { useFlashMessage } from "../lib/use-flash-message";
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
  | "insight"
  | "story"
  | "objection"
  | "proof"
  | "claim"
  | "other";

const FILTERS: Array<{ id: ClassFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "insight", label: "Insights" },
  { id: "story", label: "Stories" },
  { id: "objection", label: "Objections" },
  { id: "proof", label: "Proof" },
  { id: "claim", label: "Claims" },
  { id: "other", label: "Other" },
];

function preview(text: string, max = 120) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function isOtherType(type: KnowledgeObjectView["objectType"]) {
  return !["insight", "story", "objection", "proof", "claim"].includes(type);
}

function chipColors(label: string): { background: string; color: string } {
  const key = label.toLowerCase();
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

function friendlyInboxError(raw: string | undefined) {
  const text = (raw ?? "").trim();
  if (!text) return "Couldn't update that item. Try again in a moment.";
  return text
    .replace(/\bobject\b/gi, "item")
    .replace(/\bknowledge\b/gi, "item")
    .replace(/\bstatus\b/gi, "update");
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const { message: error, flash: setError, clear: clearError } = useFlashMessage(4000);
  const [filter, setFilter] = useState<ClassFilter>("all");
  const initialQueue = initialItems.filter((item) => item.status === "proposed" || item.status === "reviewed");
  const [activeId, setActiveId] = useState<string | null>(() => initialQueue[0]?.id ?? null);

  const queue = useMemo(
    () => items.filter((item) => item.status === "proposed" || item.status === "reviewed"),
    [items],
  );

  const counts = useMemo(() => {
    const map: Record<ClassFilter, number> = {
      all: queue.length,
      insight: queue.filter((item) => item.objectType === "insight").length,
      story: queue.filter((item) => item.objectType === "story").length,
      objection: queue.filter((item) => item.objectType === "objection").length,
      proof: queue.filter((item) => item.objectType === "proof").length,
      claim: queue.filter((item) => item.objectType === "claim").length,
      other: queue.filter((item) => isOtherType(item.objectType)).length,
    };
    return map;
  }, [queue]);

  const visibleQueue = useMemo(() => {
    if (filter === "all") return queue;
    if (filter === "other") return queue.filter((item) => isOtherType(item.objectType));
    return queue.filter((item) => item.objectType === filter);
  }, [queue, filter]);

  const total = queue.length;
  usePageCount(total);
  const activeReal = visibleQueue.find((item) => item.id === activeId) ?? queue.find((item) => item.id === activeId) ?? null;

  async function act(objectId: string, status: "approved" | "rejected" | "reviewed") {
    setBusyId(objectId);
    clearError();
    const response = await fetch("/api/knowledge", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectId, status }),
    });
    const data = (await response.json().catch(() => ({}))) as { object?: KnowledgeObjectView; error?: string };
    if (response.ok && data.object) {
      setItems((current) => current.map((item) => (item.id === objectId ? data.object! : item)));
      setActiveId((current) => (current === objectId ? null : current));
    } else {
      setError(friendlyInboxError(data.error));
    }
    setBusyId(null);
  }

  return (
    <div className={styles.page}>
      {error && (
        <div className={styles.bannerError} role="status">
          {error}
        </div>
      )}
      <div className={`${styles.shell} ${activeId ? styles.shellDetailOpen : ""}`}>
        <aside className={styles.listPane}>
          <div className={styles.filters} role="tablist" aria-label="Inbox filters">
            {FILTERS.map((item) => {
              if (item.id !== "all" && counts[item.id] === 0) return null;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === item.id}
                  className={`${styles.filter} ${filter === item.id ? styles.filterOn : ""}`}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                  {counts[item.id] > 0 && <em className={styles.filterCount}>{counts[item.id]}</em>}
                </button>
              );
            })}
          </div>
          <div className={styles.list}>
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
            {visibleQueue.length === 0 && (
              <p className={styles.emptyList}>
                {queue.length === 0
                  ? "Nothing waiting yet. New ideas and captures will show up here."
                  : "Nothing in this filter yet."}
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
          {activeReal ? (
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
                  <span className={styles.readonly}>You need edit access to review items</span>
                )}
                <Link href={`/app/knowledge?focus=${activeReal.id}`} className={styles.quietAction}>
                  Open in Knowledge
                </Link>
              </div>
            </>
          ) : (
            <div className={styles.emptyDetail}>
              <p>
                {queue.length === 0
                  ? `${workspaceName}'s inbox is clear. When something new comes in, it will land here.`
                  : `Pick an item from ${workspaceName}'s inbox.`}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
