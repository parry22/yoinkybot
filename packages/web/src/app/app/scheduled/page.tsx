import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/session";
import { listScheduled } from "@yoink/backend/web";
import { LocalTime } from "@/components/local-time";
import styles from "@/components/panel.module.css";

export const dynamic = "force-dynamic";

const PLATFORM_LABEL: Record<string, string> = { x: "X" };

export default async function ScheduledPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const posts = await listScheduled(user.id).catch(() => []);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Scheduled</div>
            <div className={styles.subtitle}>Posts queued to publish - soonest first.</div>
          </div>
        </div>

        {posts.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>Nothing scheduled.</div>
            <p>
              Draft a post and pick a time to see it here.{" "}
              <Link href="/app/compose" style={{ color: "var(--accent)" }}>Compose a post →</Link>
            </p>
          </div>
        ) : (
          posts.map((p) => (
            <div key={p.id} className={styles.schedRow}>
              <div className={styles.schedHead}>
                <span className="pill pillAccent">{PLATFORM_LABEL[p.platform] ?? p.platform}</span>
                <span className={styles.schedWhen}>
                  <LocalTime iso={p.scheduled_for} />
                </span>
              </div>
              <div className={styles.schedContent}>{p.content}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
