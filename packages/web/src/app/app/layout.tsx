import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { getXConnectStatus, trialInfo } from "@yoink/backend/web";
import { AppShell } from "@/components/app-shell";
import { ConnectXGate } from "@/components/connect-x-gate";
import styles from "./shell.module.css";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const [x, trial] = await Promise.all([
    getXConnectStatus(user.id).catch(() => ({
      connected: false,
      status: null,
      reading: false,
      failed: false,
      postCount: 0,
    })),
    trialInfo(user.id).catch(() => null),
  ]);

  return (
    <div className={styles.shell}>
      <AppShell trial={trial}>{children}</AppShell>
      {/* Mandatory: users must connect X before using the app. `reading`/`failed`
       *  come along because a half-finished connect is not the same thing as no
       *  connect — one needs progress, the other needs a reason and a retry. */}
      <ConnectXGate connected={x.connected} reading={x.reading} failed={x.failed} />
    </div>
  );
}
