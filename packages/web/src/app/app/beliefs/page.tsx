import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/session";
import { activePositions } from "@yoink/backend/web";
import styles from "@/components/panel.module.css";

export const dynamic = "force-dynamic";

function fmt(d: string): string {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 10);
}

export default async function BeliefsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const positions = await activePositions(user.id).catch(() => []);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Beliefs</div>
            <div className={styles.subtitle}>The positions Yoinky has watched you stake - strongest first.</div>
          </div>
        </div>

        {positions.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>No positions yet.</div>
            <p>
              Once you&apos;ve dropped a few takes (or connected an account), Yoinky surfaces the beliefs you keep
              returning to. <Link href="/app/compose" style={{ color: "var(--accent)" }}>Start in Compose →</Link>
            </p>
          </div>
        ) : (
          positions.map((p) => {
            const pct = Math.round((p.confidence ?? 0) * 100);
            return (
              <div key={p.id} className={styles.belief}>
                <div className={styles.beliefStatement}>{p.statement}</div>
                <div className={styles.beliefMeta}>
                  <span className={styles.bar}>
                    <i style={{ width: `${pct}%` }} />
                  </span>
                  <span>confidence {pct}%</span>
                  {p.version > 1 && <span>· v{p.version}</span>}
                  <span>· since {fmt(p.first_stated_at)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
