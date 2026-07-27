"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { FlashIcon, FireIcon } from "@hugeicons/core-free-icons";
import panel from "./panel.module.css";
import { UpgradeCTA } from "./upgrade-cta";
import styles from "./inspiration.module.css";

type Trend = {
  id: string;
  deliveredAt: string;
  topic: string;
  summary: string;
  angle: string;
  sourceUrl: string | null;
  sourceNote: string | null;
  buzz: number | null;
  reaction: string | null;
};
type Viral = {
  id: string;
  deliveredAt: string;
  author: string;
  viewCount: number;
  breakoutRatio: number | null;
  sourceUrl: string | null;
  sourceNote: string | null;
  reaction: string | null;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtViews(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}
const REACTION_ICON: Record<string, string> = { fire: "🔥", useful: "👍", off: "👎", later: "🕐", forget: "🗑" };

/** What the on-demand fill did, which is what an empty feed actually means. */
type FillState = "idle" | "filling" | "paywalled" | "failed";

export function Inspiration({ trends, virals }: { trends: Trend[]; virals: Viral[] }) {
  const [tab, setTab] = useState<"trends" | "virals">("trends");
  const [fill, setFill] = useState<FillState>("idle");
  const router = useRouter();
  const triedFill = useRef(false);

  // Empty feed → kick off an on-demand fill (server-side stale guard makes this
  // safe to fire on every visit), then re-render the server lists.
  useEffect(() => {
    if (triedFill.current || trends.length + virals.length > 0) return;
    triedFill.current = true;
    setFill("filling");
    fetch("/api/inspiration/refresh", { method: "POST" })
      .then((res) => {
        // A rejected fetch is a network failure — a 402 or a 500 RESOLVES. The
        // old `.then(() => router.refresh()).catch(() => {})` therefore swallowed
        // the paywall whole: a free user was told "Nothing here yet. Check back
        // soon." forever, with nothing on screen suggesting an upgrade was the
        // missing piece rather than time.
        if (res.status === 402) return setFill("paywalled");
        if (!res.ok) return setFill("failed");
        setFill("idle");
        router.refresh();
      })
      .catch(() => setFill("failed"));
  }, [trends.length, virals.length, router]);

  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <div className={panel.head}>
          <div>
            <div className={panel.title}>Inspiration</div>
            <div className={panel.subtitle}>What&apos;s moving in your niche, and what just went viral.</div>
          </div>
        </div>

        <div className={styles.tabs}>
          <button className={`${styles.tab} ${tab === "trends" ? styles.tabActive : ""}`} onClick={() => setTab("trends")}>
            <HugeiconsIcon icon={FlashIcon} size={14} strokeWidth={1.8} />
            Trends ({trends.length})
          </button>
          <button className={`${styles.tab} ${tab === "virals" ? styles.tabActive : ""}`} onClick={() => setTab("virals")}>
            <HugeiconsIcon icon={FireIcon} size={14} strokeWidth={1.8} />
            Virals ({virals.length})
          </button>
        </div>

        {tab === "trends" &&
          (trends.length === 0 ? (
            <EmptyFeed
              state={fill}
              scanning="Finding what's moving on X for you right now. This takes a moment."
              idle="Fresh trends land here as they break in your niche. Check back soon."
              locked="Live trends from your niche, with an angle you can actually post, land here daily."
            />
          ) : (
            trends.map((t) => (
              <div key={t.id} className={styles.card}>
                <div className={styles.cardTop}>
                  <span className={styles.cardTopic}>{t.topic}</span>
                  <span className={styles.cardMeta}>
                    {t.buzz !== null && <span className="pill pillAccent">buzz {t.buzz.toFixed(2)}</span>}
                    {t.reaction && <span className={styles.reaction}>{REACTION_ICON[t.reaction] ?? t.reaction}</span>}
                    <span>{fmtDate(t.deliveredAt)}</span>
                  </span>
                </div>
                {t.summary && <div className={styles.cardBody}>{t.summary}</div>}
                {t.angle && (
                  <div className={styles.cardBody} style={{ marginTop: t.summary ? 8 : 0 }}>
                    💡 {t.angle}
                  </div>
                )}
                {(t.sourceNote || t.sourceUrl) && (
                  <div className={styles.cardSource}>
                    {t.sourceNote}
                    {t.sourceUrl && (
                      <>
                        {" "}
                        <a className={styles.cardLink} href={t.sourceUrl} target="_blank" rel="noopener noreferrer">
                          view post →
                        </a>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))
          ))}

        {tab === "virals" &&
          (virals.length === 0 ? (
            <EmptyFeed
              state={fill}
              scanning="Pulling the posts blowing up in your lane right now."
              idle="Daily spotlights on posts that broke out in your niche land here, with an angle for you."
              locked="The posts breaking out in your lane, with the angle that made them work, land here daily."
            />
          ) : (
            virals.map((v) => (
              <div key={v.id} className={styles.card}>
                <div className={styles.cardTop}>
                  <span className={styles.cardTopic}>@{v.author}</span>
                  <span className={styles.cardMeta}>
                    <span className="pill pillAccent">{fmtViews(v.viewCount)} views</span>
                    {v.breakoutRatio !== null && <span className="pill">{v.breakoutRatio}x following</span>}
                    {v.reaction && <span className={styles.reaction}>{REACTION_ICON[v.reaction] ?? v.reaction}</span>}
                    <span>{fmtDate(v.deliveredAt)}</span>
                  </span>
                </div>
                {(v.sourceNote || v.sourceUrl) && (
                  <div className={styles.cardSource}>
                    {v.sourceNote}
                    {v.sourceUrl && (
                      <>
                        {" "}
                        <a className={styles.cardLink} href={v.sourceUrl} target="_blank" rel="noopener noreferrer">
                          view post →
                        </a>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))
          ))}
      </div>
    </div>
  );
}

/**
 * An empty feed has four different meanings and used to have one message. The
 * paywalled case is the important one: the feed is empty because the fill was
 * refused, not because nothing has happened yet, so it says so and offers the
 * upgrade instead of asking the user to keep checking back on a feed that will
 * never fill.
 */
function EmptyFeed({
  state,
  scanning,
  idle,
  locked,
}: {
  state: FillState;
  scanning: string;
  idle: string;
  locked: string;
}) {
  if (state === "paywalled") {
    return (
      <div className={panel.empty}>
        <div className={panel.emptyTitle}>Inspiration is a paid feature.</div>
        <p style={{ marginBottom: 18 }}>{locked}</p>
        <UpgradeCTA message="Upgrade and Yoinky starts scanning your niche for you." plan="growth" />
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className={panel.empty}>
        <div className={panel.emptyTitle}>Couldn&apos;t scan your niche just now.</div>
        <p>Something went wrong reaching X. Reload the page in a minute and Yoinky will try again.</p>
      </div>
    );
  }
  return (
    <div className={panel.empty}>
      <div className={panel.emptyTitle}>{state === "filling" ? "Scanning your niche…" : "Nothing here yet."}</div>
      <p>{state === "filling" ? scanning : idle}</p>
    </div>
  );
}
