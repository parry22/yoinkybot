"use client";

import { useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Add01Icon,
  Image01Icon,
  Cancel01Icon,
  Video01Icon,
} from "@hugeicons/core-free-icons";
import panel from "./panel.module.css";
import styles from "./scheduled-calendar.module.css";

interface MediaView {
  id: string;
  kind: "image" | "gif" | "video";
  url: string;
  mimeType: string;
  byteSize: number;
  altText: string | null;
}

interface Post {
  id: string;
  platform: string;
  content: string;
  scheduledFor: string; // ISO
  media?: MediaView[];
}

/**
 * The same rule the server enforces (backend scheduling/service.ts#containsLink).
 * Duplicated deliberately: the server is authoritative, but finding out a link is
 * refused only AFTER pressing Schedule is a bad way to learn it, so the composer
 * says so while you're still typing. Kept character-identical to the server
 * regex so the two can't disagree about what counts as a link.
 */
const LINK_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|io|co|net|org|xyz|app|dev|ai|me|so)\b\S*/i;

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime";
const MAX_ATTACHMENTS = 4;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function ScheduledCalendar({
  posts: initial,
  usage,
  media,
}: {
  posts: Post[];
  /** This month's scheduling usage — cap null = unlimited (Scale). */
  usage: { used: number; cap: number | null };
  /** Whether media will actually publish, and the reason when it won't. */
  media: { canPostMedia: boolean; warning: string | null };
}) {
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
            <div className={panel.subtitle}>
              Your posting calendar. Tap any day to queue a post, with images or video.
              {" · "}
              {usage.cap === null ? "Unlimited this month" : `${usage.used}/${usage.cap} this month`}
            </div>
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
                    {p.media && p.media.length > 0 && (
                      <HugeiconsIcon
                        icon={p.media[0]!.kind === "video" ? Video01Icon : Image01Icon}
                        size={11}
                        strokeWidth={2}
                        aria-label={`${p.media.length} attachment${p.media.length === 1 ? "" : "s"}`}
                      />
                    )}{" "}
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
          mediaReady={media}
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
  mediaReady,
  onClose,
  onScheduled,
}: {
  day: Date;
  mediaReady: { canPostMedia: boolean; warning: string | null };
  onClose: () => void;
  onScheduled: (p: Post) => void;
}) {
  const [content, setContent] = useState("");
  const [time, setTime] = useState("09:00");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<MediaView[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const label = day.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  // Live link check, so the refusal arrives while typing rather than on submit.
  const linkFound = LINK_RE.test(content);
  const hasVideo = attachments.some((a) => a.kind !== "image");
  // X's rule: one video/GIF, or up to four images — never mixed.
  const canAttachMore = hasVideo ? false : attachments.length < MAX_ATTACHMENTS;

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setErr(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (!canAttachMoreAfter(attachments.length)) break;
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/schedule/media", { method: "POST", body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.media) {
          setErr(data.error ?? "couldn't attach that file");
          break;
        }
        setAttachments((prev) => [...prev, data.media as MediaView]);
      }
    } catch {
      setErr("couldn't attach that file");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function canAttachMoreAfter(count: number): boolean {
    return !hasVideo && count < MAX_ATTACHMENTS;
  }

  async function removeAttachment(m: MediaView) {
    setAttachments((prev) => prev.filter((a) => a.id !== m.id));
    // Staged uploads are cleaned up server-side; a failure here just leaves an
    // orphan the sweep collects, so it must not block the user.
    await fetch("/api/schedule/media", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: m.id, url: m.url }),
    }).catch(() => {});
  }

  async function schedule() {
    const text = content.trim();
    if (!text && attachments.length === 0) {
      setErr("write something, or attach an image");
      return;
    }
    if (linkFound) {
      setErr("links tank reach on X, so scheduled posts can't contain one. drop it and post it as the first reply instead.");
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
        body: JSON.stringify({
          content: text,
          scheduledFor: when.toISOString(),
          mediaIds: attachments.map((a) => a.id),
        }),
      });
      const data = await res.json();
      if (res.status === 402) {
        setErr("Scheduling is a paid feature — upgrade to continue.");
        return;
      }
      if (res.status === 429) {
        setErr(data.reason ?? "You've hit this month's scheduling limit — upgrade to Scale for unlimited.");
        return;
      }
      if (!res.ok) {
        setErr(data.error ?? "could not schedule");
        return;
      }
      onScheduled({
        id: data.id,
        platform: "x",
        content: text,
        scheduledFor: when.toISOString(),
        media: attachments,
      });
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
          placeholder="What do you want to post?"
          autoFocus
        />

        {/* The link rule, stated before it's broken and again the moment it is. */}
        <div className={linkFound ? styles.linkWarn : styles.linkHint}>
          {linkFound
            ? "That's a link — X suppresses reach on posts that send people off-platform, so this won't schedule. Post the link as the first reply instead."
            : "No links: they tank reach on X. Put yours in the first reply once this is live."}
        </div>

        {attachments.length > 0 && (
          <div className={styles.mediaStrip}>
            {attachments.map((m) => (
              <div key={m.id} className={styles.mediaItem}>
                {m.kind === "video" ? (
                  <video className={styles.mediaThumb} src={m.url} muted playsInline preload="metadata" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className={styles.mediaThumb} src={m.url} alt={m.altText ?? ""} />
                )}
                <button
                  className={styles.mediaRemove}
                  onClick={() => void removeAttachment(m)}
                  aria-label="Remove attachment"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2.4} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={styles.modalRow}>
          <label className={styles.timeLabel}>
            Time
            <input className={styles.timeInput} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <button
            className={styles.attachBtn}
            onClick={() => fileRef.current?.click()}
            disabled={uploading || !canAttachMore}
            title={
              hasVideo
                ? "A video can't be posted alongside anything else"
                : canAttachMore
                  ? "Attach an image or video"
                  : `Up to ${MAX_ATTACHMENTS} images per post`
            }
          >
            <HugeiconsIcon icon={Image01Icon} size={14} strokeWidth={1.8} />
            {uploading ? "Uploading…" : attachments.length > 0 ? "Add more" : "Add media"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => void addFiles(e.target.files)}
          />
          <span className={styles.platformTag}>Posts to X</span>
        </div>

        {/* Media only publishes if the stored X token carries media.write. Said
         *  here, at attach time, rather than discovered when the post fires. */}
        {attachments.length > 0 && !mediaReady.canPostMedia && mediaReady.warning && (
          <div className={styles.linkWarn}>{mediaReady.warning}</div>
        )}

        {err && <div className={styles.modalErr}>{err}</div>}
        <div className={styles.modalActions}>
          <button className={styles.ghost} onClick={onClose}>
            Cancel
          </button>
          <button className="btnPrimary" onClick={schedule} disabled={saving || uploading || linkFound}>
            {saving ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}
