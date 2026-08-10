"use client";

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useSearchParams } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
  BeehiivLogo,
  BrevoLogo,
  ChatGPTLogo,
  ClaudeLogo,
  EmailLogo,
  FirefliesLogo,
  GitHubLogo,
  GongLogo,
  GranolaLogo,
  LinkedInLogo,
  LoomLogo,
  MailchimpLogo,
  NotionLogo,
  OmnisendLogo,
  SlackLogo,
  SubstackLogo,
  XLogo,
} from "./integration-logos";
import styles from "./integrations.module.css";

type Account = { handle: string; status: string } | null;

type IntegrationCard = {
  id: string;
  name: string;
  description: string;
  status: "connected" | "available" | "soon";
  Logo: ComponentType<{ className?: string; size?: number }>;
  href?: string;
  handle?: string | null;
  actionLabel?: string;
};

function StatusPill({ status }: { status: IntegrationCard["status"] }) {
  if (status === "connected") return <span className={`${styles.pill} ${styles.pillOn}`}>Connected</span>;
  if (status === "available") return <span className={styles.pill}>Available</span>;
  return <span className={`${styles.pill} ${styles.pillSoon}`}>Not live yet</span>;
}

function Card({ item }: { item: IntegrationCard }) {
  const Logo = item.Logo;
  return (
    <article className={styles.card}>
      <div className={styles.cardTop}>
        <span className={styles.logoWrap} aria-hidden="true">
          <Logo className={styles.logo} size={22} />
        </span>
        <StatusPill status={item.status} />
      </div>
      <h3>{item.name}</h3>
      <p>{item.description}</p>
      <div className={`${styles.handle} ${item.handle ? "" : styles.handleEmpty}`}>
        {item.handle ?? "—"}
      </div>
      <div className={styles.cardFooter}>
        {item.href ? (
          <a href={item.href} className={styles.connectBtn}>
            <HugeiconsIcon icon={Link01Icon} size={14} />
            {item.actionLabel ?? (item.status === "connected" ? "Reconnect" : "Connect")}
          </a>
        ) : (
          <button type="button" className={styles.connectBtn} disabled>
            <HugeiconsIcon icon={Link01Icon} size={14} />
            Connect
          </button>
        )}
      </div>
    </article>
  );
}

function oauthMessage(kind: string | null, connected: string | null) {
  if (connected === "x") return "X connected.";
  if (connected === "linkedin") return "LinkedIn connected.";
  if (kind === "config") {
    return "OAuth isn’t configured for localhost yet. Add client credentials and register http://localhost:3002/api/auth/x/callback and …/linkedin/callback in the developer apps.";
  }
  if (kind === "retry") return "Connection failed. Confirm the redirect URI matches localhost:3002 exactly, then try again.";
  return "";
}

