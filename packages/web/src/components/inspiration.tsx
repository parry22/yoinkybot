"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { FlashIcon, FireIcon } from "@hugeicons/core-free-icons";
import panel from "./panel.module.css";
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

export function Inspiration({ trends, virals }: { trends: Trend[]; virals: Viral[] }) {
  const [tab, setTab] = useState<"trends" | "virals">("trends");

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
            <div className={panel.empty}>
              <div className={panel.emptyTitle}>No trend takes yet.</div>
              <p>Once you&apos;re connected and diagnosed, Yoinky matches live X trends against your stated positions.</p>
            </div>
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
            <div className={panel.empty}>
              <div className={panel.emptyTitle}>No viral case studies yet.</div>
              <p>A daily spotlight on a high-impression tweet in your niche, with why it worked and an angle for you.</p>
            </div>
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
