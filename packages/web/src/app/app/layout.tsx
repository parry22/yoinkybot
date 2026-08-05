import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { getSocialConnectStatus, trialInfo } from "@yoink/backend/web";
import { AppShell } from "@/components/app-shell";
import { ConnectXGate } from "@/components/connect-x-gate";
import styles from "./shell.module.css";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const emptyConnection = { connected: false, status: null, reading: false, failed: false, postCount: 0 };
  const [social, trial] = await Promise.all([
    getSocialConnectStatus(user.id).catch(() => ({ x: emptyConnection, linkedIn: emptyConnection })),
    trialInfo(user.id).catch(() => null),
  ]);

  return (
    <div className={styles.shell}>
      <AppShell trial={trial}>{children}</AppShell>
      {/* One connected platform is enough to start. X can take a moment to read
       * history; LinkedIn OAuth is ready to publish as soon as it completes. */}
      <ConnectXGate x={social.x} linkedIn={social.linkedIn} />
    </div>
  );
}
