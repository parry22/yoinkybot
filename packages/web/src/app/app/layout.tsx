import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { getStage, config } from "@yoink/backend/web";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/topbar";
import styles from "./shell.module.css";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const stage = await getStage(user.id).catch(() => "new");
  const onboarding = !(stage === "active" || stage === "plan_active");
  const email = user.email ?? "your account";
  const initials = (email.trim()[0] ?? "y").toUpperCase();

  return (
    <div className={styles.shell}>
      <div className={styles.platform}>
        <Sidebar user={{ email, initials }} onboarding={onboarding} />
        <main className={styles.workspace}>
          <TopBar telegramUrl={config.TELEGRAM_BOT_URL} />
          <div className={styles.content}>{children}</div>
        </main>
      </div>
    </div>
  );
}
