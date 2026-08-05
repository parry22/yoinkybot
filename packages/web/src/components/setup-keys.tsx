"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ByokStatus, KeyProvider } from "@yoink/backend/web";
import styles from "./setup-keys.module.css";

/**
 * BYOK setup for the lifetime plan.
 *
 * Two requirements, deliberately framed as what they DO rather than as vendor
 * names: one key that writes (the model) and one that reads X (the scraper).
 * Either scraper satisfies the second - the user picks whichever account they
 * already have rather than being told to go open a specific one.
 *
 * Each key is validated against its provider on save, so "Saved" here means
 * "we made a real authenticated call with this and it worked", not "we stored a
 * string". A key that merely looks right but is revoked would otherwise unlock
 * the app into a product that fails on every action.
 */
const LLM: { provider: KeyProvider; label: string; hint: string; placeholder: string; url: string } = {
  provider: "openrouter",
  label: "Model key",
  hint: "Powers every draft, reply and analysis. OpenRouter, so one key covers every model.",
  placeholder: "sk-or-v1-…",
  url: "https://openrouter.ai/keys",
};

const SCRAPERS: { provider: KeyProvider; label: string; hint: string; placeholder: string; url: string }[] = [
  {
    provider: "twitterapi",
    label: "twitterapi.io",
    hint: "Reads your X history, analytics and buyer signals.",
    placeholder: "your twitterapi.io key",
    url: "https://twitterapi.io",
  },
  {
    provider: "apify",
    label: "Apify",
    hint: "Alternative reader - use this if you already have an Apify account.",
    placeholder: "apify_api_…",
    url: "https://console.apify.com/account/integrations",
  },
];

export function SetupKeys({ initial }: { initial: ByokStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState<ByokStatus>(initial);
  const saved = new Set(status.keys.filter((k) => k.validatedAt).map((k) => k.provider));

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.kicker}>Lifetime · BYOK</div>
        <h1 className={styles.title}>Add your keys to get started</h1>
        <p className={styles.lede}>
          You bought the lifetime deal, so Yoinky runs on your own keys - no caps, no subscription, and the usage
          bills straight to you at cost. Add both and you&apos;re in.
        </p>

        <KeyField
          {...LLM}
          done={saved.has(LLM.provider)}
          onSaved={setStatus}
          required
        />

        <div className={styles.groupLabel}>
          Reader key <span className={styles.groupNote}>- either one is enough</span>
        </div>
        {SCRAPERS.map((s) => (
          <KeyField key={s.provider} {...s} done={saved.has(s.provider)} onSaved={setStatus} />
        ))}

        <div className={styles.footer}>
          <div className={styles.checklist}>
            <Check ok={status.hasLlm} label="Model key" />
            <Check ok={status.hasScraper} label="Reader key" />
          </div>
          <button
            type="button"
            className="btnPrimary"
            disabled={!status.complete}
            onClick={() => router.replace("/app")}
          >
            {status.complete ? "Open Yoinky →" : "Add both keys to continue"}
          </button>
        </div>

        <p className={styles.fine}>
          Keys are encrypted before they&apos;re stored and are never shown back to you - you can replace or remove
          them any time in Settings.
        </p>
      </div>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`${styles.check} ${ok ? styles.checkOn : ""}`}>
      <span className={styles.checkDot}>{ok ? "✓" : ""}</span>
      {label}
    </span>
  );
}

function KeyField({
  provider,
  label,
  hint,
  placeholder,
  url,
  done,
  required,
  onSaved,
}: {
  provider: KeyProvider;
  label: string;
  hint: string;
  placeholder: string;
  url: string;
  done: boolean;
  required?: boolean;
  onSaved: (s: ByokStatus) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!value.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/byok", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, key: value.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; status?: ByokStatus };
      if (!res.ok || !data.status) {
        setErr(data.error ?? "Couldn't save that key.");
        return;
      }
      setValue("");
      onSaved(data.status);
    } catch {
      setErr("Network dropped - try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>
          {label}
          {required && <span className={styles.req}>required</span>}
          {done && <span className={styles.ok}>saved ✓</span>}
        </span>
        <a href={url} target="_blank" rel="noreferrer" className={styles.getLink}>
          Get one ↗
        </a>
      </div>
      <p className={styles.fieldHint}>{hint}</p>
      <div className={styles.row}>
        <input
          className={styles.input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={done ? "Saved - paste a new one to replace it" : placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button type="button" className={styles.saveBtn} onClick={save} disabled={busy || !value.trim()}>
          {busy ? "Checking…" : done ? "Replace" : "Save"}
        </button>
      </div>
      {err && <div className={styles.err}>{err}</div>}
    </div>
  );
}
