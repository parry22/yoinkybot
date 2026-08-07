"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  FileUploadIcon,
  Search01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import type {
  ExpertView,
  KnowledgeObjectView,
  WorkspaceAudienceView,
  WorkspaceSourceView,
  EditorialTerritoryView,
} from "@yoink/backend/web";
import { buildBrainNodes } from "./knowledge-brain-scene";
import { MenuSelect } from "./menu-select";
import styles from "./knowledge-shelf.module.css";

const KnowledgeBrainCanvas = dynamic(
  () => import("./knowledge-brain-scene").then((m) => m.KnowledgeBrainCanvas),
  { ssr: false, loading: () => null },
);

const TYPE_LABEL: Record<KnowledgeObjectView["objectType"], string> = {
  insight: "Insight",
  claim: "Claim",
  proof: "Proof",
  story: "Story",
  objection: "Objection",
  question: "Question",
  framework: "Framework",
  capability: "Capability",
  customer_quote: "Customer quote",
  language_phrase: "Language phrase",
  market_signal: "Market signal",
};

const SOURCE_OPTIONS = [
  { value: "founder_interview", label: "Founder interview" },
  { value: "uploaded_transcript", label: "Uploaded transcript" },
  { value: "manual_text", label: "Manual text" },
  { value: "product_update", label: "Product update" },
  { value: "customer_call", label: "Customer call" },
  { value: "sales_call", label: "Sales call" },
  { value: "internal_document", label: "Internal document" },
  { value: "market_research", label: "Market research" },
];

const PERMISSION_OPTIONS = [
  { value: "public", label: "Public" },
  { value: "internal", label: "Internal" },
  { value: "restricted", label: "Restricted" },
  { value: "confidential", label: "Confidential" },
  { value: "never_use_for_generation", label: "Store only" },
];

const DEMO_FLOATS = [
  {
    className: styles.floatA,
    type: "Story",
    title: "The pricing objection that closed the deal",
    body: "Buyers stall when ROI isn’t visible in the first call.",
  },
  {
    className: styles.floatB,
    type: "Claim",
    title: "One idea becomes ten formats",
    body: "Knowledge first — posts are the byproduct.",
  },
  {
    className: styles.floatC,
    type: "Proof",
    title: "Customer quote on onboarding speed",
    body: "Went live in a week without a content ops hire.",
  },
  {
    className: styles.floatD,
    type: "Objection",
    title: "Why another system on top of Gong?",
    body: "Because notes don’t become reusable narrative alone.",
  },
];

/** Decorative floats only outside production, unless NEXT_PUBLIC_SHOW_DEMOS=true. */
function showDemoFloats(): boolean {
  if (process.env.NEXT_PUBLIC_SHOW_DEMOS === "true") return true;
  if (process.env.NEXT_PUBLIC_SHOW_DEMOS === "false") return false;
  return process.env.NODE_ENV !== "production";
}

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));

