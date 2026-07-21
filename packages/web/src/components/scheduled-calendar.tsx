"use client";

import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon, Add01Icon } from "@hugeicons/core-free-icons";
import panel from "./panel.module.css";
import styles from "./scheduled-calendar.module.css";

interface Post {
  id: string;
  platform: string;
  content: string;
  scheduledFor: string; // ISO
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function ScheduledCalendar({ posts: initial }: { posts: Post[] }) {
  const [posts, setPosts] = useState<Post[]>(initial);
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [modalDay, setModalDay] = useState<Date | null>(null);

  // Bucket posts by local calendar day.
  const byDay = useMemo(() => {
    const m = new Map<string, Post[]>();
    for (const p of posts) {
      const d = new Date(p.scheduledFor);
      if (Number.isNaN(d.getTime())) continue;
      const k = dayKey(d);
      (m.get(k) ?? m.set(k, []).get(k)!).push(p);
    }
    for (const list of m.values()) list.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    return m;
  }, [posts]);

  // Build the month grid: leading blanks + each day, padded to full weeks.
  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < startPad; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(new Date(year, month, d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [year, month]);

  const isToday = (d: Date) => dayKey(d) === dayKey(now);
  const isPast = (d: Date) => {
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
    return end.getTime() < Date.now();
  };

  const shift = (delta: number) => {
    const m = month + delta;
    setYear(year + Math.floor(m / 12));
    setMonth(((m % 12) + 12) % 12);
  };

  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <div className={panel.head}>
          <div>
            <div className={panel.title}>Scheduled</div>
            <div className={panel.subtitle}>Your posting calendar. Tap any day to queue a post.</div>
          </div>
        </div>

        <div className={styles.toolbar}>
          <button className={styles.navBtn} onClick={() => shift(-1)} aria-label="Previous month">
            <HugeiconsIcon icon={ArrowLeft01Icon} size={18} strokeWidth={1.8} />
          </button>
          <div className={styles.monthLabel}>
            {MONTHS[month]} {year}
          </div>
          <button className={styles.navBtn} onClick={() => shift(1)} aria-label="Next month">
            <HugeiconsIcon icon={ArrowRight01Icon} size={18} strokeWidth={1.8} />
          </button>
          <button
            className={styles.todayBtn}
            onClick={() => {
              setYear(now.getFullYear());
              setMonth(now.getMonth());
            }}
          >
            Today
          </button>
        </div>

        <div className={styles.grid}>
          {WEEKDAYS.map((w) => (
            <div key={w} className={styles.weekday}>
              {w}
            </div>
          ))}
          {cells.map((d, i) => {
            if (!d) return <div key={`x${i}`} className={styles.blank} />;
            const dayPosts = byDay.get(dayKey(d)) ?? [];
            const past = isPast(d);
            return (
              <div
                key={dayKey(d)}
                className={`${styles.cell} ${isToday(d) ? styles.today : ""} ${past ? styles.pastCell : ""}`}
                onClick={() => {
                  if (!past) setModalDay(d);
                }}
              >
                <div className={styles.dateRow}>
                  <span className={styles.dateNum}>{d.getDate()}</span>
                  {!past && <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={1.8} className={styles.addHint} />}
                </div>
                {dayPosts.map((p) => (
                  <div
                    key={p.id}
                    className={styles.chip}
                    title={p.content}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className={styles.chipTime}>
                      {new Date(p.scheduledFor).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </span>{" "}
                    {p.content}
                  </div>
                ))}
                {dayPosts.length === 0 && !past && <div className={styles.nudge}>Add a post</div>}
              </div>
            );
          })}
        </div>
      </div>

      {modalDay && (
        <AddPostModal
          day={modalDay}
          onClose={() => setModalDay(null)}
          onScheduled={(p) => {
            setPosts((prev) => [...prev, p]);
            setModalDay(null);
          }}
        />
      )}
    </div>
  );
}

function AddPostModal({
  day,
  onClose,
  onScheduled,
}: {
  day: Date;
  onClose: () => void;
  onScheduled: (p: Post) => void;
}) {
  const [content, setContent] = useState("");
  const [time, setTime] = useState("09:00");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const label = day.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  async function schedule() {
    const text = content.trim();
    if (!text) {
      setErr("write something to post first");
      return;
    }
    const [hh, mm] = time.split(":").map(Number);
    const when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh || 9, mm || 0);
    if (when.getTime() < Date.now()) {
      setErr("pick a time in the future");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text, scheduledFor: when.toISOString() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "could not schedule");
        return;
      }
      onScheduled({ id: data.id, platform: "x", content: text, scheduledFor: when.toISOString() });
    } catch {
      setErr("could not schedule");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>Schedule a post</div>
        <div className={styles.modalDay}>{label}</div>
        <textarea
          className={styles.textarea}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          placeholder="What do you want to post? (no links, they tank reach)"
          autoFocus
        />
        <div className={styles.modalRow}>
          <label className={styles.timeLabel}>
            Time
            <input className={styles.timeInput} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <span className={styles.platformTag}>Posts to X</span>
        </div>
        {err && <div className={styles.modalErr}>{err}</div>}
        <div className={styles.modalActions}>
          <button className={styles.ghost} onClick={onClose}>
            Cancel
          </button>
          <button className="btnPrimary" onClick={schedule} disabled={saving}>
            {saving ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}
