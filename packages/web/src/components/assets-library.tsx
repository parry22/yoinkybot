"use client";

import { useMemo, useState, type ComponentType } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  File01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { ContentAssetView } from "@yoink/backend/web";
import { BeehiivLogo, LinkedInLogo, SubstackLogo, XLogo } from "./integration-logos";
import styles from "./assets-calendar.module.css";

const CHANNELS = [
  { id: "x", label: "X", Logo: XLogo, live: true },
  { id: "linkedin", label: "LinkedIn", Logo: LinkedInLogo, live: true },
] as const;

/** Not live — kept out of the filter bar so we don't imply they publish. */
const COMING_SOON_CHANNELS = [
  { id: "substack", label: "Substack", Logo: SubstackLogo },
  { id: "beehiiv", label: "Beehiiv", Logo: BeehiivLogo },
] as const;

type ChannelId = (typeof CHANNELS)[number]["id"] | (typeof COMING_SOON_CHANNELS)[number]["id"];
type LiveChannelId = "x" | "linkedin";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function channelFor(asset: ContentAssetView): ChannelId {
  if (asset.assetType === "x_post") return "x";
  if (asset.assetType === "newsletter_section") return "substack";
  return "linkedin";
}

function eventClass(channel: ChannelId) {
  if (channel === "x") return styles.eventX;
  if (channel === "linkedin") return styles.eventLinkedin;
  if (channel === "beehiiv") return styles.eventBeehiiv;
  return styles.eventSubstack;
}

function channelLabel(id: ChannelId): string {
  return (
    CHANNELS.find((c) => c.id === id)?.label ??
    COMING_SOON_CHANNELS.find((c) => c.id === id)?.label ??
    id
  );
}

