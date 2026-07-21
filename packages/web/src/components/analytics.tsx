"use client";

import { useState } from "react";
import panel from "./panel.module.css";
import styles from "./analytics.module.css";

type Post = {
  url: string | null;
  text: string;
  impressions: number;
  likes: number;
  replies: number;
  retweets: number;
  bookmarks: number;
  engagements: number;
  engagementRate: number | null;
};
type HeatCell = { day: number; hour: number; posts: number; impressions: number; engagements: number };
type Data = {
  connected: boolean;
  handle: string | null;
  followers: number | null;
  timezone: string;
  postsAnalyzed: number;
  hasMetrics: boolean;
  medians: { impressions: number | null; engagements: number | null; engagementRate: number | null };
  topPosts: Post[];
  heatmap: HeatCell[];
  bestWindow: { day: number; hour: number } | null;
  unavailable: string[];
};
type Replies = {
  available: boolean;
  reason?: string;
  count: number;
  medianImpressions: number | null;
  medianEngagementRate: number | null;
  sample: Post[];
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmt(n: number | null): string {
  if (n === null || n === undefined) return "-";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}
function pct(r: number | null): string {
  return r === null || r === undefined ? "-" : (r * 100).toFixed(1) + "%";
}

export function Analytics({ data }: { data: Data }) {
  const [replies, setReplies] = useState<Replies | null>(null);
  const [loadingReplies, setLoadingReplies] = useState(false);

  async function loadReplies() {
    setLoadingReplies(true);
    try {
      const res = await fetch("/api/analytics/replies");
      setReplies(await res.json());
    } catch {
      setReplies({ available: false, reason: "network error", count: 0, medianImpressions: null, medianEngagementRate: null, sample: [] });
    } finally {
      setLoadingReplies(false);
    }
  }

  if (!data.connected) {
    return (
      <div className={panel.page}>
        <div className={panel.inner}>
          <div className={panel.head}>
            <div>
              <div className={panel.title}>Analytics</div>
              <div className={panel.subtitle}>Your X performance, beyond what native analytics shows.</div>
            </div>
          </div>
          <div className={panel.empty}>
            <div className={panel.emptyTitle}>Connect your X account first.</div>
            <p>Add it in Settings - Yoinky reads your posts and their metrics.</p>
          </div>
        </div>
      </div>
    );
  }

  const maxEng = Math.max(1, ...data.heatmap.map((c) => c.engagements));

  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <div className={panel.head}>
          <div>
            <div className={panel.title}>Analytics</div>
            <div className={panel.subtitle}>
              {data.handle} · {data.postsAnalyzed} posts analyzed · times in {data.timezone}
            </div>
          </div>
        </div>

        {!data.hasMetrics ? (
          <div className={panel.empty}>
            <div className={panel.emptyTitle}>No post metrics yet.</div>
            <p>Impression/engagement data comes from the twitterapi.io-backed connect. Reconnect your X handle to pull it in.</p>
          </div>
        ) : (
          <>
            <div className={styles.tiles}>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Followers</div>
                <div className={styles.tileValue}>{fmt(data.followers)}</div>
                <div className={styles.tileSub}>at last sync</div>
              </div>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Median impressions</div>
                <div className={styles.tileValue}>{fmt(data.medians.impressions)}</div>
                <div className={styles.tileSub}>per post</div>
              </div>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Median engagement</div>
                <div className={styles.tileValue}>{fmt(data.medians.engagements)}</div>
                <div className={styles.tileSub}>likes + replies + RT + quotes + bookmarks</div>
              </div>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Median engagement rate</div>
                <div className={styles.tileValue}>{pct(data.medians.engagementRate)}</div>
                <div className={styles.tileSub}>engagements ÷ impressions</div>
              </div>
            </div>

            <div className={panel.section}>
              <div className={panel.sectionLabel}>Best time to post - engagement-weighted</div>
              <div className={styles.heatWrap}>
                <table className={styles.heat}>
                  <tbody>
                    <tr>
                      <td />
                      {Array.from({ length: 24 }, (_, h) => (
                        <td key={h} className={styles.heatHourLabel}>
                          {h % 6 === 0 ? h : ""}
                        </td>
                      ))}
                    </tr>
                    {DOW.map((label, day) => (
                      <tr key={day}>
                        <td className={styles.heatDay}>{label}</td>
                        {Array.from({ length: 24 }, (_, hour) => {
                          const cell = data.heatmap.find((c) => c.day === day && c.hour === hour);
                          const intensity = cell ? cell.engagements / maxEng : 0;
                          const isBest = data.bestWindow?.day === day && data.bestWindow?.hour === hour;
                          return (
                            <td key={hour}>
                              <div
                                className={`${styles.cell} ${isBest ? styles.cellBest : ""}`}
                                style={intensity > 0 ? { background: `rgba(236, 72, 153, ${0.15 + intensity * 0.85})` } : undefined}
                                title={cell ? `${DOW[day]} ${hour}:00 - ${cell.posts} posts, ${fmt(cell.engagements)} engagements` : ""}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.bestWindow && (
                <div className={styles.note}>
                  Your strongest slot so far: <b style={{ color: "var(--accent)" }}>{DOW[data.bestWindow.day]} around {data.bestWindow.hour}:00</b>, weighted by
                  the engagement your posts actually earned there (not just when you happened to post).
                </div>
              )}
            </div>

            <div className={panel.section}>
              <div className={panel.sectionLabel}>Top posts by impressions</div>
              {data.topPosts.map((p, i) => (
                <div key={i} className={styles.postRow}>
                  <div className={styles.postText}>
                    {p.text}
                    <div className={styles.postMetrics}>
                      <span><b>{fmt(p.impressions)}</b> impressions</span>
                      <span><b>{pct(p.engagementRate)}</b> eng rate</span>
                      <span><b>{fmt(p.likes)}</b> likes</span>
                      <span><b>{fmt(p.bookmarks)}</b> bookmarks</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Reply-level performance - the native-analytics blind spot. On-demand (live pull). */}
        <div className={panel.section}>
          <div className={panel.sectionLabel}>Reply-level performance</div>
          {!replies ? (
            <>
              <div className={panel.sectionBody} style={{ marginBottom: 10 }}>
                Native analytics ignore your replies. Yoinky pulls impressions + engagement rate on the replies you
                send - the data reply-driven growth usually flies blind on.
              </div>
              <button className="btnGhost" onClick={loadReplies} disabled={loadingReplies}>
                {loadingReplies ? "Pulling replies…" : "Load reply performance"}
              </button>
            </>
          ) : !replies.available ? (
            <div className={panel.sectionBody}>{replies.reason ?? "Not available."}</div>
          ) : replies.count === 0 ? (
            <div className={panel.sectionBody}>No recent replies found in your latest timeline pull.</div>
          ) : (
            <>
              <div className={styles.tiles}>
                <div className={styles.tile}>
                  <div className={styles.tileLabel}>Replies analyzed</div>
                  <div className={styles.tileValue}>{replies.count}</div>
                </div>
                <div className={styles.tile}>
                  <div className={styles.tileLabel}>Median impressions</div>
                  <div className={styles.tileValue}>{fmt(replies.medianImpressions)}</div>
                </div>
                <div className={styles.tile}>
                  <div className={styles.tileLabel}>Median engagement rate</div>
                  <div className={styles.tileValue}>{pct(replies.medianEngagementRate)}</div>
                </div>
              </div>
              {replies.sample.map((p, i) => (
                <div key={i} className={styles.postRow}>
                  <div className={styles.postText}>
                    {p.text}
                    <div className={styles.postMetrics}>
                      <span><b>{fmt(p.impressions)}</b> impressions</span>
                      <span><b>{pct(p.engagementRate)}</b> eng rate</span>
                      <span><b>{fmt(p.likes)}</b> likes</span>
                    </div>
                  </div>
                </div>
              ))}
              <div className={styles.note}>Profile clicks on replies aren&apos;t exposed by X - see below.</div>
            </>
          )}
        </div>

        <div className={panel.section}>
          <div className={panel.sectionLabel}>Not shown - and why</div>
          <ul className={styles.unavail}>
            {data.unavailable.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
