"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SentIcon } from "@hugeicons/core-free-icons";
import styles from "./chat.module.css";
import ob from "./onboarding.module.css";

type Msg = { role: "user" | "assistant"; text: string };

export function OnboardingFlow() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const started = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, complete]);

  // Kick off (or resume) the intake once.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void call({ action: "init" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function call(payload: Record<string, unknown>, userText?: string) {
    if (busy) return;
    if (userText) setMessages((m) => [...m, { role: "user", text: userText }]);
    setBusy(true);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      const replies: string[] = res.ok ? data.messages ?? [] : [data.error ?? "something went wrong"];
      setMessages((m) => [...m, ...replies.map((t) => ({ role: "assistant" as const, text: t }))]);
      if (res.ok && data.intakeComplete) setComplete(true);
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: "network hiccup — try again." }]);
    } finally {
      setBusy(false);
    }
  }

  function answer(text: string) {
    const t = text.trim();
    if (!t) return;
    setInput("");
    void call({ action: "turn", text: t }, t);
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h1 className={styles.greeting}>
          <span>Let&apos;s set you up</span>
        </h1>
        <p className={styles.sub}>A few real questions, then Yoinky reads your history and reveals the gap.</p>
      </div>

      <div className={styles.scroll} ref={scrollRef}>
        <div className={styles.thread}>
          {messages.map((m, i) => (
            <div key={i} className={`${styles.msg} ${m.role === "user" ? styles.msgUser : styles.msgBot}`}>
              {m.text}
            </div>
          ))}
          {busy && (
            <div className={styles.typing}>
              <i />
              <i />
              <i />
            </div>
          )}
          {complete && (
            <div className={ob.completeCard}>
              <div className={ob.completeTitle}>Questions done ✓</div>
              <div className={ob.completeBody}>
                Next, connect your X or LinkedIn so Yoinky can read your real work and diagnose your brand. In the
                chat, say something like <em>&quot;connect my X @handle&quot;</em> — or connect from Telegram, where the
                bot keeps every feature and sends proactive nudges.
              </div>
              <div className={ob.completeActions}>
                <Link href="/app" className="btnPrimary">
                  Go to workspace
                </Link>
                <Link href="/app/diagnosis" className="btnGhost">
                  See diagnosis
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>

      {!complete && (
        <div className={styles.composerWrap}>
          <div className={styles.composer}>
            <textarea
              className={styles.input}
              placeholder="Type your answer…"
              value={input}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  answer(input);
                }
              }}
            />
            <div className={styles.composerFooter}>
              <span className={styles.hint}>Enter to send</span>
              <button className={styles.send} disabled={busy || !input.trim()} onClick={() => answer(input)} aria-label="Send">
                <HugeiconsIcon icon={SentIcon} size={18} strokeWidth={1.8} />
              </button>
            </div>
          </div>
          <div className={ob.skipRow}>
            <button className="btnGhost" disabled={busy} onClick={() => void call({ action: "skip-step" })}>
              ⏭ Skip this step
            </button>
            <button className="btnGhost" disabled={busy} onClick={() => void call({ action: "skip-all" })}>
              ✕ Skip onboarding
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
