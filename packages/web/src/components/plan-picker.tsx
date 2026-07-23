import styles from "./plan-picker.module.css";

type PlanKey = "growth" | "scale" | "founding";

/**
 * The plan chooser in Settings → Plan & billing. Surfaces Growth and Scale
 * side by side, marks the one the user is on, and offers an explicit path to
 * move onto Scale — the option that was missing before. Before a card is on
 * file (trial / expired / free) each card starts the right checkout; once a
 * Dodo subscription exists, plan changes go through the customer portal so we
 * never mint a duplicate subscription.
 */
export function PlanPicker({
  currentKey,
  onTrial,
  hasSubscription,
  growthPrice,
}: {
  currentKey: PlanKey;
  onTrial: boolean;
  hasSubscription: boolean;
  growthPrice: string;
}) {
  const base = onTrial ? "/api/billing/start-trial" : "/api/billing/checkout";

  const cards: { key: PlanKey; name: string; price: string; blurb: string; features: string[] }[] = [
    {
      key: "growth",
      name: "Growth",
      price: growthPrice,
      blurb: "The full Yoinky brain for building your brand.",
      features: ["Voice-matched drafts", "Auto Agent automations", "Buyers Radar + Analytics", "Telegram agent"],
    },
    {
      key: "scale",
      name: "Scale",
      price: "Higher tier",
      blurb: "For accounts shipping every day and running more agents.",
      features: ["Everything in Growth", "Higher automation caps", "More proactive nudges", "Priority processing"],
    },
  ];

  return (
    <div className={styles.grid}>
      {cards.map((c) => {
        const isCurrent = c.key === currentKey;
        // The card's action: current + subscribed = nothing to do; switching
        // while subscribed goes through the portal; otherwise start checkout.
        const href = isCurrent && hasSubscription ? null : hasSubscription ? "/api/billing/portal" : `${base}?plan=${c.key}`;
        const ctaLabel = hasSubscription
          ? isCurrent
            ? null
            : `Switch to ${c.name}`
          : onTrial
            ? `Choose ${c.name}`
            : `Get ${c.name}`;
        return (
          <div key={c.key} className={`${styles.card} ${isCurrent ? styles.cardCurrent : ""}`}>
            <div className={styles.cardTop}>
              <span className={styles.name}>{c.name}</span>
              {isCurrent && <span className={styles.badge}>Current</span>}
            </div>
            <div className={styles.price}>{c.price}</div>
            <div className={styles.blurb}>{c.blurb}</div>
            <ul className={styles.features}>
              {c.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {href && ctaLabel ? (
              <a href={href} className={isCurrent ? styles.ctaGhost : styles.cta}>
                {ctaLabel}
              </a>
            ) : (
              <span className={styles.ctaDisabled}>You're on this plan</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