export function Integrations({
  x,
  linkedIn,
}: {
  x: Account;
  linkedIn: Account;
}) {
  const params = useSearchParams();
  const [banner, setBanner] = useState("");
  const notice = useMemo(
    () => oauthMessage(params.get("connect_error"), params.get("connected")),
    [params],
  );

  useEffect(() => {
    setBanner(notice);
  }, [notice]);

  const publish: IntegrationCard[] = [
    {
      id: "x",
      name: "X",
      description: "Post and schedule short-form assets. Also used to learn your voice.",
      status: x ? "connected" : "available",
      Logo: XLogo,
      href: "/api/auth/x/start",
      handle: x?.handle ?? null,
    },
    {
      id: "linkedin",
      name: "LinkedIn",
      description: "Publish and schedule professional posts from Studio and Assets.",
      status: linkedIn ? "connected" : "available",
      Logo: LinkedInLogo,
      href: "/api/auth/linkedin/start",
      handle: linkedIn?.handle ?? null,
    },
    {
      id: "beehiiv",
      name: "Beehiiv",
      description: "Push newsletter sections into Beehiiv drafts.",
      status: "soon",
      Logo: BeehiivLogo,
    },
    {
      id: "substack",
      name: "Substack",
      description: "Export newsletter-ready drafts for Substack.",
      status: "soon",
      Logo: SubstackLogo,
    },
    {
      id: "mailchimp",
      name: "Mailchimp",
      description: "Send newsletter sections into Mailchimp campaigns.",
      status: "soon",
      Logo: MailchimpLogo,
    },
    {
      id: "brevo",
      name: "Brevo",
      description: "Sync newsletter assets into Brevo email journeys.",
      status: "soon",
      Logo: BrevoLogo,
    },
    {
      id: "omnisend",
      name: "Omnisend",
      description: "Push campaigns into Omnisend for ecommerce sends.",
      status: "soon",
      Logo: OmnisendLogo,
    },
  ];

  const sources: IntegrationCard[] = [
    {
      id: "chatgpt",
      name: "ChatGPT",
      description: "Import selected conversations from your ChatGPT data export as source-backed knowledge.",
      status: "available",
      Logo: ChatGPTLogo,
      href: "/app/knowledge?import=chatgpt",
      actionLabel: "Import export",
    },
    {
      id: "claude",
      name: "Claude",
      description: "Bring selected Claude conversations into Knowledge from a local conversation export.",
      status: "available",
      Logo: ClaudeLogo,
      href: "/app/knowledge?import=claude",
      actionLabel: "Import export",
    },
    {
      id: "slack",
      name: "Slack",
      description: "Pull threads and channel digests into Inbox.",
      status: "soon",
      Logo: SlackLogo,
    },
    {
      id: "granola",
      name: "Granola",
      description: "Import meeting notes as source-backed knowledge.",
      status: "soon",
      Logo: GranolaLogo,
    },
    {
      id: "notion",
      name: "Notion",
      description: "Sync docs and customer notes into Knowledge.",
      status: "soon",
      Logo: NotionLogo,
    },
    {
      id: "fireflies",
      name: "Fireflies",
      description: "Capture call objections and proof language.",
      status: "soon",
      Logo: FirefliesLogo,
    },
    {
      id: "gong",
      name: "Gong",
      description: "Ingest deal calls and win/loss language.",
      status: "soon",
      Logo: GongLogo,
    },
    {
      id: "loom",
      name: "Loom",
      description: "Turn video transcripts into knowledge cards.",
      status: "soon",
      Logo: LoomLogo,
    },
    {
      id: "github",
      name: "GitHub",
      description: "Ingest changelogs and product updates.",
      status: "soon",
      Logo: GitHubLogo,
    },
    {
      id: "email",
      name: "Email",
      description: "Forward notes into the capture pipeline.",
      status: "soon",
      Logo: EmailLogo,
    },
  ];

  const publishLive = publish.filter((item) => item.status !== "soon");
  const publishSoon = publish.filter((item) => item.status === "soon");
  const sourcesLive = sources.filter((item) => item.status !== "soon");
  const sourcesSoon = sources.filter((item) => item.status === "soon");

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        {banner && (
          <div className={`${styles.banner} ${params.get("connect_error") ? styles.bannerError : styles.bannerOk}`}>
            {banner}
            <button type="button" className={styles.bannerClose} onClick={() => setBanner("")} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Publish</h2>
          </div>
          <div className={styles.grid}>
            {publishLive.map((item) => (
              <Card key={item.id} item={item} />
            ))}
          </div>
          {publishSoon.length > 0 && (
            <div className={styles.soonBlock}>
              <p className={styles.soonLabel}>Coming later — not live</p>
              <div className={`${styles.grid} ${styles.gridSoon}`}>
                {publishSoon.map((item) => (
                  <Card key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Knowledge sources</h2>
          </div>
          {sourcesLive.length > 0 && (
            <div className={styles.grid}>
              {sourcesLive.map((item) => (
                <Card key={item.id} item={item} />
              ))}
            </div>
          )}
          {sourcesSoon.length > 0 && (
            <div className={styles.soonBlock}>
              <p className={styles.soonLabel}>Coming later — not live</p>
              <div className={`${styles.grid} ${styles.gridSoon}`}>
                {sourcesSoon.map((item) => (
                  <Card key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}
        </section>

        <p className={styles.footnote}>
          <HugeiconsIcon icon={Tick02Icon} size={13} />
          Restricted and confidential material never enters generation.
        </p>
      </div>
    </div>
  );
}