function preview(text: string, max = 96) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function KnowledgeLibrary({
  experts,
  initialObjects,
  canReview,
}: {
  workspaceName: string;
  experts: ExpertView[];
  initialObjects: KnowledgeObjectView[];
  sources: WorkspaceSourceView[];
  audiences: WorkspaceAudienceView[];
  territories: EditorialTerritoryView[];
  canReview: boolean;
}) {
  const searchParams = useSearchParams();
  const focusId = searchParams.get("focus");

  const [objects, setObjects] = useState(initialObjects);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(focusId);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [transcript, setTranscript] = useState("");
  const [fileName, setFileName] = useState("");
  const [showCapture, setShowCapture] = useState(false);
  const [sourceType, setSourceType] = useState("founder_interview");
  const [speakerExpertId, setSpeakerExpertId] = useState(
    experts.find((expert) => expert.isDefault)?.id ?? "",
  );
  const [permissionLevel, setPermissionLevel] = useState("internal");

  useEffect(() => {
    if (focusId) setSelectedId(focusId);
  }, [focusId]);

  const typeCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const object of objects) {
      map.set(object.objectType, (map.get(object.objectType) ?? 0) + 1);
    }
    return map;
  }, [objects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return objects.filter((object) => {
      if (typeFilter !== "all" && object.objectType !== typeFilter) return false;
      if (!q) return true;
      return [object.title, object.body, object.sourceName, TYPE_LABEL[object.objectType]]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [objects, query, typeFilter]);

  const nodes = useMemo(() => buildBrainNodes(objects), [objects]);
  const selected = objects.find((object) => object.id === selectedId) ?? null;
  const panelOpen = showCapture || Boolean(selected);

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setTranscript(await file.text());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const response = await fetch("/api/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: String(new FormData(event.currentTarget).get("title") ?? ""),
        sourceType,
        speakerExpertId: speakerExpertId || null,
        permissionLevel,
        transcript,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
      objects?: KnowledgeObjectView[];
    };
    if (!response.ok) {
      setError(data.error ?? "Could not extract knowledge.");
      setBusy(false);
      return;
    }
    if (data.objects?.length) {
      setObjects((current) => [...data.objects!, ...current]);
      setSelectedId(data.objects[0]?.id ?? null);
    }
    setNotice(
      (data.objects?.length ?? 0) > 0 ? `${data.objects!.length} items extracted.` : "Source stored.",
    );
    setShowCapture(false);
    setTranscript("");
    setFileName("");
    event.currentTarget.reset();
    setBusy(false);
  }

  async function review(objectId: string, status: "approved" | "rejected") {
    setReviewing(objectId);
    const response = await fetch("/api/knowledge", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectId, status }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      object?: KnowledgeObjectView;
      error?: string;
    };
    if (response.ok && data.object) {
      setObjects((current) =>
        current.map((object) => (object.id === objectId ? data.object! : object)),
      );
    } else {
      setError(data.error ?? "Could not save review.");
    }
    setReviewing(null);
  }

  function closePanel() {
    setShowCapture(false);
    setSelectedId(null);
  }

  return (
    <div className={styles.page}>
      <section className={styles.stage} aria-hidden="true">
        <div className={styles.stageCanvas}>
          <KnowledgeBrainCanvas nodes={nodes} />
        </div>
        <div className={styles.brand}>
          <img src="/favicon.png" alt="" className={styles.brandMark} />
          <div className={styles.brandCopy}>
            <strong>Yoinky</strong>
            <span>Company knowledge brain</span>
          </div>
        </div>
        {showDemoFloats() &&
          DEMO_FLOATS.map((card) => (
            <article key={card.title} className={`${styles.floatCard} ${card.className}`}>
              <em>{card.type}</em>
              <strong>{card.title}</strong>
              <span>{card.body}</span>
            </article>
          ))}
      </section>

      <aside className={styles.library}>
        <div className={styles.libraryInner}>
          <div className={styles.toolbar}>
            <label className={styles.search}>
              <HugeiconsIcon icon={Search01Icon} size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a story, claim, proof…"
                aria-label="Search knowledge"
              />
            </label>
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => {
                setShowCapture(true);
                setSelectedId(null);
              }}
            >
              <HugeiconsIcon icon={Add01Icon} size={14} />
              Add source
            </button>
          </div>

          <div className={styles.typeRow}>
            <button
              type="button"
              className={`${styles.typeChip} ${typeFilter === "all" ? styles.typeChipOn : ""}`}
              onClick={() => setTypeFilter("all")}
            >
              All <em>{objects.length}</em>
            </button>
            {Object.entries(TYPE_LABEL).map(([value, label]) => {
              const count = typeCounts.get(value) ?? 0;
              if (count === 0) return null;
              return (
                <button
                  key={value}
                  type="button"
                  className={`${styles.typeChip} ${typeFilter === value ? styles.typeChipOn : ""}`}
                  onClick={() => setTypeFilter(value)}
                >
                  {label} <em>{count}</em>
                </button>
              );
            })}
          </div>

          {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}
          {notice && <div className={`${styles.banner} ${styles.bannerOk}`}>{notice}</div>}

          <div className={styles.list}>
            {objects.length === 0 && !showCapture ? (
              <div className={styles.coach}>
                <h2>Start filling the brain</h2>
                <ol className={styles.steps}>
                  <li>
                    <strong>1. Add a source</strong>
                    <span>Paste a transcript or note</span>
                    <button type="button" className={styles.stepAction} onClick={() => setShowCapture(true)}>
                      Add
                    </button>
                  </li>
                  <li>
                    <strong>2. Browse</strong>
                    <span>Search and filter extracted cards</span>
                  </li>
                  <li>
                    <strong>3. Use in Studio</strong>
                    <span>Turn one idea into many formats</span>
                  </li>
                </ol>
              </div>
            ) : filtered.length === 0 ? (
              <p className={styles.emptyList}>No matches for this search or filter.</p>
            ) : (
              filtered.map((object) => (
                <button
                  key={object.id}
                  type="button"
                  className={`${styles.card} ${selectedId === object.id ? styles.cardOn : ""}`}
                  onClick={() => {
                    setSelectedId(object.id);
                    setShowCapture(false);
                  }}
                >
                  <span className={styles.cardType}>{TYPE_LABEL[object.objectType]}</span>
                  <span className={styles.cardTitle}>{object.title}</span>
                  <span className={styles.cardPreview}>{preview(object.body)}</span>
                </button>
              ))
            )}
          </div>

          {panelOpen && (
            <div className={`${styles.panel} ${styles.panelMobile}`}>
              <button type="button" className={styles.backBtn} onClick={closePanel}>
                <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
                Back
              </button>

              {showCapture ? (
                <form className={styles.capture} onSubmit={(event) => void submit(event)}>
                  <div className={styles.panelHead}>
                    <h2>Add source</h2>
                    <button type="button" className={styles.close} onClick={closePanel} aria-label="Close">
                      <HugeiconsIcon icon={Cancel01Icon} size={15} />
                    </button>
                  </div>
                  <label htmlFor="kb-title">Title</label>
                  <input
                    id="kb-title"
                    name="title"
                    required
                    minLength={2}
                    maxLength={180}
                    placeholder="Customer call on pricing"
                  />
                  <div className={styles.captureMenus}>
                    <div>
                      <span className={styles.menuLabel}>Source type</span>
                      <MenuSelect
                        block
                        ariaLabel="Source type"
                        placement="down"
                        value={sourceType}
                        options={SOURCE_OPTIONS}
                        onChange={setSourceType}
                      />
                    </div>
                    <div>
                      <span className={styles.menuLabel}>Speaker</span>
                      <MenuSelect
                        block
                        ariaLabel="Speaker"
                        placement="down"
                        value={speakerExpertId}
                        options={[
                          { value: "", label: "Unknown speaker" },
                          ...experts.map((expert) => ({ value: expert.id, label: expert.name })),
                        ]}
                        onChange={setSpeakerExpertId}
                      />
                    </div>
                    <div>
                      <span className={styles.menuLabel}>Permission</span>
                      <MenuSelect
                        block
                        ariaLabel="Permission"
                        placement="down"
                        value={permissionLevel}
                        options={PERMISSION_OPTIONS}
                        onChange={setPermissionLevel}
                      />
                    </div>
                  </div>
                  <label htmlFor="kb-transcript">Transcript</label>
                  <textarea
                    id="kb-transcript"
                    value={transcript}
                    onChange={(event) => setTranscript(event.target.value)}
                    placeholder="Paste notes, call transcript, Loom text…"
                    required
                  />
                  <div className={styles.captureActions}>
                    <label className={styles.fileBtn}>
                      <HugeiconsIcon icon={FileUploadIcon} size={14} />
                      {fileName || "Upload .txt"}
                      <input
                        type="file"
                        accept=".txt,.md,text/plain,text/markdown"
                        onChange={(event) => void readFile(event)}
                      />
                    </label>
                    <button
                      type="submit"
                      className="btnPrimary"
                      disabled={busy || transcript.trim().length < 80}
                    >
                      {busy ? "Extracting…" : "Extract"}
                    </button>
                  </div>
                </form>
              ) : selected ? (
                <>
                  <div className={styles.panelHead}>
                    <h2>{selected.title}</h2>
                    <button type="button" className={styles.close} onClick={closePanel} aria-label="Close">
                      <HugeiconsIcon icon={Cancel01Icon} size={15} />
                    </button>
                  </div>
                  <div className={styles.meta}>
                    <span className={styles.pill}>{TYPE_LABEL[selected.objectType]}</span>
                    <span className={`${styles.pill} ${styles.pillMuted}`}>{selected.status}</span>
                  </div>
                  <p className={styles.body}>{selected.body}</p>
                  <div className={styles.provenance}>
                    <span>Source: {selected.sourceName}</span>
                    {selected.speakerName && <span>Speaker: {selected.speakerName}</span>}
                    <span>Permission: {selected.permissionLevel}</span>
                    <span>Added {formatDate(selected.createdAt)}</span>
                  </div>
                  <div className={styles.actions}>
                    <Link href={`/app/studio?knowledge=${selected.id}`} className="btnPrimary">
                      <HugeiconsIcon icon={SparklesIcon} size={14} />
                      Use in Studio
                    </Link>
                    {canReview && selected.status === "proposed" && (
                      <>
                        <button
                          type="button"
                          className="btnGhost"
                          disabled={reviewing === selected.id}
                          onClick={() => void review(selected.id, "rejected")}
                        >
                          Discard
                        </button>
                        <button
                          type="button"
                          className="btnGhost"
                          disabled={reviewing === selected.id}
                          onClick={() => void review(selected.id, "approved")}
                        >
                          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} />
                          Approve
                        </button>
                      </>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
