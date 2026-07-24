import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { config, getXConnectStatus, trialInfo } from "@yoink/backend/web";
import { AppShell } from "@/components/app-shell";
import { ConnectXGate } from "@/components/connect-x-gate";
import styles from "./shell.module.css";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const [x, trial] = await Promise.all([
    getXConnectStatus(user.id).catch(() => ({ connected: false, status: null, postCount: 0 })),
    trialInfo(user.id).catch(() => null),
  ]);

  return (
    <div className={styles.shell}>
      <AppShell telegramUrl={config.TELEGRAM_BOT_URL} trial={trial}>
        {children}
      </AppShell>
      {/* Mandatory: users must connect X before using the app. */}
      <ConnectXGate connected={x.connected} />
    </div>
  );
}
