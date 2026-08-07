"use client";

import { useState } from "react";
import panel from "./panel.module.css";
import styles from "./growth.module.css";

type Quest = {
  id: string;
  title: string;
  detail: string;
  xp: number;
  done: boolean;
  kind: "setup" | "habit" | "idea" | "reach";
  cta?: { label: string; href: string };
};
type Milestone = { key: string; label: string; icon: string; current: number; target: number; reached: boolean };
type ScorePart = { key: string; label: string; value: number; max: number; hint: string };
type Data = {
  hasDiagnosis: boolean;
  hasPlan: boolean;
  connected: boolean;
  headline: string | null;
  throughline: string | null;
  diagnosisDate: string | null;
  identity: { ownedPositions: string[]; unsaid: string[] };
  level: number;
  levelTitle: string;
  nextTitle: string | null;
  xp: number;
  xpIntoLevel: number;
  xpForNextLevel: number | null;
  brandScore: number;
  scoreParts: ScorePart[];
  streak: { current: number; best: number; postedThisWeek: boolean };
  stats: {
    postsShipped: number;
    postsLast4w: number;
    ideasDeveloped: number;
    ideasPending: number;
    agentDrafts: number;
    yoinkShipped: number;
    followers: number | null;
    automations: number;
  };
  quests: Quest[];
  milestones: Milestone[];
};

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function scoreLabel(s: number): string {
  if (s >= 85) return "Commanding";
  if (s >= 65) return "Strong";
  if (s >= 45) return "Building";
  if (s >= 25) return "Warming up";
  return "Just starting";
}

/**
 * The Growth board. Ordered by what earns a DAILY visit rather than by what's
 * biggest to render:
 *   1. urgency  - only when the streak is actually at risk (conditional, so it
 *                 never becomes permanent furniture)
 *   2. next move - the single highest-priority open quest + its CTA. One clear
 *                 thing to do is what brings someone back; three vanity numbers
 *                 competing for attention is what the old layout led with.
 *   3. momentum - level / score / streak as three compact equal tiles. The score
 *                 breakdown (4 sub-bars) is collapsed by default; expanded it was
 *                 the single densest thing on the page.
 *   4. queue    - the remaining quests, lighter than the promoted one.
 *   5. progress - milestones.
 *   6. identity - read-once reference (headline, throughline, territory), so last.
 */
