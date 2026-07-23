import type { TrialInfo } from "@yoink/backend/web";

/**
 * Slim top strip that surfaces the free-trial clock: a soft countdown while the
 * trial runs, and a firm upgrade prompt once it has ended. Paying and pre-trial
 * accounts see nothing. "Upgrade" opens the Dodo checkout for the plan the user
 * picked on the landing page (falls back to the paid product).
 */
export function TrialBanner({ trial }: { trial: TrialInfo }) {
  if (trial.status !== "trialing" && trial.status !== "expired") return null;
  const expired = trial.status === "expired";
  const checkoutHref = `/api/billing/checkout${trial.intendedPlan ? `?plan=${encodeURIComponent(trial.intendedPlan)}` : ""}`;
  const days = trial.daysLeft === 1 ? "1 day" : `${trial.daysLeft} days`;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexWrap: "wrap",
        gap: 12,
        padding: "9px 16px",
        fontSize: 13,
        lineHeight: 1.4,
        color: "var(--ink-900)",
        background: expired ? "var(--accent)" : "var(--accent-soft)",
        borderBottom: "0.5px solid var(--accent-border)",
      }}
    >
      <span style={{ color: expired ? "#fff" : "var(--ink-900)" }}>
        {expired
          ? "Your free trial has ended — upgrade to keep using Yoinky and the Telegram agent."
          : `🎁 ${days} left in your free trial.`}
      </span>
      <a
        href={checkoutHref}
        style={{
          display: "inline-flex",
          alignItems: "center",
          height: 28,
          padding: "0 14px",
          borderRadius: 999,
          fontSize: 12.5,
          fontWeight: 500,
          textDecoration: "none",
          background: expired ? "#fff" : "var(--accent)",
          color: expired ? "var(--accent)" : "#fff",
        }}
      >
        Upgrade
      </a>
    </div>
  );
}
