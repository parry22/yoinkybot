"use client";

import Link from "next/link";
import type { WorkspaceHomeView } from "@yoink/backend/web";
import styles from "./workspace-home.module.css";

export function WorkspaceHome({
  workspaceName,
  home,
}: {
  workspaceName: string;
  home: WorkspaceHomeView;
}) {
  const addingSources =
    home.nextAction.href.startsWith("/app/knowledge") &&
    /add source|source material/i.test(`${home.nextAction.label} ${home.nextAction.description}`);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>{workspaceName}</p>
            <h1>{home.nextAction.label}</h1>
            <p className={styles.lede}>{home.nextAction.description}</p>
          </div>
          <div className={styles.heroActions}>
            <Link href={home.nextAction.href} className="btnPrimary">
              {addingSources ? "Add in Knowledge" : "Continue"}
            </Link>
            {addingSources && (
              <Link href="/app/integrations" className="btnGhost">
                From Integrations
              </Link>
            )}
          </div>
        </header>

        <div className={styles.contextBar}>
          <div>
            <span>Briefs awaiting</span>
            <strong>{home.briefsNeedingApproval}</strong>
          </div>
          <div>
            <span>Assets in production</span>
            <strong>{home.assetsInProduction}</strong>
          </div>
          <div>
            <span>Next</span>
            <Link href={home.nextAction.href}>{home.nextAction.label}</Link>
          </div>
        </div>

        <div className={styles.signalGrid}>
          <section className={styles.signalPanel}>
            <div className={styles.signalHead}>
              <h2>Recent knowledge</h2>
              <Link href="/app/knowledge">Open</Link>
            </div>
            {home.recentKnowledge.length === 0 ? (
              <p className={styles.emptySignal}>
                No knowledge objects yet.{" "}
                <Link href="/app/integrations">Pull from Integrations</Link> or add a source in Knowledge.
              </p>
            ) : (
              home.recentKnowledge.map((item) => (
                <div key={item.id} className={styles.signalRow}>
                  <div>
                    <strong>{item.title}</strong>
                    <span>
                      {item.objectType} · {item.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className={styles.signalPanel}>
            <div className={styles.signalHead}>
              <h2>Upcoming publications</h2>
              <Link href="/app/assets">Open</Link>
            </div>
            {home.upcomingPublications.length === 0 ? (
              <p className={styles.emptySignal}>Nothing scheduled.</p>
            ) : (
              home.upcomingPublications.map((item) => (
                <div key={item.id} className={styles.signalRow}>
                  <div>
                    <strong>{item.title}</strong>
                    <span>
                      {item.platform} · {new Date(item.scheduledFor).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className={styles.signalPanel}>
            <div className={styles.signalHead}>
              <h2>Recent conversions</h2>
              <Link href="/app/distribution">Open</Link>
            </div>
            {home.recentConversions.length === 0 ? (
              <p className={styles.emptySignal}>No tracked conversions yet.</p>
            ) : (
              home.recentConversions.map((item) => (
                <div key={item.id} className={styles.signalRow}>
                  <div>
                    <strong>{item.eventType}</strong>
                    <span>
                      {item.assetTitle ?? "No asset"} · {new Date(item.occurredAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
