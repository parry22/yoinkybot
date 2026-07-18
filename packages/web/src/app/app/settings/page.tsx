import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { getStage, listConnectedAccounts } from "@yoink/backend/web";
import { ConnectAccounts } from "@/components/connect-accounts";
import styles from "@/components/panel.module.css";

export const dynamic = "force-dynamic";

const STAGE_LABEL: Record<string, string> = {
  new: "Not started",
  profiling: "Answering intake",
  profile_set: "Profile set",
  connected: "Account connected",
  diagnosed: "Diagnosed",
  awaiting_upgrade: "Awaiting upgrade",
  active: "Active",
  plan_active: "Active",
};

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const [stage, accounts] = await Promise.all([
    getStage(user.id).catch(() => "new"),
    listConnectedAccounts(user.id).catch(() => []),
  ]);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Settings</div>
            <div className={styles.subtitle}>Your account and how Yoinky reaches you.</div>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Account</div>
          <div className={styles.sectionBody}>{user.email ?? "—"}</div>
          <div className={styles.beliefMeta} style={{ marginTop: 12 }}>
            <span className="pill">Onboarding: {STAGE_LABEL[stage] ?? stage}</span>
            <span className="pill">{user.telegram_id ? "Telegram linked" : "Telegram not linked"}</span>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Connected accounts</div>
          <div className={styles.sectionBody} style={{ marginBottom: 4 }}>
            Connect your public presence so Yoinky can read your history and diagnose. Ingestion runs in the
            background — the backend worker (<code>pnpm dev</code>) must be running for a read to finish, and
            the result lands here and in your Telegram DMs.
          </div>
          <ConnectAccounts
            initial={accounts.map((a) => ({
              platform: a.platform,
              handle: a.handle,
              status: a.status,
              post_count: a.post_count,
              last_ingested_at: a.last_ingested_at,
            }))}
          />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Telegram add-on</div>
          <div className={styles.sectionBody}>
            The web app is your main workspace. Telegram keeps every feature and sends the proactive
            nudges — trend moments, consistency flags, and daily reads — straight to your DMs. Open the bot and send{" "}
            <strong>/start</strong> to link it to this account.
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Appearance</div>
          <div className={styles.sectionBody}>Use the sun/moon toggle in the sidebar to switch light and dark.</div>
        </div>

        <form action="/api/auth/logout" method="post">
          <button type="submit" className="btnGhost">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
