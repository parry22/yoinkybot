"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { strFromU8, unzipSync } from "fflate";
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
import { useFlashMessage } from "../lib/use-flash-message";
import { MenuSelect } from "./menu-select";
import styles from "./knowledge-shelf.module.css";

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

type ImportedConversation = { title: string; transcript: string };

const EMPTY_ORBIT_CARDS = [
  {
    type: "Story",
    title: "Your customer stories",
    body: "Bring conversations, notes, and call transcripts into the brain.",
  },
  {
    type: "Claim",
    title: "Your point of view",
    body: "Clear claims become reusable building blocks for every draft.",
  },
  {
    type: "Proof",
    title: "The proof behind it",
    body: "Keep the evidence that gives your ideas weight and credibility.",
  },
  {
    type: "Objection",
    title: "The questions buyers ask",
    body: "Capture objections while the language is fresh and useful.",
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  if (Array.isArray(record.parts)) return record.parts.map(contentText).filter(Boolean).join("\n");
  return [record.text, record.value, record.content].map(contentText).filter(Boolean).join("\n");
}

function messageLine(value: unknown): string {
  const entry = asRecord(value);
  if (!entry) return "";
  const message = asRecord(entry.message) ?? entry;
  const author = asRecord(message.author);
  const role = typeof author?.role === "string" ? author.role : typeof message.role === "string" ? message.role : "conversation";
  const body = contentText(message.content ?? message.text ?? message.body);
  if (!body.trim() || role === "system" || role === "tool") return "";
  return `${role === "assistant" ? "Assistant" : role === "user" ? "User" : role}: ${body.trim()}`;
}

/** Supports ChatGPT's `conversations.json` and common Claude JSON exports. */
function conversationsFromExport(value: unknown): ImportedConversation[] {
  const root = asRecord(value);
  const records = Array.isArray(value)
    ? value
    : Array.isArray(root?.conversations)
      ? root.conversations
      : Array.isArray(root?.data)
        ? root.data
        : [];

  return records.flatMap((value, index) => {
    const record = asRecord(value);
    if (!record) return [];
    const title = typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : `Conversation ${index + 1}`;
    const mapping = asRecord(record.mapping);
    const rawMessages = mapping
      ? Object.values(mapping).sort((left, right) => {
          const leftMessage = asRecord(asRecord(left)?.message);
          const rightMessage = asRecord(asRecord(right)?.message);
          return Number(leftMessage?.create_time ?? 0) - Number(rightMessage?.create_time ?? 0);
        })
      : Array.isArray(record.chat_messages)
        ? record.chat_messages
        : Array.isArray(record.messages)
          ? record.messages
          : [];
    const transcript = rawMessages.map(messageLine).filter(Boolean).join("\n\n");
    return transcript.length >= 80 ? [{ title: title.slice(0, 180), transcript }] : [];
  });
}

async function conversationsFromFile(file: File): Promise<ImportedConversation[]> {
  const filename = file.name.toLowerCase();
  let exportValue: unknown;

  if (filename.endsWith(".zip")) {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const conversationFile = Object.keys(entries).find((name) => /(^|\/)conversations(?:[-_].*)?\.json$/i.test(name))
      ?? Object.keys(entries).find((name) => name.toLowerCase().endsWith(".json"));
    if (!conversationFile) {
      throw new Error("No conversation JSON file was found in that ZIP export.");
    }
    exportValue = JSON.parse(strFromU8(entries[conversationFile]!));
  } else if (filename.endsWith(".json")) {
    exportValue = JSON.parse(await file.text());
  } else {
    throw new Error("Choose the downloaded ZIP export or its conversation JSON file.");
  }

  const conversations = conversationsFromExport(exportValue);
  if (conversations.length === 0) {
    throw new Error("No readable conversations were found in that export.");
  }
  return conversations;
}

function importedTranscript(items: ImportedConversation[], selected: number[]): string {
  return selected
    .map((index) => items[index])
    .filter((item): item is ImportedConversation => Boolean(item))
    .map((item) => `# ${item.title}\n\n${item.transcript}`)
    .join("\n\n---\n\n")
    .slice(0, 100_000);
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
  const importKind = searchParams.get("import") === "chatgpt" || searchParams.get("import") === "claude"
    ? searchParams.get("import")
    : null;
  const importTitle = importKind ? `${importKind === "chatgpt" ? "ChatGPT" : "Claude"} conversations` : "";

  const [objects, setObjects] = useState(initialObjects);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(focusId);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const { message: error, flash: setError, clear: clearError } = useFlashMessage(4000);
  const { message: notice, flash: setNotice, clear: clearNotice } = useFlashMessage(3500);
  const [transcript, setTranscript] = useState("");
  const [fileName, setFileName] = useState("");
  const [captureTitle, setCaptureTitle] = useState(importTitle);
  const [importedConversations, setImportedConversations] = useState<ImportedConversation[]>([]);
  const [selectedConversations, setSelectedConversations] = useState<number[]>([]);
  const [showCapture, setShowCapture] = useState(Boolean(importKind));
  const [sourceType, setSourceType] = useState(importKind ? "internal_document" : "founder_interview");
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

  const orbitCards = useMemo(() => {
    if (objects.length === 0) return EMPTY_ORBIT_CARDS;
    return objects.slice(0, 4).map((object) => ({
      type: TYPE_LABEL[object.objectType],
      title: object.title,
      body: preview(object.body, 82),
    }));
  }, [objects]);
  const selected = objects.find((object) => object.id === selectedId) ?? null;
  const panelOpen = showCapture || Boolean(selected);

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    if (importKind) {
      try {
        const conversations = await conversationsFromFile(file);
        const selected = [0];
        setImportedConversations(conversations);
        setSelectedConversations(selected);
        setTranscript(importedTranscript(conversations, selected));
        setCaptureTitle(`${importKind === "chatgpt" ? "ChatGPT" : "Claude"}: ${conversations[0]!.title}`);
        return;
      } catch (error) {
        setError(error instanceof Error ? error.message : "That export could not be read. Try the downloaded ZIP or paste a chat instead.");
      }
      return;
    }
    const text = await file.text();
    setImportedConversations([]);
    setSelectedConversations([]);
    setTranscript(text);
  }

  function toggleConversation(index: number) {
    setSelectedConversations((current) => {
      const next = current.includes(index) ? current.filter((item) => item !== index) : [...current, index];
      setTranscript(importedTranscript(importedConversations, next));
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    clearError();
    clearNotice();
    const response = await fetch("/api/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: captureTitle,
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
      setError(data.error ?? "Couldn't pull ideas from that source. Try again in a moment.");
      setBusy(false);
      return;
    }
    if (data.objects?.length) {
      setObjects((current) => [...data.objects!, ...current]);
      setSelectedId(data.objects[0]?.id ?? null);
    }
    setNotice(
      (data.objects?.length ?? 0) > 0
        ? `Added ${data.objects!.length} item${data.objects!.length === 1 ? "" : "s"} to Knowledge.`
        : "Source saved.",
    );
    setShowCapture(false);
    setTranscript("");
    setFileName("");
    setCaptureTitle("");
    setImportedConversations([]);
    setSelectedConversations([]);
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
      setError(data.error ?? "Couldn't save that review. Try again in a moment.");
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
        <div className={styles.faceAura} />
        <div className={styles.headFigure}>
          <Image
            src="/knowledge/human-head-seamless.png"
            alt=""
            fill
            priority
            sizes="(max-width: 1000px) 0px, 58vw"
          />
        </div>
        {orbitCards.map((card, index) => (
          <div key={`${card.title}-${index}`} className={`${styles.orbitPath} ${styles[`orbit${index + 1}`]}`}>
            <article className={styles.orbitCard}>
              <em>{card.type}</em>
              <strong>{card.title}</strong>
              <span>{card.body}</span>
            </article>
          </div>
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

          {error && (
            <div className={`${styles.banner} ${styles.bannerError}`} role="status">
              {error}
            </div>
          )}
          {notice && (
            <div className={`${styles.banner} ${styles.bannerOk}`} role="status">
              {notice}
            </div>
          )}

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
                    <strong>2. Pull from Integrations</strong>
                    <span>Connect social accounts or import a ChatGPT / Claude export</span>
                    <Link href="/app/integrations" className={styles.stepAction}>
                      Integrations
                    </Link>
                  </li>
                  <li>
                    <strong>3. Browse</strong>
                    <span>Search and filter extracted cards</span>
                  </li>
                  <li>
                    <strong>4. Use in Studio</strong>
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
                  <p className={styles.captureHint}>
                    {importKind
                      ? `Choose the downloaded ZIP or its conversation JSON. Select only the ${importKind === "chatgpt" ? "ChatGPT" : "Claude"} chats you want to use, or paste one below. Your account is never connected or read directly.`
                      : <>Paste notes here, or <Link href="/app/integrations">import from Integrations</Link> (social accounts or chat exports).</>}
                  </p>
                  <label htmlFor="kb-title">Title</label>
                  <input
                    id="kb-title"
                    name="title"
                    required
                    minLength={2}
                    maxLength={180}
                    value={captureTitle}
                    onChange={(event) => setCaptureTitle(event.target.value)}
                    placeholder={importKind ? "Conversation import" : "Customer call on pricing"}
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
                  {importedConversations.length > 0 && (
                    <fieldset className={styles.conversationPicker}>
                      <legend>Conversations to import</legend>
                      <span>Select only material you are allowed to use. Imports are capped at 100,000 characters.</span>
                      <div>
                        {importedConversations.slice(0, 30).map((conversation, index) => (
                          <label key={`${conversation.title}-${index}`} className={styles.conversationOption}>
                            <input
                              type="checkbox"
                              checked={selectedConversations.includes(index)}
                              onChange={() => toggleConversation(index)}
                            />
                            <span>{conversation.title}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  <div className={styles.captureActions}>
                    <label className={styles.fileBtn}>
                      <HugeiconsIcon icon={FileUploadIcon} size={14} />
                      {fileName || (importKind ? "Choose export" : "Upload .txt")}
                      <input
                        type="file"
                        accept={importKind ? ".zip,.json,application/zip,application/x-zip-compressed,application/json" : ".txt,.md,text/plain,text/markdown"}
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
