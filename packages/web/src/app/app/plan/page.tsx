import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/session";
import { getPlan } from "@yoink/backend/web";
import styles from "@/components/panel.module.css";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const plan = await getPlan(user.id).catch(() => null);

  if (!plan) {
    return (
      <div className={styles.page}>
        <div className={styles.inner}>
          <div className={styles.head}>
            <div>
              <div className={styles.title}>Plan</div>
              <div className={styles.subtitle}>Your throughline and the ideas waiting to be developed.</div>
            </div>
          </div>
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>No plan yet.</div>
            <p>
              A plan is built from your diagnosis. Connect an account in Settings to get started.{" "}
              <Link href="/app/settings" style={{ color: "var(--accent)" }}>Open Settings →</Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  const pending = plan.unlock.filter((u) => u.status === "pending");

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Plan</div>
            <div className={styles.subtitle}>
              {plan.cadence?.perWeek ? `${plan.cadence.perWeek}× / week` : "Cadence not set"}
              {plan.cadence?.note ? ` · ${plan.cadence.note}` : ""}
            </div>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Throughline</div>
          <div className={styles.throughline}>{plan.throughline}</div>
        </div>

        {plan.outside_in && (
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Outside-in</div>
            <div className={styles.sectionBody}>{plan.outside_in}</div>
          </div>
        )}

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Unlock backlog ({pending.length})</div>
          {pending.length === 0 ? (
            <div className={styles.sectionBody}>Nothing pending - you&apos;ve developed the backlog. Nice.</div>
          ) : (
            pending
              .sort((a, b) => a.priority - b.priority)
              .map((u) => (
                <div key={u.id} className={styles.unlockRow}>
                  <span className="pillAccent pill">{u.priority}</span>
                  <div>
                    <div className={styles.unlockIdea}>{u.idea}</div>
                    {u.rationale && <div className={styles.unlockRationale}>{u.rationale}</div>}
                  </div>
                </div>
              ))
          )}
        </div>
      </div>
    </div>
  );
}
