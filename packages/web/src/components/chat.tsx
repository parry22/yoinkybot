"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SentIcon } from "@hugeicons/core-free-icons";
import styles from "./chat.module.css";

type Msg = { role: "user" | "assistant"; text: string };

const SUGGESTIONS = [
  { title: "Where am I at?", sub: "Get a read on your progress and plan", send: "where am i at?" },
  { title: "What have I said about…", sub: "Search your own thinking", send: "what have i said about pricing?" },
  { title: "Draft a post", sub: "Turn a thought into a post in your voice", send: "draft a post about something I learned this week" },
  { title: "Check a draft", sub: "Does this contradict what you've said?", send: "does this contradict anything I've said: " },
];

export function ChatWorkspace({ initial, onboarding }: { initial: Msg[]; onboarding: boolean }) {
  const [messages, setMessages] = useState<Msg[]>(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: trimmed }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      const data = await res.json();
      const replies: string[] = res.ok ? data.messages ?? [] : [data.error ?? "something went wrong"];
      setMessages((m) => [...m, ...replies.map((t) => ({ role: "assistant" as const, text: t }))]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: "network hiccup — try again in a sec." }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h1 className={styles.greeting}>
          <span>Yoinky</span> — your narrative engine
        </h1>
        <p className={styles.sub}>Drop a thought, ask what you&apos;ve said, or spin one up into a post.</p>
      </div>

      {onboarding && (
        <div className={styles.banner}>
          <span>Finish setup so Yoinky can diagnose your brand and work it proactively.</span>
          <Link href="/app/onboarding" className={styles.bannerLink}>
            Finish setup →
          </Link>
        </div>
      )}

      <div className={styles.scroll} ref={scrollRef}>
        <div className={styles.thread}>
          {messages.length === 0 && (
            <div className={styles.empty}>
              {SUGGESTIONS.map((s) => (
                <button key={s.title} className={styles.suggest} onClick={() => (s.send.endsWith(": ") ? setInput(s.send) : void send(s.send))}>
                  <div className={styles.suggestTitle}>{s.title}</div>
                  <div className={styles.suggestSub}>{s.sub}</div>
                </button>
              ))}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`${styles.msg} ${m.role === "user" ? styles.msgUser : styles.msgBot}`}>
              {m.text}
            </div>
          ))}
          {busy && (
            <div className={styles.typing} aria-label="Yoinky is typing">
              <i />
              <i />
              <i />
            </div>
          )}
        </div>
      </div>

      <div className={styles.composerWrap}>
        <div className={styles.composer}>
          <textarea
            ref={inputRef}
            className={styles.input}
            placeholder="Tell Yoinky something, or ask a question…"
            value={input}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className={styles.composerFooter}>
            <span className={styles.hint}>Enter to send · Shift+Enter for a new line</span>
            <button className={styles.send} disabled={busy || !input.trim()} onClick={() => void send(input)} aria-label="Send">
              <HugeiconsIcon icon={SentIcon} size={18} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
