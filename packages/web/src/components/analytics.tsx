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
type FormatStat = {
  key: string;
  label: string;
  posts: number;
  medianEngagementRate: number | null;
  medianImpressions: number | null;
  liftPct: number | null;
};
type WeeklyPoint = { weeksAgo: number; posts: number; impressions: number };
type YoinkImpact = {
  assistedPosts: number;
  assistedImpressions: number;
  assistedMedianEngagementRate: number | null;
  baselineMedianEngagementRate: number | null;
  liftPct: number | null;
};
type AgentScorecard = { drafted: number; shipped: number; awaiting: number; rejected: number; avgEdits: number };
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
  formats: FormatStat[];
  weekly: WeeklyPoint[];
  impact: YoinkImpact;
  agent: AgentScorecard;
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
function signPct(r: number | null): string {
  if (r === null || r === undefined) return "–";
  return (r >= 0 ? "+" : "") + Math.round(r) + "%";
}
function liftColor(r: number | null): string | undefined {
  if (r === null || r === undefined) return undefined;
  return r >= 0 ? "var(--accent)" : "#d3455b";
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
  const maxWeekPosts = Math.max(1, ...data.weekly.map((w) => w.posts));

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

            {/* Yoinky's impact — the differentiated cut: posts shipped through
                Yoinky vs your own baseline. Ties X metrics to our own data. */}
            <div className={panel.section}>
              <div className={panel.sectionLabel}>Yoinky's impact — posts you shipped through Yoinky</div>
              {data.impact.assistedPosts === 0 ? (
                <div className={panel.sectionBody}>
                  Approve an Auto Agent draft or schedule from Compose, and we&apos;ll track how your
                  Yoinky-shipped posts perform against your own baseline — right here.
                </div>
              ) : (
                <>
                  <div className={styles.tiles}>
                    <div className={styles.tile}>
                      <div className={styles.tileLabel}>Yoinky-shipped posts</div>
                      <div className={styles.tileValue}>{data.impact.assistedPosts}</div>
                      <div className={styles.tileSub}>{fmt(data.impact.assistedImpressions)} impressions earned</div>
                    </div>
                    <div className={styles.tile}>
                      <div className={styles.tileLabel}>Assisted eng rate</div>
                      <div className={styles.tileValue}>{pct(data.impact.assistedMedianEngagementRate)}</div>
                      <div className={styles.tileSub}>median</div>
                    </div>
                    <div className={styles.tile}>
                      <div className={styles.tileLabel}>Your baseline</div>
                      <div className={styles.tileValue}>{pct(data.impact.baselineMedianEngagementRate)}</div>
                      <div className={styles.tileSub}>everything else</div>
                    </div>
                    <div className={styles.tile}>
                      <div className={styles.tileLabel}>Lift</div>
                      <div className={styles.tileValue} style={{ color: liftColor(data.impact.liftPct) }}>
                        {signPct(data.impact.liftPct)}
                      </div>
                      <div className={styles.tileSub}>vs your baseline</div>
                    </div>
                  </div>
                  {data.impact.liftPct !== null && (
                    <div className={styles.note}>
                      Posts you shipped through Yoinky run{" "}
                      <b style={{ color: liftColor(data.impact.liftPct) }}>{signPct(data.impact.liftPct)}</b> on engagement
                      rate versus everything else you post.
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Format lab — which shape of post earns you the most. */}
            <div className={panel.section}>
              <div className={panel.sectionLabel}>What shape of post works for you</div>
              {data.formats.length === 0 ? (
                <div className={panel.sectionBody}>Not enough posts yet to break down by format — keep posting and this fills in.</div>
              ) : (
                <div className={styles.formatList}>
                  {data.formats.map((f) => (
                    <div key={f.key} className={styles.formatRow}>
                      <div className={styles.formatLabel}>
                        {f.label}
                        <span className={styles.formatCount}>{f.posts} posts</span>
                      </div>
                      <div className={styles.formatMetrics}>
                        <span>
                          <b>{pct(f.medianEngagementRate)}</b> eng rate
                        </span>
                        {f.liftPct !== null && (
                          <span className={styles.formatLift} style={{ color: liftColor(f.liftPct) }}>
                            {signPct(f.liftPct)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className={styles.note}>
                The same posts sliced by shape, each against your own median engagement rate — the read native analytics
                never gives you.
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

            {/* Momentum — posting consistency over the last 8 weeks. */}
            <div className={panel.section}>
              <div className={panel.sectionLabel}>Posting momentum — last 8 weeks</div>
              <div className={styles.spark}>
                {data.weekly.map((w) => (
                  <div key={w.weeksAgo} className={styles.sparkCol} title={`${w.posts} posts, ${fmt(w.impressions)} impressions`}>
                    <div className={styles.sparkBarWrap}>
                      <div className={styles.sparkBar} style={{ height: `${Math.max(4, Math.round((w.posts / maxWeekPosts) * 100))}%` }} />
                    </div>
                    <div className={styles.sparkVal}>{w.posts}</div>
                    <div className={styles.sparkLabel}>{w.weeksAgo === 0 ? "now" : `${w.weeksAgo}w`}</div>
                  </div>
                ))}
              </div>
              <div className={styles.note}>Consistency compounds. Bars are posts per week; hover for impressions.</div>
            </div>
          </>
        )}

        {/* Auto Agent scorecard — operational, from automation_runs. Shown even
            without X metrics, since it's our own data, not X's. */}
        <div className={panel.section}>
          <div className={panel.sectionLabel}>Auto Agent scorecard</div>
          {data.agent.drafted === 0 ? (
            <div className={panel.sectionBody}>
              Your Auto Agent hasn&apos;t drafted anything yet. Set one up on the Auto Agent page and its output shows up here.
            </div>
          ) : (
            <div className={styles.tiles}>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Drafts written</div>
                <div className={styles.tileValue}>{data.agent.drafted}</div>
              </div>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Shipped / queued</div>
                <div className={styles.tileValue}>{data.agent.shipped}</div>
              </div>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Waiting on you</div>
                <div className={styles.tileValue}>{data.agent.awaiting}</div>
              </div>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Avg edits / draft</div>
                <div className={styles.tileValue}>{data.agent.avgEdits.toFixed(1)}</div>
                <div className={styles.tileSub}>lower = more on-voice</div>
              </div>
            </div>
          )}
        </div>

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
