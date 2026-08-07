"use client";

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { useAgentStream } from "./use-agent-stream";
import { UpgradeCTA } from "./upgrade-cta";
import { AgentShimmer } from "./agent-shimmer";
import styles from "./chat.module.css";
import type { ContentBriefView } from "@yoink/backend/web";

type Draft = { id: string; content: string; platform: string; created_at?: string };

type Entry =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string }
  | { kind: "draft"; id: string; content: string; platform: string };
const SESSION_KEY = "yoinky:compose-conversation:v1";

const SUGGESTIONS = [
  { title: "Write from what I've been thinking", sub: "Turns your captures into a post in your voice" },
  { title: "What's trending in my niche right now?", sub: "Searches X and the web live, then gives you angles" },
  { title: "What have I said about pricing?", sub: "Searches everything you've told me" },
  { title: "Reshape my last post for LinkedIn", sub: "Same idea, native to the platform" },
];

/**
 * Compose is a chat, not a form.
 *
 * It used to be a top-anchored textarea with a "Write it" button and a list of
 * results underneath, which framed the agent as a one-shot generator. It's now a
 * transcript with the composer pinned to the bottom, talking to the same brain the
 * Telegram bot uses (`/api/chat/stream`) - so it can draft, search memory, check a
 * draft, repurpose or schedule, and you can follow up in context.
 *
 * While a turn runs, the activity feed shows the steps actually being taken. Those
 * labels come from the tool the model invoked and from the draft pipeline, written
 * in code (web/stream.ts) - never scraped from model narration, which under
 * enforced structured output frequently isn't emitted at all.
 */