function preview(text: string, max = 100) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function AssetsLibrary({
  assets: initialAssets,
  canReview,
}: {
  assets: ContentAssetView[];
  canReview: boolean;
}) {
  const now = new Date();
  const [assets, setAssets] = useState(initialAssets);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [selectedDay, setSelectedDay] = useState<Date>(now);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [channels, setChannels] = useState<LiveChannelId[]>(["x", "linkedin"]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [scheduledLocal, setScheduledLocal] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const asset of initialAssets) {
      if (asset.scheduledFor) initial[asset.id] = asset.scheduledFor;
    }
    return initial;
  });

  const drafts = useMemo(
    () => assets.filter((asset) => ["draft", "needs_review", "approved"].includes(asset.status)),
    [assets],
  );

  const liveChannels = useMemo(
    () => channels.filter((id): id is LiveChannelId => id === "x" || id === "linkedin"),
    [channels],
  );

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevDays = new Date(year, month, 0).getDate();
    const out: Array<{ date: Date; inMonth: boolean }> = [];

    for (let i = startPad - 1; i >= 0; i--) {
      out.push({ date: new Date(year, month - 1, prevDays - i), inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({ date: new Date(year, month, d), inMonth: true });
    }
    let next = 1;
    while (out.length < 42) {
      out.push({ date: new Date(year, month + 1, next++), inMonth: false });
    }
    return out;
  }, [year, month]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, ContentAssetView[]>();
    for (const asset of assets) {
      const when = scheduledLocal[asset.id];
      if (!when) continue;
      const key = dayKey(new Date(when));
      const list = map.get(key) ?? [];
      list.push(asset);
      map.set(key, list);
    }
    return map;
  }, [assets, scheduledLocal]);

  const selectedKey = dayKey(selectedDay);

  function shift(delta: number) {
    const next = month + delta;
    setYear(year + Math.floor(next / 12));
    setMonth(((next % 12) + 12) % 12);
  }

  function toggleChannel(id: LiveChannelId) {
    setChannels((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  async function publish(asset: ContentAssetView) {
    if (liveChannels.length === 0) {
      setError("Pick X and/or LinkedIn to publish.");
      return;
    }
    setBusyId(asset.id);
    setError("");
    setNotice("");

    const scheduledFor = new Date(selectedDay);
    scheduledFor.setHours(10, 0, 0, 0);
    const iso = scheduledFor.toISOString();

    if (asset.status === "draft" || asset.status === "needs_review") {
      const approveRes = await fetch("/api/briefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve_asset", assetId: asset.id }),
      });
      if (!approveRes.ok) {
        const data = (await approveRes.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Could not approve this asset for publishing.");
        setBusyId(null);
        return;
      }
      setAssets((current) =>
        current.map((item) => (item.id === asset.id ? { ...item, status: "approved" } : item)),
      );
    }

    const response = await fetch("/api/briefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "schedule",
        assetId: asset.id,
        scheduledFor: iso,
        platforms: liveChannels,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      publications?: Array<{ id: string; platform: string }>;
      error?: string;
    };

    if (!response.ok) {
      setError(data.error ?? "Could not schedule this asset.");
      setBusyId(null);
      return;
    }

    setScheduledLocal((current) => ({ ...current, [asset.id]: iso }));
    setAssets((current) =>
      current.map((item) => (item.id === asset.id ? { ...item, status: "scheduled" } : item)),
    );
    const labels = (data.publications ?? liveChannels.map((platform) => ({ platform })))
      .map((item) => channelLabel(item.platform as ChannelId))
      .join(", ");
    setNotice(`Scheduled on ${labels}.`);
    setBusyId(null);
    setDraftsOpen(false);
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <button type="button" className={styles.navBtn} onClick={() => shift(-1)} aria-label="Previous month">
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
        </button>
        <div className={styles.month}>
          {MONTHS[month]} {year}
        </div>
        <button type="button" className={styles.navBtn} onClick={() => shift(1)} aria-label="Next month">
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
        </button>
        <button
          type="button"
          className={styles.todayBtn}
          onClick={() => {
            setYear(now.getFullYear());
            setMonth(now.getMonth());
            setSelectedDay(now);
          }}
        >
          Today
        </button>

        <div className={styles.channels}>
          {CHANNELS.map((channel) => {
            const Logo = channel.Logo as ComponentType<{ size?: number }>;
            const on = liveChannels.includes(channel.id as LiveChannelId);
            return (
              <button
                key={channel.id}
                type="button"
                className={`${styles.channel} ${on ? styles.channelOn : ""}`}
                onClick={() => toggleChannel(channel.id)}
                title={channel.label}
              >
                <span className={styles.channelLogo}>
                  <Logo size={14} />
                </span>
                {channel.label}
              </button>
            );
          })}
          <span className={styles.channelNote}>Substack and Beehiiv publishing coming soon.</span>
        </div>

        <div className={styles.spacer} />

        <Link href="/app/distribution" className={styles.distLink}>
          Distribution
        </Link>
        <button
          type="button"
          className={`${styles.draftBtn} ${draftsOpen ? styles.draftBtnOn : ""}`}
          onClick={() => setDraftsOpen((v) => !v)}
          aria-label="Drafts"
          title="Drafts"
        >
          <HugeiconsIcon icon={File01Icon} size={16} />
          {drafts.length > 0 && <span className={styles.badge} />}
        </button>
      </div>

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}
      {notice && <div className={`${styles.banner} ${styles.bannerOk}`}>{notice}</div>}

      <div className={styles.body}>
        <div className={styles.weekdays}>
          {WEEKDAYS.map((day, index) => (
            <div key={`${day}-${index}`} className={styles.weekday}>
              {day}
            </div>
          ))}
        </div>

        <div className={styles.grid}>
          {cells.map(({ date, inMonth }) => {
            const key = dayKey(date);
            const events = eventsByDay.get(key) ?? [];
            const selected = key === selectedKey;
            const isToday = key === dayKey(now);
            return (
              <button
                type="button"
                key={key}
                className={`${styles.cell} ${selected ? styles.cellSelected : ""}`}
                onClick={() => setSelectedDay(date)}
              >
                <span className={`${styles.date} ${isToday ? styles.dateToday : ""} ${inMonth ? "" : styles.mutedDate}`}>
                  {date.getDate()}
                </span>
                <div className={styles.events}>
                  {events.slice(0, 3).map((event) => {
                    const channel = channelFor(event);
                    return (
                      <span key={event.id} className={`${styles.event} ${eventClass(channel)}`}>
                        {channelLabel(channel)} · {event.title}
                      </span>
                    );
                  })}
                  {events.length > 3 && <span className={styles.more}>+{events.length - 3}</span>}
                </div>
              </button>
            );
          })}
        </div>

        {draftsOpen && (
          <aside className={styles.panel}>
            <div className={styles.panelHead}>
              <h3>Drafts</h3>
              <button type="button" className={styles.navBtn} onClick={() => setDraftsOpen(false)} aria-label="Close">
                <HugeiconsIcon icon={Cancel01Icon} size={15} />
              </button>
            </div>
            {drafts.length === 0 ? (
              <p className={styles.muted}>No drafts yet. Generate in Studio, then publish here.</p>
            ) : (
              <div className={styles.panelList}>
                {drafts.map((asset) => (
                  <article key={asset.id} className={styles.card}>
                    <div className={styles.cardMeta}>
                      <span>{channelLabel(channelFor(asset))}</span>
                      <span>{asset.status}</span>
                    </div>
                    <h4>{asset.title}</h4>
                    <p>{preview(asset.content)}</p>
                    {canReview ? (
                      <button
                        type="button"
                        className={styles.publish}
                        disabled={busyId === asset.id || liveChannels.length === 0}
                        onClick={() => void publish(asset)}
                      >
                        <HugeiconsIcon icon={Tick02Icon} size={14} />
                        {busyId === asset.id
                          ? "Publishing…"
                          : `Publish · ${liveChannels.map((id) => channelLabel(id)).join(", ")}`}
                      </button>
                    ) : (
                      <span className={styles.muted}>Editor access required to approve and schedule.</span>
                    )}
                  </article>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
