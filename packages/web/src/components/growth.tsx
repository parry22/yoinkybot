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

export function Growth({ data }: { data: Data }) {
  const [showDone, setShowDone] = useState(false);
  const active = data.quests.filter((q) => !q.done);
  const done = data.quests.filter((q) => q.done);

  const xpPct = data.xpForNextLevel ? Math.round((data.xpIntoLevel / data.xpForNextLevel) * 100) : 100;
  // conic ring for the level badge
  const ring = `conic-gradient(var(--accent) ${xpPct * 3.6}deg, var(--stroke) 0deg)`;

  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <div className={panel.head}>
          <div>
            <div className={panel.title}>Growth</div>
            <div className={panel.subtitle}>Clear the quests. Keep the streak.</div>
          </div>
        </div>

        {/* ── hero: level · score · streak ── */}
        <div className={styles.hero}>
          <div className={styles.card}>
            <div className={styles.levelRow}>
              <div className={styles.ring} style={{ background: ring }}>
                <div className={styles.ringInner}>
                  <span className={styles.ringLvl}>{data.level}</span>
                  <span className={styles.ringCap}>LVL</span>
                </div>
              </div>
              <div className={styles.levelText}>
                <div className={styles.levelTitle}>{data.levelTitle}</div>
                <div className={styles.levelSub}>
                  {data.xpForNextLevel
                    ? `${data.xpForNextLevel - data.xpIntoLevel} XP to ${data.nextTitle}`
                    : "Max level — legend"}
                </div>
                <div className={styles.xpBar}>
                  <i style={{ width: `${xpPct}%` }} />
                </div>
              </div>
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardLabel}>Brand Score</div>
            <div className={styles.scoreRow}>
              <div className={styles.scoreBig}>{data.brandScore}</div>
              <div className={styles.scoreOutOf}>
                / 100
                <div className={styles.scoreTag}>{scoreLabel(data.brandScore)}</div>
              </div>
            </div>
            <div className={styles.parts}>
              {data.scoreParts.map((p) => (
                <div key={p.key} className={styles.part} title={p.hint}>
                  <div className={styles.partTop}>
                    <span>{p.label}</span>
                    <span className={styles.partVal}>{p.value}/{p.max}</span>
                  </div>
                  <div className={styles.partBar}>
                    <i style={{ width: `${(p.value / p.max) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={`${styles.card} ${styles.streakCard}`}>
            <div className={styles.cardLabel}>Posting streak</div>
            <div className={styles.streakBig}>
              <span className={data.streak.current > 0 ? styles.flameLit : styles.flameDim}>🔥</span>
              <span className={styles.streakNum}>{data.streak.current}</span>
              <span className={styles.streakUnit}>{data.streak.current === 1 ? "week" : "weeks"}</span>
            </div>
            {data.streak.current > 0 && !data.streak.postedThisWeek ? (
              <div className={styles.streakWarn}>At risk — post this week to keep it</div>
            ) : data.streak.current === 0 ? (
              <div className={styles.streakSub}>Post this week to start a streak</div>
            ) : (
              <div className={styles.streakSub}>Best: {data.streak.best} weeks</div>
            )}
          </div>
        </div>

        {/* ── quests ── */}
        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            Your quests
            <span className={styles.sectionCount}>{active.length} open</span>
          </div>
          {active.length === 0 ? (
            <div className={styles.allClear}>🎉 All quests cleared. Fresh ones land as your plan grows.</div>
          ) : (
            <div className={styles.quests}>
              {active.map((q) => (
                <div key={q.id} className={styles.quest}>
                  <div className={styles.questCheck} aria-hidden="true" />
                  <div className={styles.questBody}>
                    <div className={styles.questTitle}>{q.title}</div>
                    <div className={styles.questDetail}>{q.detail}</div>
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
              <button className={styles.doneToggle} onClick={() => setShowDone((v) => !v)}>
                {showDone ? "Hide" : "Show"} {done.length} completed
              </button>
              {showDone && (
                <div className={styles.quests}>
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

        {/* ── milestones ── */}
        <section className={styles.section}>
          <div className={styles.sectionTitle}>Milestones</div>
          <div className={styles.milestones}>
            {data.milestones.map((m) => {
              const pctToTarget = Math.min(100, Math.round((m.current / m.target) * 100));
              return (
                <div key={m.key} className={styles.milestone}>
                  <div className={styles.msTop}>
                    <span className={styles.msLabel}>{m.label}</span>
                  </div>
                  <div className={styles.msValue}>
                    {fmt(m.current)} <span className={styles.msTarget}>/ {fmt(m.target)}</span>
                  </div>
                  <div className={styles.msBar}>
                    <i style={{ width: `${pctToTarget}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── who you are (diagnosis + throughline) ── */}
        {data.hasDiagnosis ? (
          <section className={styles.section}>
            <div className={styles.sectionTitle}>
              Who you are
              {data.diagnosisDate && (
                <span className={styles.sectionCount}>read {new Date(data.diagnosisDate).toISOString().slice(0, 10)}</span>
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
              <p>Clear the setup quests above — connect X, finish your profile, get your diagnosis — and your identity, throughline, and highest-value territory unlock right here.</p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
