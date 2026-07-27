"use client";

import { Fragment, useState } from "react";
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

  const maxWeekPosts = Math.max(1, ...data.weekly.map((w) => w.posts));

  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <div className={panel.head}>
          <div>
            <div className={panel.title}>Analytics</div>
            <div className={panel.subtitle}>{data.handle}</div>
          </div>
        </div>

        {!data.hasMetrics ? (
          <div className={panel.empty}>
            <div className={panel.emptyTitle}>No post metrics yet.</div>
            <p>Reconnect your X in Settings to pull in fresh numbers.</p>
          </div>
        ) : (
          <>
            <div className={styles.tiles}>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Followers</div>
                <div className={styles.tileValue}>{fmt(data.followers)}</div>
              </div>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Median impressions</div>
                <div className={styles.tileValue}>{fmt(data.medians.impressions)}</div>
                <div className={styles.tileSub}>per post</div>
              </div>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Median engagement</div>
                <div className={styles.tileValue}>{fmt(data.medians.engagements)}</div>
                <div className={styles.tileSub}>per post</div>
              </div>
              <div className={styles.tile}>
                <div className={styles.tileLabel}>Engagement rate</div>
                <div className={styles.tileValue}>{pct(data.medians.engagementRate)}</div>
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
                <div className={panel.sectionBody}>Keep posting — this fills in as your history grows.</div>
              ) : (
                <div className={styles.formatList}>
                  {data.formats.map((f) => (
                    <div key={f.key} className={styles.formatRow}>
                      <div className={styles.formatLabel}>{f.label}</div>
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
            </div>

            <TimingSection heatmap={data.heatmap} bestWindow={data.bestWindow} timezone={data.timezone} />

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
              <div className={styles.note}>Posts per week.</div>
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
              </div>
            </div>
          )}
        </div>

        {/* Reply-level performance - on-demand (live pull). */}
        <div className={panel.section}>
          <div className={panel.sectionLabel}>Reply-level performance</div>
          {!replies ? (
            <>
              <div className={panel.sectionBody} style={{ marginBottom: 10 }}>
                See how the replies you send actually perform.
              </div>
              <button className="btnGhost" onClick={loadReplies} disabled={loadingReplies}>
                {loadingReplies ? "Pulling replies…" : "Load reply performance"}
              </button>
            </>
          ) : !replies.available ? (
            <div className={panel.sectionBody}>Couldn&apos;t pull replies right now — try again in a bit.</div>
          ) : replies.count === 0 ? (
            <div className={panel.sectionBody}>No recent replies found.</div>
          ) : (
            <>
              <div className={styles.tiles}>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const DAYPARTS: { key: string; label: string; hours: [number, number] }[] = [
  { key: "night", label: "Late night", hours: [0, 5] },
  { key: "morning", label: "Morning", hours: [6, 11] },
  { key: "afternoon", label: "Afternoon", hours: [12, 17] },
  { key: "evening", label: "Evening", hours: [18, 23] },
];

function hourLabel(h: number): string {
  const suffix = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${suffix}`;
}

/**
 * "Best time to post", rebuilt.
 *
 * TWO THINGS WERE WRONG WITH THE OLD ONE.
 *
 * 1) It was a <table> of fixed 15px cells, so on a wide container the grid
 *    occupied the left third and the rest of the card was empty. It's now a CSS
 *    grid (`auto repeat(24, 1fr)`) — the cells stretch to fill whatever width
 *    they're given, which is what a 24×7 matrix should do.
 *
 * 2) Far more importantly, it shaded each cell by TOTAL engagement. One post
 *    that happened to go viral made its cell solid and pushed every other cell
 *    to near-invisible, so the chart said "you went viral once at 7am on a
 *    Saturday" while claiming to say "post at 7am on Saturdays". Shading is now
 *    engagement PER POST, which is the quantity the recommendation is actually
 *    about, and cells backed by a single post are drawn hollow so a one-off
 *    can't read as a pattern.
 *
 * The numbers underneath are new: the old version rendered one sentence naming
 * a slot, with the evidence for it hidden in a hover title that never appears
 * on touch.
 */
function TimingSection({
  heatmap,
  bestWindow,
  timezone,
}: {
  heatmap: HeatCell[];
  bestWindow: { day: number; hour: number } | null;
  timezone: string;
}) {
  const byKey = new Map(heatmap.map((c) => [`${c.day}:${c.hour}`, c]));
  const perPost = (c: HeatCell) => (c.posts > 0 ? c.engagements / c.posts : 0);

  // Scale against the best *repeated* slot where one exists, so a single lucky
  // post doesn't compress the entire rest of the grid into one flat shade.
  const repeated = heatmap.filter((c) => c.posts >= 2);
  const maxPerPost = Math.max(1, ...(repeated.length ? repeated : heatmap).map(perPost));

  // Top slots, evidence-first: ≥2 posts required, so this can't recommend a slot
  // you have posted in exactly once.
  const topSlots = [...repeated].sort((a, b) => perPost(b) - perPost(a)).slice(0, 3);

  const dayparts = DAYPARTS.map((d) => {
    const cells = heatmap.filter((c) => c.hour >= d.hours[0] && c.hour <= d.hours[1]);
    const posts = cells.reduce((a, c) => a + c.posts, 0);
    const engagements = cells.reduce((a, c) => a + c.engagements, 0);
    return { ...d, posts, engagements, perPost: posts > 0 ? engagements / posts : 0 };
  });
  const maxDaypart = Math.max(1, ...dayparts.map((d) => d.perPost));
  const totalPosts = heatmap.reduce((a, c) => a + c.posts, 0);

  return (
    <div className={panel.section}>
      <div className={panel.sectionLabel}>When your posts land — engagement per post</div>

      <div className={styles.heatGrid}>
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={`h-${h}`} className={styles.heatHourLabel}>
            {h % 3 === 0 ? hourLabel(h) : ""}
          </div>
        ))}
        {DOW.map((label, day) => (
          <Fragment key={label}>
            <div className={styles.heatDay}>{label}</div>
            {Array.from({ length: 24 }, (_, hour) => {
              const cell = byKey.get(`${day}:${hour}`);
              // getAnalytics falls back to `ranked[0]` when no slot has 2+ posts,
              // so bestWindow can point at a single post. Don't decorate it as
              // "your best time" in that case — the copy below already says there
              // isn't a pattern yet, and the outline would contradict it.
              const isBest = bestWindow?.day === day && bestWindow?.hour === hour && (cell?.posts ?? 0) >= 2;
              // Hollow = posted here, but only once. Present, not persuasive.
              const thin = !!cell && cell.posts < 2;
              const intensity = cell ? Math.min(1, perPost(cell) / maxPerPost) : 0;
              return (
                <div
                  key={`${day}-${hour}`}
                  className={`${styles.cell} ${isBest ? styles.cellBest : ""} ${thin ? styles.cellThin : ""}`}
                  style={
                    cell && !thin
                      ? { background: `rgba(236, 72, 153, ${0.12 + intensity * 0.88})` }
                      : undefined
                  }
                  title={
                    cell
                      ? `${label} ${hourLabel(hour)} — ${cell.posts} post${cell.posts === 1 ? "" : "s"}, ` +
                        `${fmt(Math.round(perPost(cell)))} engagements per post, ${fmt(cell.impressions)} impressions`
                      : `${label} ${hourLabel(hour)} — never posted`
                  }
                />
              );
            })}
          </Fragment>
        ))}
      </div>

      <div className={styles.heatLegend}>
        <span>Times shown in {timezone}</span>
        <span className={styles.legendScale}>
          less
          <i style={{ background: "rgba(236, 72, 153, 0.18)" }} />
          <i style={{ background: "rgba(236, 72, 153, 0.45)" }} />
          <i style={{ background: "rgba(236, 72, 153, 0.72)" }} />
          <i style={{ background: "rgba(236, 72, 153, 1)" }} />
          more
        </span>
        <span className={styles.legendThin}>
          <i /> posted once — not enough to call a pattern
        </span>
      </div>

      {topSlots.length > 0 ? (
        <div className={styles.slotList}>
          {topSlots.map((c, i) => (
            <div key={`${c.day}-${c.hour}`} className={styles.slotRow}>
              <span className={styles.slotRank}>{i + 1}</span>
              <span className={styles.slotWhen}>
                {DOW[c.day]} {hourLabel(c.hour)}
              </span>
              <span className={styles.slotMetric}>
                <b>{fmt(Math.round(perPost(c)))}</b> engagements / post
              </span>
              <span className={styles.slotEvidence}>
                {fmt(Math.round(c.impressions / c.posts))} impressions / post · {c.posts} posts
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.note}>
          You haven&apos;t posted in the same slot twice yet, so there&apos;s no timing pattern to read. The grid below
          still shows where your posts have landed.
        </div>
      )}

      {/* Coarser cut — with a thin history the 24×7 grid is mostly empty, but
          four dayparts usually have enough posts in them to say something. */}
      {totalPosts > 0 && (
        <div className={styles.daypartList}>
          {dayparts.map((d) => (
            <div key={d.key} className={styles.daypartRow}>
              <span className={styles.daypartLabel}>{d.label}</span>
              <span className={styles.daypartBarWrap}>
                <span
                  className={styles.daypartBar}
                  style={{ width: `${Math.max(2, Math.round((d.perPost / maxDaypart) * 100))}%` }}
                />
              </span>
              <span className={styles.daypartValue}>
                {d.posts === 0 ? "no posts" : `${fmt(Math.round(d.perPost))} / post`}
              </span>
              <span className={styles.daypartCount}>
                {d.posts === 0 ? "" : `${Math.round((d.posts / totalPosts) * 100)}% of your posts`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