export function Compose({ initialDrafts,workspaceContext }: { initialDrafts: Draft[];workspaceContext:{id:string;name:string;type:string;expert:string|null;narrativeVersion:number|null;brief:ContentBriefView|null}|null }) {
  const [entries, setEntries] = useState<Entry[]>(() =>
    // Seed with the most recent drafts so the page isn't blank on return, newest
    // last (chat order).
    [...initialDrafts]
      .slice(0, 4)
      .reverse()
      .map((d) => ({ kind: "draft" as const, id: d.id, content: d.content, platform: d.platform })),
  );
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  /** A 402 isn't an error message, it's a wall - it gets the upgrade link, not
   *  a grey line of hint text you can't act on. */
  const [paywalled, setPaywalled] = useState(false);
  const [briefDrafting,setBriefDrafting]=useState(false);
  const { run, activity, busy } = useAgentStream();
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Navigation should not erase an in-progress conversation. Session storage is
  // deliberately scoped to this browser tab and is replaced by fresh drafts on
  // a new session, avoiding cross-device or cross-account transcript leakage.
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`${SESSION_KEY}:${workspaceContext?.id??"personal"}`) ?? "null") as { entries?: Entry[] } | null;
      if (saved && Array.isArray(saved.entries) && saved.entries.length) setEntries(saved.entries);
    } catch {
      sessionStorage.removeItem(`${SESSION_KEY}:${workspaceContext?.id??"personal"}`);
    }
  }, [workspaceContext?.id]);

  useEffect(() => {
    if (busy) return;
    try {
      sessionStorage.setItem(`${SESSION_KEY}:${workspaceContext?.id??"personal"}`, JSON.stringify({ entries }));
    } catch {
      // The current chat remains usable when browser storage is unavailable.
    }
  }, [entries, busy,workspaceContext?.id]);

  async function draftSelectedBrief(){if(!workspaceContext?.brief||briefDrafting)return;setBriefDrafting(true);setError("");const response=await fetch("/api/briefs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"draft",briefId:workspaceContext.brief.id})});const data=await response.json().catch(()=>({})) as {asset?:{id:string;content:string;assetType:string};error?:string};if(response.ok&&data.asset)add({kind:"draft",id:data.asset.id,content:data.asset.content,platform:data.asset.assetType});else setError(data.error??"Could not draft from this brief.");setBriefDrafting(false);}

  const add = (e: Entry) => setEntries((prev) => [...prev, e]);
  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Follow the conversation as it grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, activity, busy]);

  // Grow the textarea with its content, up to the stylesheet's max-height.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setError("");
    setPaywalled(false);
    setInput("");
    add({ kind: "user", id: uid(), text: t });

    await run(
      "/api/chat/stream",
      { text: t },
      {
        onMessage: (msg) => {
          // A message carrying a drafted post gets its own card (copyable, keeps
          // its own capitalization) instead of a chat bubble.
          const draft = extractDraft(msg);
          if (draft) add({ kind: "draft", id: uid(), content: draft, platform: "x" });
          else add({ kind: "agent", id: uid(), text: msg });
        },
        onError: (message, status) => {
          if (status === 402) setPaywalled(true);
          else setError(message);
        },
      },
    );
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter is a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  const empty = entries.length === 0 && !busy;

  return (
    <div className={styles.root}>
      <div className={styles.scroll} ref={scrollRef}>
        <div className={styles.thread}>
          {workspaceContext&&<div className={styles.workspaceContext}><div><span>{workspaceContext.type==="company"?"Company workspace":"Personal workspace"}</span><strong>{workspaceContext.name}</strong></div><div><span>Voice</span><strong>{workspaceContext.expert??"Not set"}</strong></div><div><span>Narrative</span><strong>{workspaceContext.narrativeVersion?`Version ${workspaceContext.narrativeVersion}`:"Not active"}</strong></div>{workspaceContext.brief&&<div className={styles.selectedBrief}><span>Selected brief · {workspaceContext.brief.channel}</span><strong>{workspaceContext.brief.objective}</strong><small>{workspaceContext.brief.audienceName} · {workspaceContext.brief.sourceCount} traceable sources</small><button type="button" onClick={()=>void draftSelectedBrief()} disabled={briefDrafting||workspaceContext.brief.status!=="ready"}>{workspaceContext.brief.status==="ready"?(briefDrafting?"Drafting…":"Draft with governed context"):`Brief is ${workspaceContext.brief.status}`}</button></div>}</div>}
          {empty ? (
            <>
              <div className={styles.header}>
                <div className={styles.greeting}>What are we shipping?</div>
                <div className={styles.sub}>
                  Drop a thought and I&apos;ll write it in your voice - grounded in what you&apos;ve actually said, and
                  in what&apos;s actually worked for you.
                </div>
              </div>
              {/* .empty is the 2-col grid; .suggest is each card. */}
              <div className={styles.empty}>
                {SUGGESTIONS.map((s) => (
                  <button key={s.title} className={styles.suggest} onClick={() => void send(s.title)}>
                    <div className={styles.suggestTitle}>{s.title}</div>
                    <div className={styles.suggestSub}>{s.sub}</div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            entries.map((e, i) => {
              // Only open a gap when the speaker changes, so a multi-part agent
              // answer reads as one answer rather than three loose blocks.
              const prev = entries[i - 1];
              const speaker = e.kind === "user" ? "user" : "agent";
              const prevSpeaker = prev ? (prev.kind === "user" ? "user" : "agent") : null;
              const gap = prevSpeaker !== null && prevSpeaker !== speaker ? styles.turnGap : "";

              // A drafted post and an ordinary reply are the same object on
              // screen - plain agent text. The draft only differs in carrying a
              // copy action, because a post is a thing you take somewhere.
              if (e.kind === "draft") {
                return (
                  <AgentMessage key={e.id} text={e.content} className={gap} copyable />
                );
              }
              if (e.kind === "agent") {
                return <AgentMessage key={e.id} text={e.text} className={gap} />;
              }
              return (
                <div key={e.id} className={`${styles.msg} ${styles.msgUser} ${gap}`}>
                  {e.text}
                </div>
              );
            })
          )}

          {/* One shimmering line of the CURRENT action, for the whole turn. It
           *  shows the last stage the stream emitted (falling back to a starter
           *  before the first stage arrives), so there is always something moving
           *  on screen between a completed step and the reply landing - the old
           *  strand where a static tick list sat still is gone. */}
          {busy && (
            <AgentShimmer
              label={activity.find((a) => a.active)?.label ?? activity.at(-1)?.label ?? "Thinking it through"}
            />
          )}
        </div>
      </div>

      <div className={styles.composerWrap}>
        {/* Sits above the composer at the composer's own width (--content-width
            is set on .root) so the wall reads as part of the input, not as a
            message in the thread. */}
        {paywalled && (
          <div style={{ width: "var(--content-width)", marginInline: "auto", marginBottom: 10 }}>
            <UpgradeCTA message="Your trial has ended - upgrade to keep composing." plan="growth" />
          </div>
        )}
        <div className={styles.composer}>
          {/* Placeholder is short on purpose: the box is one row until you type,
              and a longer one wraps to two lines and clips on a narrow phone. */}
          <textarea
            ref={taRef}
            className={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="What's on your mind?"
            rows={1}
          />
          <div className={styles.composerFooter}>
            <span className={`${styles.hint} ${error ? styles.hintError : ""}`}>
              {error}
            </span>
            <button
              className={styles.send}
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
  );
}

/**
 * The bot delivers a draft as "✍️ here you go:\n\n<post>" (telegram/actions.ts).
 * Pull the post body out so it can render as a copyable card. Anything not
 * recognisably a draft stays an ordinary message - no guessing.
 */
function extractDraft(msg: string): string | null {
  const m = msg.match(/^✍️[^\n]*\n\n([\s\S]+)$/);
  if (!m) return null;
  // Drop the trailing media nudge - it's guidance about the post, not the post.
  return (m[1] ?? "").split("\n\n📎 pair it with:")[0]!.trim() || null;
}

/**
 * An agent turn: bare text on the canvas, with the copy affordance sitting
 * *under* it rather than in a header bar above it. `copyable` is on for drafts -
 * the only agent output you'd actually want on your clipboard.
 */
export function AgentMessage({
  text,
  className = "",
  copyable = false,
}: {
  text: string;
  className?: string;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  }

  return (
    <div className={`${styles.msgBlock} ${className}`}>
      <div className={`${styles.msg} ${styles.msgBot}`}>{text}</div>
      {copyable && (
        <div className={styles.actions}>
          <button
            className={`${styles.iconBtn} ${copied ? styles.iconBtnDone : ""}`}
            onClick={copy}
            aria-label={copied ? "Copied" : "Copy"}
            title={copied ? "Copied" : "Copy"}
          >
            <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={15} strokeWidth={1.8} />
          </button>
        </div>
      )}
    </div>
  );
}
