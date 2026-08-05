"use client";

import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon, Bookmark01Icon, RadarIcon } from "@hugeicons/core-free-icons";
import { UpgradeCTA } from "./upgrade-cta";
import panel from "./panel.module.css";
import styles from "./buyers-radar.module.css";

interface SignalView {
  id: string;
  handle: string;
  name: string | null;
  initials: string;
  content: string;
  url: string | null;
  match: number;
  why: string | null;
  intentType: string | null;
  verdict: string;
  postedAt: string | null;
}

/** Plain-language label for the intent bucket, shown as the lead's headline. */
const INTENT_LABEL: Record<string, string> = {
  explicit_ask: "Asking for a recommendation",
  competitor_dissatisfaction: "Unhappy with what they use",
  pain: "Describing the problem you solve",
  trigger_event: "Just hit the moment they'd need you",
};
interface Status {
  enabled: boolean;
  hasIcp: boolean;
  used: number;
  cap: number | null;
  remaining: number | null;
}
interface IcpView {
  productOneliner: string;
  buyerDescription: string;
  painSignals: string[];
  competitorTerms: string[];
  exclusions: string[];
  complete: boolean;
}
interface Prefill {
  product_oneliner: string;
  buyer_description: string;
  pain_signals: string[];
}
/** What a completed scan job returns (backend ScanResponse). */
interface ScanOutcome {
  status: string;
  surfaced: number;
  signals: SignalView[];
  reason: string | null;
  note: string | null;
}

