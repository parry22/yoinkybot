import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/session";
import { currentDiagnosis } from "@yoink/backend/web";
import styles from "@/components/panel.module.css";

export const dynamic = "force-dynamic";

export default async function DiagnosisPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const current = await currentDiagnosis(user.id).catch(() => null);

  if (!current) {
    return (
      <div className={styles.page}>
        <div className={styles.inner}>
          <div className={styles.head}>
            <div>
              <div className={styles.title}>Diagnosis</div>
              <div className={styles.subtitle}>Your 5-dimension brand read.</div>
            </div>
          </div>
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>No diagnosis yet.</div>
            <p>
              Finish setup and connect an account - Yoinky reads your history and reveals the gap between what you
              say and what you ship. <Link href="/app/onboarding" style={{ color: "var(--accent)" }}>Finish setup →</Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  const d = current.dimensions;

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Diagnosis</div>
            <div className={styles.subtitle}>Latest read · {new Date(current.created_at).toISOString().slice(0, 10)}</div>
          </div>
        </div>

        <p className={styles.headline}>{d.headline}</p>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>🧠 Intellectual fingerprint</div>
          <div className={styles.sectionBody}>{d.intellectual_fingerprint.read}</div>
          {d.intellectual_fingerprint.owned_positions.length > 0 && (
            <ul className={styles.list}>
              {d.intellectual_fingerprint.owned_positions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>🗣 Voice signature</div>
          <div className={styles.sectionBody}>{d.voice_signature.read}</div>
          {d.voice_signature.drift && (
            <ul className={styles.list}>
              <li>{d.voice_signature.drift}</li>
            </ul>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>🌍 Outside-in gap</div>
          <div className={styles.sectionBody}>{d.outside_in_gap.read}</div>
          {d.outside_in_gap.missed_swings.length > 0 && (
            <ul className={styles.list}>
              {d.outside_in_gap.missed_swings.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
        </div>

        {d.consistency_audit.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionLabel}>⚖️ Contradictions worth resolving</div>
            <ul className={styles.list}>
              {d.consistency_audit.map((c, i) => (
                <li key={i}>
                  <strong>{c.tension}</strong> - {c.why_interesting}
                </li>
              ))}
            </ul>
          </div>
        )}

        {d.unsaid_patterns.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionLabel}>💎 The unsaid</div>
            <ul className={styles.list}>
              {d.unsaid_patterns.map((u, i) => (
                <li key={i}>
                  <strong>{u.idea}</strong> - {u.evidence}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
