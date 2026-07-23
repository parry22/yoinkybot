import { redirect } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { getSessionUser } from "@/lib/session";
import { listConnectedAccounts, billingOverview } from "@yoink/backend/web";
import { ThemeToggle } from "@/components/theme-toggle";
import { TelegramConnectButton } from "@/components/telegram-connect";
import { XConnectRow } from "@/components/connect-accounts";
import { ManageAccountButton } from "@/components/account-manage";
import styles from "@/components/panel.module.css";

export const dynamic = "force-dynamic";

const linkBtn = { display: "inline-flex", alignItems: "center", textDecoration: "none" } as const;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ billing_error?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const [accounts, billing, sp] = await Promise.all([
    listConnectedAccounts(user.id).catch(() => []),
    billingOverview(user.id).catch(() => null),
    searchParams,
  ]);
  const x = accounts.find((a) => a.platform === "x") ?? null;

  const t = billing?.trial;
  const planQ = t?.intendedPlan ? `?plan=${encodeURIComponent(t.intendedPlan)}` : "";
  const planLabel = t?.plan && t.plan !== "trialing" && t.plan !== "free" ? ` (${t.plan})` : "";
  const billingStatus =
    !t || t.status === "none"
      ? "No active plan yet."
      : t.status === "active"
        ? `Paid plan${planLabel} — active. Auto-renews; manage or cancel anytime.`
        : t.status === "trialing"
          ? `Free trial — ${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"} left. Add a card to auto-continue after it ends.`
          : "Your free trial has ended. Upgrade to keep full access.";

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
          <div className={styles.sectionBody} style={{ marginBottom: 12 }}>{user.email ?? (x ? x.handle : "your account")}</div>
          <ManageAccountButton />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Plan &amp; billing</div>
          <div className={styles.sectionBody} style={{ marginBottom: 12 }}>{billingStatus}</div>
          {sp?.billing_error && (
            <div className={styles.sectionBody} style={{ color: "#e5484d", marginBottom: 12 }}>
              Something went wrong opening billing. Please try again.
            </div>
          )}
          {billing?.hasDodoSubscription ? (
            <a href="/api/billing/portal" className="btnGhost" style={linkBtn}>
              Manage plan — change, update card, or cancel
            </a>
          ) : t?.onTrial ? (
            <a href={`/api/billing/start-trial${planQ}`} className="btnPrimary" style={linkBtn}>
              Add payment method
            </a>
          ) : (
            <a href={`/api/billing/checkout${planQ}`} className="btnPrimary" style={linkBtn}>
              Upgrade
            </a>
          )}
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

        <SignOutButton redirectUrl="/sign-in">
          <button type="button" className="btnGhost">
            Sign out
          </button>
        </SignOutButton>
      </div>
    </div>
  );
}