export function Growth({ data }: { data: Data }) {
  const [showDone, setShowDone] = useState(false);
  const [showParts, setShowParts] = useState(false);
  const active = data.quests.filter((q) => !q.done);
  const done = data.quests.filter((q) => q.done);
  const queue = active;

  const xpPct = data.xpForNextLevel ? Math.round((data.xpIntoLevel / data.xpForNextLevel) * 100) : 100;
  const ring = `conic-gradient(var(--accent) ${xpPct * 3.6}deg, var(--stroke) 0deg)`;
  const streakAtRisk = data.streak.current > 0 && !data.streak.postedThisWeek;

  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <div className={panel.head}>
          <div>
            <div className={panel.title}>Growth</div>
            <div className={panel.subtitle}>One move at a time. Keep the streak alive.</div>
          </div>
        </div>

        {/* 1 ── urgency: only rendered when the streak is genuinely on the line */}
        {streakAtRisk && (
          <div className={styles.urgent}>
            <span className={styles.urgentFlame} aria-hidden="true">🔥</span>
            <span className={styles.urgentText}>
              Your {data.streak.current}-week streak is at risk - ship one post to keep it.
            </span>
            <a href="/app/studio" className={styles.urgentCta}>Studio</a>
          </div>
        )}

        {/* 3 ── momentum: three equal, compact tiles */}
        <div className={styles.metrics}>
          <div className={styles.tile}>
            <div className={styles.tileLabel}>Level</div>
            <div className={styles.levelRow}>
              <div className={styles.ring} style={{ background: ring }}>
                <div className={styles.ringInner}>
                  <span className={styles.ringLvl}>{data.level}</span>
                </div>
              </div>
              <div className={styles.levelText}>
                <div className={styles.levelTitle}>{data.levelTitle}</div>
                <div className={styles.levelSub}>
                  {data.xpForNextLevel
                    ? `${data.xpForNextLevel - data.xpIntoLevel} XP to ${data.nextTitle}`
                    : "Max level - legend"}
                </div>
              </div>
            </div>
            <div className={styles.bar}>
              <i style={{ width: `${xpPct}%` }} />
            </div>
          </div>

          <div className={styles.tile}>
            <div className={styles.tileLabel}>Brand score</div>
            <div className={styles.scoreRow}>
              <span className={styles.bigNum}>{data.brandScore}</span>
              <span className={styles.bigUnit}>/ 100</span>
              <span className={styles.scoreTag}>{scoreLabel(data.brandScore)}</span>
            </div>
            <div className={styles.bar}>
              <i style={{ width: `${data.brandScore}%` }} />
            </div>
            <button className={styles.linkBtn} onClick={() => setShowParts((v) => !v)}>
              {showParts ? "Hide breakdown" : "See what moves it"}
            </button>
            {showParts && (
              <div className={styles.parts}>
                {data.scoreParts.map((p) => (
                  <div key={p.key} className={styles.part} title={p.hint}>
                    <div className={styles.partTop}>
                      <span className={styles.partLabel}>{p.label}</span>
                      <span className={styles.partVal}>
                        {p.value}/{p.max}
                      </span>
                    </div>
                    <div className={styles.partBar}>
                      <i style={{ width: `${(p.value / p.max) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={styles.tile}>
            <div className={styles.tileLabel}>Posting streak</div>
            <div className={styles.scoreRow}>
              <span className={data.streak.current > 0 ? styles.flameLit : styles.flameDim} aria-hidden="true">🔥</span>
              <span className={styles.bigNum}>{data.streak.current}</span>
              <span className={styles.bigUnit}>{data.streak.current === 1 ? "week" : "weeks"}</span>
            </div>
            <div className={styles.tileFoot}>
              {data.streak.current === 0
                ? "Post this week to start one"
                : `Best run: ${data.streak.best} ${data.streak.best === 1 ? "week" : "weeks"}`}
            </div>
          </div>
        </div>

        {/* 4 ── the rest of the queue */}
        {(queue.length > 0 || done.length > 0) && (
          <section className={styles.section}>
            <div className={styles.sectionTitle}>
              <span>Up next</span>
              {queue.length > 0 && <span className={styles.sectionCount}>{queue.length} open</span>}
            </div>
            {queue.length > 0 && (
              <div className={styles.quests}>
                {queue.map((q) => (
                  <div key={q.id} className={styles.quest}>
                    <div className={styles.questCheck} aria-hidden="true" />
                    <div className={styles.questBody}>
                      <div className={styles.questTitle}>{q.title}</div>
                      {q.detail && <div className={styles.questDetail}>{q.detail}</div>}
                    </div>
                    <div className={styles.questRight}>
                      <span className={styles.xpChip}>+{q.xp} XP</span>
                      {q.cta && (
                        <a href={q.cta.href} className={styles.questCta}>
                          {q.cta.label}
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {done.length > 0 && (
              <>
                <button className={styles.linkBtn} onClick={() => setShowDone((v) => !v)}>
                  {showDone ? "Hide" : "Show"} {done.length} completed
                </button>
                {showDone && (
                  <div className={styles.quests} style={{ marginTop: 10 }}>
                    {done.map((q) => (
                      <div key={q.id} className={`${styles.quest} ${styles.questDone}`}>
                        <div className={styles.questCheckDone} aria-hidden="true">✓</div>
                        <div className={styles.questBody}>
                          <div className={styles.questTitle}>{q.title}</div>
                        </div>
                        <span className={styles.xpChipDone}>+{q.xp} XP</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {/* 5 ── milestones */}
        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            <span>Milestones</span>
          </div>
          <div className={styles.milestones}>
            {data.milestones.map((m) => {
              const pct = Math.min(100, Math.round((m.current / m.target) * 100));
              return (
                <div key={m.key} className={`${styles.milestone} ${m.reached ? styles.msReached : ""}`}>
                  <div className={styles.msLabel}>{m.label}</div>
                  <div className={styles.msValue}>
                    {fmt(m.current)} <span className={styles.msTarget}>/ {fmt(m.target)}</span>
                  </div>
                  <div className={styles.msBar}>
                    <i style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 6 ── who you are: reference, so it sits last */}
        {data.hasDiagnosis ? (
          <section className={styles.section}>
            <div className={styles.sectionTitle}>
              <span>Who you are</span>
              {data.diagnosisDate && (
                <span className={styles.sectionCount}>
                  read {new Date(data.diagnosisDate).toISOString().slice(0, 10)}
                </span>
              )}
            </div>
            {data.headline && <p className={styles.headline}>{data.headline}</p>}
            {data.throughline && (
              <div className={styles.throughlineBox}>
                <div className={styles.tlLabel}>Your throughline</div>
                <div className={styles.tlText}>{data.throughline}</div>
              </div>
            )}
            {data.identity.unsaid.length > 0 && (
              <div>
                <div className={styles.idColLabel}>💎 Your highest-value territory</div>
                <ul className={styles.idList}>
                  {data.identity.unsaid.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ) : (
          <section className={styles.section}>
            <div className={styles.lockedRead}>
              <div className={styles.lockedTitle}>🔒 Your brand read is locked</div>
              <p>
                Clear the setup quests above - connect X, finish your profile, get your diagnosis - and your identity,
                throughline, and highest-value territory unlock right here.
              </p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
