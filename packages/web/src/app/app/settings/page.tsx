import { redirect } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { getSessionUser } from "@/lib/session";
import { listConnectedAccounts, billingOverview, config,getWorkspaceAdmin,resolveWorkspaceContext } from "@yoink/backend/web";
import { TelegramConnectButton } from "@/components/telegram-connect";
import { LinkedInConnectRow, XConnectRow } from "@/components/connect-accounts";
import { ManageAccountButton } from "@/components/account-manage";
import { PlanPicker } from "@/components/plan-picker";
import styles from "@/components/settings-shell.module.css";
import { WorkspaceSettings } from "@/components/workspace-settings";

type PlanKey = "open_source" | "growth" | "scale" | "founding";

/** Resolve which plan card to highlight: the active plan, else the one picked at signup. */
function currentPlanKey(activePlan: string | null, intended: string | null): PlanKey {
  if (config.SELF_HOSTED) return "open_source";
  // Legacy Lifetime rows receive Scale access after the offering is retired.
  if (activePlan === "lifetime") return "scale";
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

  const [accounts, billing, sp,workspace] = await Promise.all([
    listConnectedAccounts(user.id).catch(() => []),
    billingOverview(user.id).catch(() => null),
    searchParams,
    resolveWorkspaceContext(user.id),
  ]);
  const workspaceAdmin=workspace?await getWorkspaceAdmin(user.id,workspace.id):null;
  const x = accounts.find((a) => a.platform === "x") ?? null;
  const linkedIn = accounts.find((a) => a.platform === "linkedin") ?? null;

  const t = billing?.trial;
  const planName = t?.plan === "paid" ? "Growth" : t?.plan === "scale" || t?.plan === "lifetime" ? "Scale" : t?.plan;
  const planLabel = planName && planName !== "trialing" && planName !== "free" ? ` (${planName})` : "";
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
    if (config.SELF_HOSTED) return "Open Source - self-hosted with your own infrastructure and API keys.";
    if (!t || t.status === "none") return "No active plan yet.";
    switch (t.status) {
      case "active":
        if (t.plan === "lifetime") return "Scale access - active.";
        return `Paid plan${planLabel} - active. Auto-renews; manage or cancel anytime.`;
      case "trialing":
        return `Free trial - ${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"} left. Add a card to auto-continue after it ends.`;
      case "past_due":
        return t.hasAccess && accessDay
          ? `Payment failed - update your card to keep your plan${planLabel}. We'll keep retrying, and your access continues until ${accessDay}.`
          : `Payment failed - update your card to restore your plan${planLabel}.`;
      case "cancelled":
        return t.hasAccess && accessDay
          ? `Plan cancelled - it won't renew, and you keep full access until ${accessDay}.`
          : "Your plan has ended. Resubscribe to get full access back.";
      default:
        return "Your free trial has ended. Upgrade to keep full access.";
    }
  })();

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <p className={styles.lede}>Connections, billing, and how Yoinky captures and publishes for this workspace.</p>
        </header>

        <section className={styles.section}>
          <div className={styles.sectionLabel}>Organization and workspace</div>
          {workspaceAdmin ? <WorkspaceSettings initial={workspaceAdmin} /> : (
            <p className={styles.sectionBody}>No workspace loaded yet.</p>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionLabel}>Account</div>
          <p className={styles.sectionBodyStrong}>{user.email ?? (x ? x.handle : "your account")}</p>
          <ManageAccountButton />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionLabel}>{config.SELF_HOSTED ? "Plan" : "Plan & billing"}</div>
          <p className={styles.sectionBody}>{billingStatus}</p>
          {!config.SELF_HOSTED && sp?.billing_error && (
            <p className={styles.errorText}>Something went wrong opening billing. Please try again.</p>
          )}

          {!config.SELF_HOSTED && t?.plan === "founding" ? (
            <p className={styles.sectionBody}>You&apos;re on the Founding plan — thank you for being early.</p>
          ) : (
            <PlanPicker
              currentKey={currentPlanKey(t?.status === "active" ? t.plan : null, t?.intendedPlan ?? null)}
              onTrial={Boolean(t?.onTrial)}
              hasSubscription={Boolean(billing?.hasDodoSubscription)}
              growthPrice={config.PAID_PRICE_LABEL}
              growthWas={config.PAID_PRICE_WAS_LABEL}
              scalePrice={config.SCALE_PRICE_LABEL}
              scaleWas={config.SCALE_PRICE_WAS_LABEL}
              selfHosted={config.SELF_HOSTED}
            />
          )}

          {!config.SELF_HOSTED && billing?.hasDodoSubscription && (
            <div className={styles.actions}>
              <a href="/api/billing/portal" className="btnGhost" style={linkBtn}>
                Manage plan — update card, switch, or cancel
              </a>
            </div>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionLabel}>Connected X</div>
          <p className={styles.sectionBody}>
            Yoinky reads your X to learn voice and personalize drafts, and refreshes it twice a day.
            Reconnect only to switch accounts or restore posting access.
          </p>
          <XConnectRow account={x ? { handle: x.handle, status: x.status } : null} />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionLabel}>LinkedIn</div>
          <p className={styles.sectionBody}>Connect LinkedIn when you are ready to publish from generated assets.</p>
          <LinkedInConnectRow account={linkedIn ? { handle: linkedIn.handle, status: linkedIn.status } : null} />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionLabel}>Telegram capture</div>
          <p className={styles.sectionBody}>
            Drop thoughts on the go. Capture is the front door to Inbox — not a separate product surface.
          </p>
          <TelegramConnectButton linked={Boolean(user.telegram_id)} />
        </section>

        <div className={styles.actions}>
          <SignOutButton redirectUrl="/sign-in">
            <button type="button" className="btnGhost">
              Sign out
            </button>
          </SignOutButton>
        </div>
      </div>
    </div>
  );
}
