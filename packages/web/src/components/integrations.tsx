"use client";

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useSearchParams } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
  BeehiivLogo,
  BrevoLogo,
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
};

function StatusPill({ status }: { status: IntegrationCard["status"] }) {
  if (status === "connected") return <span className={`${styles.pill} ${styles.pillOn}`}>Connected</span>;
  if (status === "available") return <span className={styles.pill}>Available</span>;
  return <span className={`${styles.pill} ${styles.pillSoon}`}>Soon</span>;
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
            {item.status === "connected" ? "Reconnect" : "Connect"}
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
            {publish.map((item) => (
              <Card key={item.id} item={item} />
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Knowledge sources</h2>
          </div>
          <div className={styles.grid}>
            {sources.map((item) => (
              <Card key={item.id} item={item} />
            ))}
          </div>
        </section>

        <p className={styles.footnote}>
          <HugeiconsIcon icon={Tick02Icon} size={13} />
          Restricted and confidential material never enters generation.
        </p>
      </div>
    </div>
  );
}
