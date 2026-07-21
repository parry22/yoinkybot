"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Modal } from "./modal";
import styles from "./connect-x-gate.module.css";

function XLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const READING_MESSAGES = [
  "reading your recent posts…",
  "learning how you actually write…",
  "spotting the themes you keep returning to…",
  "finding your throughline…",
  "personalizing Yoinky for you…",
];

function Gate({ connected }: { connected: boolean }) {
  const params = useSearchParams();
  const justConnected = params.get("connected") === "x";
  const connectError = params.get("connect_error") === "1";

  // Hard-block when X isn't connected. Show the reading animation right after a
  // fresh connect. Otherwise no gate.
  const [dismissed, setDismissed] = useState(false);
  const reading = connected && justConnected;
  const show = !dismissed && (!connected || reading);

  const [msgIndex, setMsgIndex] = useState(0);
  const [canContinue, setCanContinue] = useState(false);

  useEffect(() => {
    if (!reading) return;
    const rotate = setInterval(() => setMsgIndex((i) => (i + 1) % READING_MESSAGES.length), 1600);
    // Poll for ingest completion; also let them proceed after a few seconds so a
    // slow read never traps them (the read keeps running in the background).
    const poll = setInterval(async () => {
      try {
        const r = await fetch("/api/connect-status").then((res) => res.json());
        if (r.status === "ingested") setDismissed(true);
      } catch {
        /* ignore */
      }
    }, 2500);
    const allow = setTimeout(() => setCanContinue(true), 6000);
    return () => {
      clearInterval(rotate);
      clearInterval(poll);
      clearTimeout(allow);
    };
  }, [reading]);

  if (!show) return null;

  if (reading) {
    return (
      <Modal open dismissible={false}>
        <div className={styles.center}>
          <div className={styles.scanner}>
            <div className={styles.ring} />
            <div className={styles.ring2} />
            <div className={styles.avatarCore}>
              <XLogo size={18} />
            </div>
          </div>
          <div className={styles.title}>Reading your X</div>
          <div className={styles.readingMsg}>{READING_MESSAGES[msgIndex]}</div>
          <div className={styles.progressTrack}>
            <div className={styles.progressBar} />
          </div>
          {canContinue ? (
            <button className={styles.xBtn} style={{ marginTop: 20 }} onClick={() => setDismissed(true)}>
              Start using Yoinky
            </button>
          ) : (
            <div className={styles.note}>this takes a moment. hang tight.</div>
          )}
        </div>
      </Modal>
    );
  }

  // Not connected → hard, non-dismissible connect prompt.
  return (
    <Modal open dismissible={false}>
      <div className={styles.center}>
        <div className={styles.icon}>
          <XLogo />
        </div>
        <div className={styles.title}>Connect your X to continue</div>
        <div className={styles.body}>
          Yoinky works off your real posts. Connect your X account so it can read your history, learn your voice, and
          personalize everything for you. This is required to use the app.
        </div>
        {connectError && (
          <div className={styles.body} style={{ color: "#e5484d" }}>
            That didn&apos;t go through. Please try again.
          </div>
        )}
        <a className={styles.xBtn} href="/api/auth/x/start">
          <XLogo size={17} />
          Continue with X
        </a>
        <div className={styles.note}>we never post without your say-so.</div>
      </div>
    </Modal>
  );
}

export function ConnectXGate({ connected }: { connected: boolean }) {
  return (
    <Suspense fallback={null}>
      <Gate connected={connected} />
    </Suspense>
  );
}
