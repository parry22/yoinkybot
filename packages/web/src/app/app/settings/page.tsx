import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listConnectedAccounts } from "@yoink/backend/web";
import { ThemeToggle } from "@/components/theme-toggle";
import { TelegramConnectButton } from "@/components/telegram-connect";
import { XConnectRow } from "@/components/connect-accounts";
import styles from "@/components/panel.module.css";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const accounts = await listConnectedAccounts(user.id).catch(() => []);
  const x = accounts.find((a) => a.platform === "x") ?? null;

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
          <div className={styles.sectionBody}>{user.email ?? (x ? x.handle : "your account")}</div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Connected X</div>
          <div className={styles.sectionBody} style={{ marginBottom: 12 }}>
            Yoinky reads your X to learn your voice and personalize everything. Reconnect any time to refresh the read.
          </div>
          <XConnectRow
            account={
              x
                ? { handle: x.handle, status: x.status, post_count: x.post_count }
                : null
            }
          />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Telegram add-on</div>
          <div className={styles.sectionBody} style={{ marginBottom: 12 }}>
            Telegram is your capture and proactive-nudge line: drop thoughts on the go, and get trend moments,
            consistency flags, and daily reads in your DMs.
          </div>
          <TelegramConnectButton linked={Boolean(user.telegram_id)} />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Appearance</div>
          <ThemeToggle />
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
