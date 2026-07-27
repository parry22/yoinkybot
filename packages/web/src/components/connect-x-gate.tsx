"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { Modal } from "./modal";
import { useTelegramLink } from "./use-telegram-link";
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

/** none = no X attached · reading = attached, history read in flight · failed =
 *  attached but the read died · ready = attached and read. */
type GateStatus = "none" | "reading" | "failed" | "ready";

function statusOf(x: { connected: boolean; reading: boolean; failed: boolean }): GateStatus {
  if (x.failed) return "failed";
  if (x.reading) return "reading";
  return x.connected ? "ready" : "none";
}

/**
 * The escape hatch. This gate is non-dismissible and sits at z-index 100, on top
 * of the top bar's Clerk UserButton — so before this row existed, a user with no
 * X account or a connect that kept failing had no sign-out, no help, and no way
 * out except typing /sign-in by hand. Every state of the gate ends with it.
 */
function EscapeRow() {
  const { open: openTelegram, busy } = useTelegramLink();
  return (
    <div className={styles.escape}>
      <button type="button" className={styles.escapeLink} onClick={openTelegram} disabled={busy}>
        Get help on Telegram
      </button>
      <span aria-hidden>·</span>
      <SignOutButton>
        <button type="button" className={styles.escapeLink}>
          Sign out
        </button>
      </SignOutButton>
    </div>
  );
}

function Gate({ connected, reading, failed }: { connected: boolean; reading: boolean; failed: boolean }) {
  const params = useSearchParams();
  // Set by the OAuth callback (/app?connected=x). The row is already written by
  // then, so this is only a belt-and-braces trigger for the reading state in case
  // the layout's read of it raced; the poll below is what actually resolves it.
  const justConnected = params.get("connected") === "x";
  // Set when the OAuth handshake itself blew up before any account row existed.
  const connectError = params.get("connect_error") === "1";

  const [status, setStatus] = useState<GateStatus>(() => statusOf({ connected, reading, failed }));
  const [ingested, setIngested] = useState(() => statusOf({ connected, reading, failed }) === "ready");
  const [dismissed, setDismissed] = useState(false);

  const showReading = !ingested && status !== "failed" && (status === "reading" || justConnected);
  const show = !dismissed && (status === "failed" || status === "none" || showReading);

  const [msgIndex, setMsgIndex] = useState(0);
  const [canContinue, setCanContinue] = useState(false);

  useEffect(() => {
    if (!showReading) return;
    const rotate = setInterval(() => setMsgIndex((i) => (i + 1) % READING_MESSAGES.length), 1600);
    // Poll for ingest completion; also let them proceed after a few seconds so a
    // slow read never traps them (the read keeps running in the background).
    // A read that dies mid-poll flips this straight to the failed state rather
    // than spinning forever on a job that is never coming back.
    const poll = setInterval(async () => {
      try {
        const r = (await fetch("/api/connect-status").then((res) => res.json())) as {
          connected?: boolean;
          reading?: boolean;
          failed?: boolean;
        };
        const next = statusOf({ connected: !!r.connected, reading: !!r.reading, failed: !!r.failed });
        setStatus(next);
        if (next === "ready") setIngested(true);
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
  }, [showReading]);

  if (!show) return null;

  // The read failed after a successful connect: the account is attached but there
  // is nothing to work from. Silence here left people in a permanently empty app.
  if (status === "failed") {
    return (
      <Modal open dismissible={false}>
        <div className={styles.center}>
          <div className={styles.icon}>
            <XLogo />
          </div>
          <div className={styles.title}>We couldn&apos;t read your X</div>
          <div className={styles.body}>
            Your account is connected, but pulling your posts didn&apos;t work. That&apos;s usually a protected
            account, one with very little public activity in the last few months, or X being slow to answer. Try again
            — it often goes through second time.
          </div>
          <a className={styles.xBtn} href="/api/auth/x/start">
            <XLogo size={17} />
            Try connecting again
          </a>
          <EscapeRow />
        </div>
      </Modal>
    );
  }

  if (showReading) {
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
          <div className={styles.error}>
            That didn&apos;t go through — X sent us back without finishing the handshake. Please try again.
          </div>
        )}
        <a className={styles.xBtn} href="/api/auth/x/start">
          <XLogo size={17} />
          Continue with X
        </a>
        <div className={styles.note}>we never post without your say-so.</div>
        <EscapeRow />
      </div>
    </Modal>
  );
}

export function ConnectXGate({
  connected,
  reading,
  failed,
}: {
  connected: boolean;
  reading: boolean;
  failed: boolean;
}) {
  return (
    <Suspense fallback={null}>
      <Gate connected={connected} reading={reading} failed={failed} />
    </Suspense>
  );
}
