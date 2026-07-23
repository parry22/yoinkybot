import type { TrialInfo } from "@yoink/backend/web";

/**
 * Slim top strip that surfaces the free-trial clock. While the trial runs it
 * invites the user to add a card ("keep going after your trial") — card capture
 * happens here, inside the app, not at signup. Once the trial has ended it's a
 * firm upgrade prompt. A card-on-file (Dodo-backed) subscription reads as active
 * and shows nothing. The plan is the one picked on the landing page.
 */
export function TrialBanner({ trial }: { trial: TrialInfo }) {
  if (trial.status !== "trialing" && trial.status !== "expired") return null;
  const expired = trial.status === "expired";
  const planQ = trial.intendedPlan ? `?plan=${encodeURIComponent(trial.intendedPlan)}` : "";
  // Trialing → add a card (auto-charges when the trial ends); expired → charge now.
  const href = expired ? `/api/billing/checkout${planQ}` : `/api/billing/start-trial${planQ}`;
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
          : `🎁 ${days} left in your free trial. Add a card to keep it going — you won't be charged until it ends.`}
      </span>
      <a
        href={href}
        style={{
          display: "inline-flex",
          alignItems: "center",
          height: 28,
          padding: "0 14px",
          borderRadius: 999,
          fontSize: 12.5,
          fontWeight: 500,
          textDecoration: "none",
          whiteSpace: "nowrap",
          background: expired ? "#fff" : "var(--accent)",
          color: expired ? "var(--accent)" : "#fff",
        }}
      >
        {expired ? "Upgrade" : "Add payment"}
      </a>
    </div>
  );
}
