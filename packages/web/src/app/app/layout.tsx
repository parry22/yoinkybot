import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { config, getXConnectStatus } from "@yoink/backend/web";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/topbar";
import { ConnectXGate } from "@/components/connect-x-gate";
import styles from "./shell.module.css";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const email = user.email ?? "your account";
  const initials = (email.trim()[0] ?? "y").toUpperCase();
  const x = await getXConnectStatus(user.id).catch(() => ({ connected: false, status: null, postCount: 0 }));

  return (
    <div className={styles.shell}>
      <div className={styles.platform}>
        <Sidebar user={{ email, initials }} />
        <main className={styles.workspace}>
          <TopBar telegramUrl={config.TELEGRAM_BOT_URL} />
          <div className={styles.content}>{children}</div>
        </main>
      </div>
      {/* Mandatory: users must connect X before using the app. */}
      <ConnectXGate connected={x.connected} />
    </div>
  );
}
