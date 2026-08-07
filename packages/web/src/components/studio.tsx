"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUp01Icon,
  Copy01Icon,
  Layers01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { ContentAssetView, KnowledgeObjectView } from "@yoink/backend/web";
import { MenuSelect } from "./menu-select";
import chat from "./chat.module.css";
import styles from "./studio.module.css";

const FORMATS = [
  { id: "x_post", label: "Tweet / X" },
  { id: "linkedin_post", label: "LinkedIn" },
  { id: "newsletter_section", label: "Newsletter" },
  { id: "blog_outline", label: "Blog" },
  { id: "carousel_outline", label: "Carousel" },
  { id: "youtube_video_script", label: "YouTube video script" },
  { id: "short_video_script", label: "Shortform video script" },
  { id: "reddit_post", label: "Reddit" },
  { id: "email", label: "Email" },
  { id: "slides_outline", label: "Slides" },
  { id: "landing_page_section", label: "Landing page sections" },
] as const;

const TONES = [
  { id: "founder", label: "Founder Voice" },
  { id: "brand", label: "Brand Voice" },
  { id: "product", label: "Product-led" },
  { id: "sharp", label: "Sharp & Direct" },
  { id: "warm", label: "Warm & Human" },
] as const;

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta?: string;
  assetId?: string;
};

