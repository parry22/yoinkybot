import type { TrialInfo } from "@yoink/backend/web";
import styles from "./topbar.module.css";

/**
 * Subtle trial pill that lives in the top nav bar (not a full-width strip).
 * While the trial runs it invites the user to add a card ("keep going after your
 * trial") — card capture happens here, inside the app, not at signup. Once the
 * trial has ended it firms up into an upgrade prompt. A healthy paying
 * subscription renders nothing.
 *
 * A payment problem reads as a payment problem. The pill used to render the
 * single "expired" bucket for every non-active state, so a customer who had been
 * paying for months and whose card bounced was told "Trial ended" and pointed at
 * a fresh checkout — which is how they ended up with two subscriptions. They now
 * get "Payment failed" and go to the customer portal to fix the card.
 */
export function TrialPill({ trial }: { trial: TrialInfo }) {
  const { status } = trial;
  if (status === "active" || status === "none") return null;

  // `purchasablePlan` is null unless the plan picked at signup has a Dodo product
  // configured. The pill used to append `?plan=${intendedPlan}` unconditionally,
  // which sent every founding-link signup to a checkout that could only throw
  // (DODO_PRODUCT_FOUNDING has never been set). Null → default Growth product.
  const planQ = trial.purchasablePlan ? `?plan=${encodeURIComponent(trial.purchasablePlan)}` : "";

  if (status === "past_due") {
    // The card is already on file; the fix is updating it, not buying again.
    return (
      <a
        href="/api/billing/portal"
        className={`${styles.trialPill} ${styles.trialPillExpired}`}
        title={
          trial.accessUntil
            ? `We couldn't charge your card. Update it to keep your plan — access continues until ${formatDay(trial.accessUntil)}.`
            : "We couldn't charge your card. Update it to restore your plan."
        }
      >
        <span className={styles.trialDot} aria-hidden="true" />
        <span className={styles.trialText}>Payment failed</span>
        <span className={styles.trialCta}>Update card</span>
      </a>
    );
  }

  if (status === "cancelled") {
    // Still inside the paid period → informational, nothing to sell yet.
    if (trial.hasAccess && trial.accessUntil) {
      return (
        <a
          href="/api/billing/portal"
          className={styles.trialPill}
          title={`Your plan is cancelled and won't renew. You keep full access until ${formatDay(trial.accessUntil)}.`}
        >
          <span className={styles.trialDot} aria-hidden="true" />
          <span className={styles.trialText}>Ends {formatDay(trial.accessUntil)}</span>
          <span className={styles.trialCta}>Resume</span>
        </a>
      );
    }
    return (
      <a
        href={`/api/billing/checkout${planQ}`}
        className={`${styles.trialPill} ${styles.trialPillExpired}`}
        title="Your plan has ended — resubscribe to get Yoinky and the Telegram agent back."
      >
        <span className={styles.trialDot} aria-hidden="true" />
        <span className={styles.trialText}>Plan ended</span>
        <span className={styles.trialCta}>Resubscribe</span>
      </a>
    );
  }

  const expired = status === "expired";
  // Trialing → add a card (auto-charges when the trial ends); expired → charge now.
  const href = expired ? `/api/billing/checkout${planQ}` : `/api/billing/start-trial${planQ}`;
  const days = trial.daysLeft === 1 ? "1 day" : `${trial.daysLeft} days`;

  return (
    <a
      href={href}
      className={`${styles.trialPill} ${expired ? styles.trialPillExpired : ""}`}
      title={
        expired
          ? "Your free trial has ended — upgrade to keep Yoinky and the Telegram agent."
          : "Add a card now and you won't be charged until your trial ends."
      }
    >
      <span className={styles.trialDot} aria-hidden="true" />
      <span className={styles.trialText}>{expired ? "Trial ended" : `${days} left`}</span>
      <span className={styles.trialCta}>{expired ? "Upgrade" : "Add card"}</span>
    </a>
  );
}

/** "12 Mar" — short enough for a nav pill, unambiguous enough for a billing date. */
function formatDay(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : "";
}
