"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./login.module.css";

const ERROR_MESSAGES: Record<string, string> = {
  google_unconfigured: "Google sign-in isn't set up on this instance yet.",
  google_state: "Google sign-in couldn't be verified. Try again.",
  google_email: "Google didn't return a verified email. Try X instead.",
  google_failed: "Google sign-in failed. Try again.",
  x_unconfigured: "X sign-in isn't set up on this instance yet.",
  x_failed: "X sign-in failed. Try again.",
};

function LoginForm() {
  const params = useSearchParams();
  const error = ERROR_MESSAGES[params.get("error") ?? ""] ?? "";

  return (
    <div className={styles.panel}>
      <div className={styles.brand}>
        <img src="/favicon.png" alt="" className={styles.dot} />
        Yoinky
      </div>
      <p className={styles.lede}>
        The narrative engine for your personal brand. Sign in to get started.
      </p>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.authButtons}>
        <a className={styles.googleBtn} href="/api/auth/google/start">
          <GoogleG />
          Continue with Google
        </a>
        <a className={styles.xBtn} href="/api/auth/x/start">
          <XLogo />
          Continue with X
        </a>
      </div>

      <p className={styles.foot}>
        Yoinky also lives in Telegram as an add-on for capture and proactive nudges once you&apos;re set up.
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

function XLogo() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden focusable="false" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
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