export function BuyersRadar({
  status,
  initialSignals,
  icp,
  prefill,
}: {
  status: Status;
  initialSignals: SignalView[];
  icp: IcpView | null;
  prefill: Prefill;
}) {
  const [signals, setSignals] = useState<SignalView[]>(initialSignals);
  const [used, setUsed] = useState(status.used);
  const [hasIcp, setHasIcp] = useState(status.hasIcp);
  const [editing, setEditing] = useState(!status.hasIcp);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  function relTime(iso: string | null): string {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
  }

  /**
   * A scan now runs on the backend as a pg-boss job rather than inside the API
   * request (docs/INTERNAL §3n - SDK-mode composition spawns a subprocess, which
   * a Vercel function cannot host). So: POST to start, then poll until it lands.
   */
  async function runScan() {
    setScanning(true);
    setScanMsg(null);
    try {
      const res = await fetch("/api/buyers-radar/scan", { method: "POST" });
      const data = await res.json();
      // 402 and 429 are NOT the same answer and must not share a branch. 402 is
      // "you need to pay" → show the upgrade CTA. 429 is the burst limiter
      // (backend lib/rate-limit.ts), which a fully paid-up customer hits by
      // tapping Scan twice - telling them to upgrade would be both wrong and
      // insulting. It carries its own "try again in N" copy; just show it.
      if (res.status === 402) {
        setLocked(true);
        setScanMsg(null);
        return;
      }
      if (res.status === 429) {
        setLocked(false);
        setScanMsg(data.error ?? "you're scanning faster than I can search - give it a minute.");
        return;
      }
      if (!res.ok || !data.jobId) {
        setScanMsg(data.error ?? "scan failed");
        return;
      }
      setScanMsg("Scanning X for buyer signals…");
      const result = await pollScan(data.jobId);
      if (!result) {
        // Still running when we stopped polling. The job keeps going and its
        // results persist, so the honest message is "come back", not "failed".
        setScanMsg("Still scanning - this one's taking a while. Refresh in a minute to see what it found.");
        return;
      }
      // The server list is authoritative (all surfaced+replied leads), but never
      // let an empty/short response clear leads we're already showing - "no new
      // signals this round" must not read as "your radar is empty".
      const returned = result.signals ?? [];
      setSignals((prev) => {
        if (returned.length === 0) return prev;
        const seen = new Set(returned.map((s) => s.id));
        return [...returned, ...prev.filter((p) => !seen.has(p.id))];
      });
      setUsed((u) => u + (result.surfaced ?? 0));
      // The backend says why a scan came back empty (buyer/scan.ts stages) - an
      // empty radar has several causes and they need different things from you.
      if (result.surfaced === 0)
        setScanMsg(result.reason ?? "No new buyer signals this round. Yoinky will keep looking.");
      else
        setScanMsg(
          `Found ${result.surfaced} new lead${result.surfaced === 1 ? "" : "s"}.` +
            (result.note ? ` ${result.note}` : ""),
        );
    } catch {
      setScanMsg("scan failed");
    } finally {
      setScanning(false);
    }
  }

  /**
   * Poll until the job finishes. Returns null if it is still going when we give
   * up - a scan fans out into several composition loops and can legitimately
   * outlast a user's patience, and the work is not lost when we stop watching.
   */
  async function pollScan(jobId: string): Promise<ScanOutcome | null> {
    const deadline = Date.now() + 5 * 60_000;
    let delay = 1500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delay));
      // Back off gently so a slow scan does not mean 200 requests.
      delay = Math.min(delay * 1.4, 8000);
      let progress: { state: string; result: ScanOutcome | null; error: string | null };
      try {
        const res = await fetch(`/api/buyers-radar/scan?jobId=${encodeURIComponent(jobId)}`);
        if (!res.ok) continue;
        progress = await res.json();
      } catch {
        continue; // transient - keep polling until the deadline
      }
      if (progress.state === "done") return progress.result;
      if (progress.state === "failed") throw new Error(progress.error ?? "scan failed");
      // "queued" | "running" | "unknown" → keep waiting.
    }
    return null;
  }

  async function act(id: string, verdict: string) {
    setSignals((s) => s.filter((x) => x.id !== id));
    await fetch("/api/buyers-radar/verdict", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, verdict }),
    }).catch(() => {});
  }


  // Feature unavailable (no X data source configured) - fail closed, say so plainly.
  if (!status.enabled) {
    return (
      <div className={panel.page}>
        <div className={panel.inner}>
          <Head />
          <div className={styles.notice}>
            Buyer Radar needs an X data source connected before it can scan. This is a configuration step on the
            operator side; it will light up once that is in place.
          </div>
        </div>
      </div>
    );
  }

  // ICP setup / editing.
  if (editing || !hasIcp) {
    return (
      <div className={panel.page}>
        <div className={panel.inner}>
          <Head />
          <IcpForm
            icp={icp}
            prefill={prefill}
            onCancel={hasIcp ? () => setEditing(false) : undefined}
            onSaved={(view) => {
              setHasIcp(view.complete);
              if (view.complete) setEditing(false);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <Head />

        <div className={styles.controlRow}>
          <button className={styles.scanBtn} onClick={runScan} disabled={scanning}>
            <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.8} />
            {scanning ? "Scanning X…" : "Scan now"}
          </button>
          <span className={styles.quota}>
            {used}/{status.cap === null ? "∞" : status.cap} leads this month
          </span>
          <button className={styles.editBtn} onClick={() => setEditing(true)}>
            Edit targeting
          </button>
        </div>
        {locked && (
          <div style={{ marginTop: 12 }}>
            <UpgradeCTA message="Buyer Radar is a paid feature - or you've hit your monthly signal cap." />
          </div>
        )}
        {scanMsg && !scanning && <div className={styles.scanMsg}>{scanMsg}</div>}

        {/* A scan in flight NEVER hides the leads you already have. The radar
         *  animation used to replace the whole list, so every existing lead
         *  vanished the moment you hit "Scan now" and only came back when the job
         *  landed. It sits above the list instead, and new results merge in. */}
        {scanning && <ScanningRadar />}

        {!scanning && signals.length === 0 ? (
          <div className={styles.empty}>
            No leads yet. Run a scan and Yoinky will surface people on X who are asking for what you offer, with a read
            on what each one actually wants.
          </div>
        ) : (
          <div className={styles.list}>
            {signals.map((r) => (
              <div key={r.id} className={styles.card}>
                <div className={styles.cardTop}>
                  <span className={styles.avatar}>{r.initials}</span>
                  <div>
                    <div className={styles.handle}>@{r.handle}</div>
                    <div className={styles.time}>{relTime(r.postedAt)}</div>
                  </div>
                  <div className={styles.cardSpacer} />
                  <span className={styles.matchPill}>{r.match}% match</span>
                </div>
                {r.intentType && INTENT_LABEL[r.intentType] && (
                  <div className={styles.intentTag}>{INTENT_LABEL[r.intentType]}</div>
                )}
                <div className={styles.tweetText}>{r.content}</div>
                {r.why && (
                  <div className={styles.whyNote}>
                    <HugeiconsIcon icon={RadarIcon} size={13} strokeWidth={1.8} />
                    <span>{r.why.charAt(0).toUpperCase() + r.why.slice(1)}</span>
                  </div>
                )}
                <div className={styles.cardActions}>
                  {r.url && (
                    <a className={styles.actionBtn} href={r.url} target="_blank" rel="noreferrer">
                      Reply on X
                    </a>
                  )}
                  <button className={styles.actionBtn} onClick={() => act(r.id, "replied")}>
                    <HugeiconsIcon icon={Bookmark01Icon} size={13} strokeWidth={1.8} />
                    Mark replied
                  </button>
                  <div className={styles.cardSpacer} />
                  <button className={styles.ghostBtn} onClick={() => act(r.id, "skipped")}>
                    Skip
                  </button>
                  <button className={styles.ghostBtn} onClick={() => act(r.id, "not_a_fit")}>
                    Not a fit
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A scan is genuinely slow - a widening ladder of paced X searches, then an
 * embedding per candidate - so the wait is a minute or two. The captions track
 * the real pipeline stages at roughly the timings those stages take, so the wait
 * reads as work rather than a hang.
 */
const SCAN_STAGES = [
  { at: 0, label: "Working out the words your buyers use" },
  { at: 12, label: "Sweeping X for people saying them" },
  { at: 45, label: "Widening the net to fill six" },
  { at: 80, label: "Matching each one against what you sell" },
  { at: 110, label: "Reading what they actually asked for" },
];

function ScanningRadar() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const stage = [...SCAN_STAGES].reverse().find((s) => elapsed >= s.at) ?? SCAN_STAGES[0]!;

  return (
    <div className={styles.scanStage} role="status" aria-live="polite">
      <div className={styles.radar} aria-hidden="true">
        <span className={styles.ring} />
        <span className={styles.ring} />
        <span className={styles.ring} />
        <span className={styles.sweep} />
        <span className={styles.core} />
        <span className={`${styles.blip} ${styles.blip1}`} />
        <span className={`${styles.blip} ${styles.blip2}`} />
        <span className={`${styles.blip} ${styles.blip3}`} />
      </div>
      <div className={styles.scanStageLabel}>
        {stage.label}
        <span className={styles.dots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className={styles.scanStageHint}>
        This takes a minute or two - Yoinky keeps widening the search until it has six people worth your time.
      </div>
    </div>
  );
}

function Head() {
  return (
    <div className={panel.head}>
      <div>
        <div className={panel.title}>Buyers Radar</div>
        <div className={panel.subtitle}>
          People on X publicly asking for what you offer, with a read on what each one actually wants. Six a scan.
        </div>
      </div>
    </div>
  );
}

function IcpForm({
  icp,
  prefill,
  onSaved,
  onCancel,
}: {
  icp: IcpView | null;
  prefill: Prefill;
  onSaved: (view: IcpView) => void;
  onCancel?: () => void;
}) {
  const [product, setProduct] = useState(icp?.productOneliner || prefill.product_oneliner || "");
  const [buyer, setBuyer] = useState(icp?.buyerDescription || prefill.buyer_description || "");
  const [competitors, setCompetitors] = useState((icp?.competitorTerms ?? []).join(", "));
  const [exclusions, setExclusions] = useState((icp?.exclusions ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!product.trim() || !buyer.trim()) {
      setErr("Tell me what you sell and who buys it, at least.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/buyers-radar/icp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productOneliner: product.trim(),
          buyerDescription: buyer.trim(),
          competitorTerms: competitors,
          exclusions,
          painSignals: icp?.painSignals ?? prefill.pain_signals,
        }),
      });
      const view = (await res.json()) as IcpView;
      if (!res.ok) {
        setErr("could not save, try again");
        return;
      }
      onSaved(view);
    } catch {
      setErr("could not save, try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.form}>
      <div className={styles.formIntro}>
        Two quick things so Yoinky knows who to look for. You can edit these anytime.
      </div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>What do you sell?</span>
        <input
          className={styles.input}
          value={product}
          onChange={(e) => setProduct(e.target.value)}
          placeholder="e.g. landing page copywriting for B2B SaaS"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Who buys it?</span>
        <textarea
          className={styles.textarea}
          value={buyer}
          onChange={(e) => setBuyer(e.target.value)}
          rows={2}
          placeholder="e.g. early-stage SaaS founders shipping their first paid tier"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Competitors or tools they might switch from (optional)</span>
        <input
          className={styles.input}
          value={competitors}
          onChange={(e) => setCompetitors(e.target.value)}
          placeholder="comma separated"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Who is NOT your buyer (optional)</span>
        <input
          className={styles.input}
          value={exclusions}
          onChange={(e) => setExclusions(e.target.value)}
          placeholder="e.g. jobseekers, students, other copywriters"
        />
      </label>
      {err && <div className={styles.formErr}>{err}</div>}
      <div className={styles.formActions}>
        <button className={styles.scanBtn} onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save targeting"}
        </button>
        {onCancel && (
          <button className={styles.ghostBtn} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