function preview(text: string, max = 90) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function Studio({
  workspaceName,
  knowledge,
}: {
  workspaceName: string;
  knowledge: KnowledgeObjectView[];
}) {
  const searchParams = useSearchParams();
  const seedId = searchParams.get("knowledge");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const cards = useMemo(
    () => knowledge.filter((item) => ["approved", "reviewed", "proposed"].includes(item.status)),
    [knowledge],
  );

  const [selected, setSelected] = useState<string[]>(seedId ? [seedId] : []);
  const [format, setFormat] = useState<(typeof FORMATS)[number]["id"]>("linkedin_post");
  const [tone, setTone] = useState<(typeof TONES)[number]["id"]>("founder");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prereqHref, setPrereqHref] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [lastAssetId, setLastAssetId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);

  const selectedCards = cards.filter((card) => selected.includes(card.id));
  const empty = messages.length === 0 && !busy;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  function toggleKnowledge(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      if (current.length >= 4) return current;
      return [...current, id];
    });
  }

  async function send(promptRaw?: string) {
    const prompt = (promptRaw ?? input).trim();
    if (busy) return;
    if (!prompt && selected.length === 0) {
      setError("Add a prompt or pick knowledge first.");
      return;
    }

    const formatLabel = FORMATS.find((item) => item.id === format)?.label ?? format;
    const toneLabel = TONES.find((item) => item.id === tone)?.label ?? tone;
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: prompt || `Generate a ${formatLabel} draft`,
        meta: `${formatLabel} · ${toneLabel}${selectedCards.length ? ` · ${selectedCards.length} knowledge` : ""}`,
      },
    ]);
    setInput("");
    setError("");
    setBusy(true);

    const response = await fetch("/api/briefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "studio_generate",
        format,
        channel: format === "x_post" ? "x" : "linkedin",
        knowledgeObjectIds: selected,
        userPrompt: prompt || undefined,
        tone: toneLabel,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      asset?: ContentAssetView;
      error?: string;
      href?: string;
    };

    if (!response.ok || !data.asset) {
      setError(data.error ?? "Could not generate a draft.");
      if (data.href) setPrereqHref(data.href);
      setBusy(false);
      return;
    }

    setPrereqHref(null);
    setLastAssetId(data.asset.id);
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.asset!.content,
        meta: selectedCards.length
          ? `From ${selectedCards.map((card) => card.title).join(" · ")}`
          : `Draft for ${workspaceName}`,
        assetId: data.asset!.id,
      },
    ]);
    setBusy(false);
  }

  async function createVariants() {
    if (!lastAssetId) {
      setError("Generate a draft first, then create variants.");
      return;
    }
    setBusy(true);
    setError("");

    const approveRes = await fetch("/api/briefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve_asset", assetId: lastAssetId }),
    });
    // If approval fails because it's already approved, continue; otherwise surface.
    if (!approveRes.ok) {
      const approveData = (await approveRes.json().catch(() => ({}))) as { error?: string };
      const message = approveData.error ?? "";
      if (!/already|approved|Only/i.test(message)) {
        // continue — atomize will give the authoritative error if still unapproved
      }
    }

    const targets = FORMATS.map((item) => item.id).filter((id) => id !== format).slice(0, 3);
    const response = await fetch("/api/briefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "atomize", assetId: lastAssetId, targetFormats: targets }),
    });
    const data = (await response.json().catch(() => ({}))) as { assets?: ContentAssetView[]; error?: string };
    if (!response.ok) {
      setError(data.error ?? "Could not create variants. Approve the draft first if checks are still pending.");
      setBusy(false);
      return;
    }
    for (const asset of data.assets ?? []) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: asset.content,
          meta: `${FORMATS.find((item) => item.id === asset.assetType)?.label ?? asset.assetType} variant`,
          assetId: asset.id,
        },
      ]);
    }
    setBusy(false);
  }

  async function copyLast() {
    const last = [...messages].reverse().find((message) => message.role === "assistant");
    if (!last) return;
    await navigator.clipboard.writeText(last.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(input);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  return (
    <div className={chat.root}>
      <div className={chat.scroll} ref={scrollRef}>
        <div className={chat.thread}>
          {empty ? (
            <>
              <div className={chat.header}>
                <div className={chat.greeting}>What should we make?</div>
                <div className={chat.sub}>
                  Pick knowledge below, choose format in the composer, then describe the draft.
                </div>
              </div>
              <div className={chat.empty}>
                {[
                  { title: "LinkedIn from a customer story", sub: "Narrative proof, short and useful." },
                  { title: "Tweet / X thread from an objection", sub: "Turn pushback into a sharp take." },
                  { title: "Newsletter from a framework", sub: "One idea, clear sections." },
                  { title: "Carousel from a claim + proof", sub: "Outline slides with source trail." },
                ].map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    className={chat.suggest}
                    onClick={() => void send(item.title)}
                  >
                    <div className={chat.suggestTitle}>{item.title}</div>
                    <div className={chat.suggestSub}>{item.sub}</div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className={`${chat.msg} ${chat.msgUser}`}>
                  {message.content}
                </div>
              ) : (
                <div key={message.id} className={chat.msgBlock}>
                  {message.meta && <span className={styles.draftMeta}>{message.meta}</span>}
                  <div className={`${chat.msg} ${chat.msgBot}`}>{message.content}</div>
                </div>
              ),
            )
          )}
          {busy && <div className={chat.msg}>Generating…</div>}
        </div>
      </div>

      <form className={chat.composerWrap} onSubmit={onSubmit}>
        {cards.length > 0 && (
          <div className={styles.knowledgeRow}>
            {cards.slice(0, 10).map((card) => {
              const active = selected.includes(card.id);
              return (
                <button
                  type="button"
                  key={card.id}
                  className={`${styles.chip} ${active ? styles.chipActive : ""}`}
                  onClick={() => toggleKnowledge(card.id)}
                  title={card.title}
                >
                  {preview(card.title, 26)}
                </button>
              );
            })}
          </div>
        )}

        <div className={chat.composer}>
          <textarea
            ref={taRef}
            className={chat.input}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask for a draft…"
            rows={1}
          />
          <div className={chat.composerFooter}>
            <div className={styles.composerControls}>
              <MenuSelect
                compact
                ariaLabel="Format"
                value={format}
                options={FORMATS.map((item) => ({ value: item.id, label: item.label }))}
                onChange={(value) => setFormat(value as (typeof FORMATS)[number]["id"])}
              />
              <MenuSelect
                compact
                ariaLabel="Tone"
                value={tone}
                options={TONES.map((item) => ({ value: item.id, label: item.label }))}
                onChange={(value) => setTone(value as (typeof TONES)[number]["id"])}
              />
              {error && (
                <span className={chat.hintError}>
                  {error}
                  {prereqHref && (
                    <>
                      {" "}
                      <a href={prereqHref} className={styles.prereqLink}>
                        Fix this
                      </a>
                    </>
                  )}
                </span>
              )}
            </div>
            <div className={styles.footerActions}>
              <button type="button" className={styles.iconBtn} onClick={() => void copyLast()} disabled={messages.length === 0} title="Copy last draft">
                <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={15} />
              </button>
              <button type="button" className={styles.iconBtn} onClick={() => void createVariants()} disabled={busy} title="Create variants">
                <HugeiconsIcon icon={Layers01Icon} size={15} />
              </button>
              <button
                type="submit"
                className={chat.send}
                disabled={busy || (!input.trim() && selected.length === 0)}
                aria-label="Send"
              >
                <HugeiconsIcon icon={ArrowUp01Icon} size={16} strokeWidth={2} />
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
