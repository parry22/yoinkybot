import { redirect } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { getSessionUser } from "@/lib/session";
import { listConnectedAccounts, billingOverview, config } from "@yoink/backend/web";
import { ThemeToggle } from "@/components/theme-toggle";
import { TelegramConnectButton } from "@/components/telegram-connect";
import { XConnectRow } from "@/components/connect-accounts";
import { ManageAccountButton } from "@/components/account-manage";
import { PlanPicker } from "@/components/plan-picker";
import styles from "@/components/panel.module.css";

type PlanKey = "growth" | "scale" | "founding";

/** Resolve which plan card to highlight: the active plan, else the one picked at signup. */
function currentPlanKey(activePlan: string | null, intended: string | null): PlanKey {
  if (activePlan === "scale") return "scale";
  if (activePlan === "founding") return "founding";
  if (activePlan === "paid") return "growth";
  const i = (intended ?? "").toLowerCase();
  if (i === "scale") return "scale";
  if (i === "founding") return "founding";
  return "growth";
}

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
  const planLabel = t?.plan && t.plan !== "trialing" && t.plan !== "free" ? ` (${t.plan})` : "";
  const accessDay = t?.accessUntil
    ? new Date(t.accessUntil).toLocaleDateString(undefined, { day: "numeric", month: "long" })
    : null;

  /**
   * Every non-active state used to collapse into "Your free trial has ended",
   * so a customer who had been paying for months and whose card bounced was told
   * their trial was over. A payment problem now reads as a payment problem, and a
   * cancelled plan says how long the access they already paid for lasts.
   */
  const billingStatus = ((): string => {
    if (!t || t.status === "none") return "No active plan yet.";
    switch (t.status) {
      case "active":
        return `Paid plan${planLabel} — active. Auto-renews; manage or cancel anytime.`;
      case "trialing":
        return `Free trial — ${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"} left. Add a card to auto-continue after it ends.`;
      case "past_due":
        return t.hasAccess && accessDay
          ? `Payment failed — update your card to keep your plan${planLabel}. We'll keep retrying, and your access continues until ${accessDay}.`
          : `Payment failed — update your card to restore your plan${planLabel}.`;
      case "cancelled":
        return t.hasAccess && accessDay
          ? `Plan cancelled — it won't renew, and you keep full access until ${accessDay}.`
          : "Your plan has ended. Resubscribe to get full access back.";
      default:
        return "Your free trial has ended. Upgrade to keep full access.";
    }
  })();

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

          {t?.plan === "founding" ? (
            <div className={styles.sectionBody}>You're on the Founding plan — thank you for being early.</div>
          ) : (
            <PlanPicker
              currentKey={currentPlanKey(t?.status === "active" ? t.plan : null, t?.intendedPlan ?? null)}
              onTrial={Boolean(t?.onTrial)}
              hasSubscription={Boolean(billing?.hasDodoSubscription)}
              growthPrice={config.PAID_PRICE_LABEL}
              growthWas={config.PAID_PRICE_WAS_LABEL}
              scalePrice={config.SCALE_PRICE_LABEL}
              scaleWas={config.SCALE_PRICE_WAS_LABEL}
            />
          )}

          {billing?.hasDodoSubscription && (
            <div style={{ marginTop: 14 }}>
              <a href="/api/billing/portal" className="btnGhost" style={linkBtn}>
                Manage plan — update card, switch, or cancel
              </a>
            </div>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Connected X</div>
          <div className={styles.sectionBody} style={{ marginBottom: 12 }}>
            Yoinky reads your X to learn your voice and personalize everything, and refreshes it twice a day on its own.
            Reconnecting is only for switching accounts or restoring posting access.
          </div>
          <XConnectRow account={x ? { handle: x.handle, status: x.status } : null} />
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
