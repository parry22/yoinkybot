import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { getXConnectStatus, trialInfo, byokStatus } from "@yoink/backend/web";
import { AppShell } from "@/components/app-shell";
import { ConnectXGate } from "@/components/connect-x-gate";
import styles from "./shell.module.css";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const [x, trial, byok] = await Promise.all([
    getXConnectStatus(user.id).catch(() => ({
      connected: false,
      status: null,
      reading: false,
      failed: false,
      postCount: 0,
    })),
    trialInfo(user.id).catch(() => null),
    // Fail OPEN on a lookup error: a transient DB blip must not lock a paying
    // lifetime user out of the product they bought.
    byokStatus(user.id).catch(() => ({ required: false, complete: true }) as { required: boolean; complete: boolean }),
  ]);

  /**
   * BYOK gate. A lifetime user funds their own model and scraper spend, so until
   * their keys are in place there is literally nothing the app can do — every
   * generation and every X read would fail. Sending them to setup is the only
   * honest state.
   *
   * `/setup-keys` lives OUTSIDE this layout on purpose: nested under /app it
   * would inherit this very redirect and bounce forever.
   */
  if (byok.required && !byok.complete) redirect("/setup-keys");

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
