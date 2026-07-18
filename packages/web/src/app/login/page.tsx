"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./login.module.css";

const ERROR_MESSAGES: Record<string, string> = {
  expired: "That link expired — request a new one.",
  google_unconfigured: "Google sign-in isn't configured yet. Use your email below.",
  google_state: "Google sign-in couldn't be verified — try again.",
  google_email: "Google didn't return a verified email — try email sign-in.",
  google_failed: "Google sign-in failed — try again.",
};

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [error, setError] = useState(ERROR_MESSAGES[params.get("error") ?? ""] ?? "");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | undefined>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
      } else {
        setSent(true);
        setDevLink(data.devLink);
      }
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.brand}>
        <img src="/favicon.png" alt="" className={styles.dot} />
        Yoinky
      </div>
      <p className={styles.lede}>
        The narrative engine for your personal brand. Sign in with your email — we&apos;ll send a magic link, no password.
      </p>

      {sent ? (
        <div className={styles.sent}>
          Check your inbox — we sent a sign-in link to <strong>{email}</strong>. It expires in 30 minutes.
          {devLink && (
            <>
              <br />
              <a className={styles.devLink} href={devLink}>
                Dev link (no mailer configured) → sign in
              </a>
            </>
          )}
        </div>
      ) : (
        <>
          <a className={styles.googleBtn} href="/api/auth/google/start">
            <GoogleG />
            Continue with Google
          </a>
          <div className={styles.divider}>
            <span>or</span>
          </div>
          <form className={styles.form} onSubmit={submit}>
            <input
              className="field"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <div className={styles.error}>{error}</div>
            <button className="btnPrimary" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send magic link"}
            </button>
          </form>
        </>
      )}

      <p className={styles.foot}>
        Prefer Telegram? Yoinky still lives there too — the bot keeps every feature and sends the proactive nudges.
      </p>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path fill="#FFC107" d="M43.6 20.1H24v8h11.3C33.7 33 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.7-8 19.7-20 0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 34.9 26.7 36 24 36c-5.3 0-9.7-3-11.3-7.9l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H24v8h11.3c-.8 2.3-2.3 4.2-4.3 5.5l6.3 5.3C41.4 35.8 44 30.4 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <div className={styles.shell}>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
