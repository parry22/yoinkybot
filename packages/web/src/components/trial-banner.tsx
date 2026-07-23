import type { TrialInfo } from "@yoink/backend/web";
import styles from "./topbar.module.css";

/**
 * Subtle trial pill that lives in the top nav bar (not a full-width strip).
 * While the trial runs it invites the user to add a card ("keep going after your
 * trial") — card capture happens here, inside the app, not at signup. Once the
 * trial has ended it firms up into an upgrade prompt. A card-on-file (Dodo-backed)
 * active subscription renders nothing. The plan is the one picked on the landing
 * page.
 */
export function TrialPill({ trial }: { trial: TrialInfo }) {
  if (trial.status !== "trialing" && trial.status !== "expired") return null;
  const expired = trial.status === "expired";
  const planQ = trial.intendedPlan ? `?plan=${encodeURIComponent(trial.intendedPlan)}` : "";
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
      <span className={styles.trialText}>
        {expired ? "Trial ended" : `${days} left`}
      </span>
      <span className={styles.trialCta}>{expired ? "Upgrade" : "Add card"}</span>
    </a>
  );
}
