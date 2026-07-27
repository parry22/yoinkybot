import styles from "./plan-picker.module.css";

type PlanKey = "growth" | "scale" | "founding";

/** Splits "$9/mo" into the number and its unit so the price can be typeset as a
 *  headline with a small trailing "/mo", rather than one flat 13px string. */
function splitPrice(label: string): { amount: string; unit: string } {
  const i = label.indexOf("/");
  return i === -1 ? { amount: label, unit: "" } : { amount: label.slice(0, i), unit: label.slice(i) };
}

/**
 * The plan chooser in Settings → Plan & billing. Surfaces Growth and Scale
 * side by side, marks the one the user is on, and offers an explicit path to
 * move onto Scale. Before a card is on file (trial / expired / free) each card
 * starts the right checkout; once a Dodo subscription exists, plan changes go
 * through the customer portal so we never mint a duplicate subscription.
 *
 * Both prices now come from config (PAID_PRICE_LABEL / SCALE_PRICE_LABEL) —
 * Scale used to render the literal string "Higher tier", which meant the one
 * screen where someone decides to pay more never told them what it cost.
 */
export function PlanPicker({
  currentKey,
  onTrial,
  hasSubscription,
  growthPrice,
  growthWas,
  scalePrice,
  scaleWas,
}: {
  currentKey: PlanKey;
  onTrial: boolean;
  hasSubscription: boolean;
  growthPrice: string;
  growthWas: string;
  scalePrice: string;
  scaleWas: string;
}) {
  const base = onTrial ? "/api/billing/start-trial" : "/api/billing/checkout";

  const cards: {
    key: PlanKey;
    name: string;
    price: string;
    was: string;
    blurb: string;
    features: string[];
  }[] = [
    {
      key: "growth",
      name: "Growth",
      price: growthPrice,
      was: growthWas,
      blurb: "The full Yoinky brain for building your brand.",
      // Concrete, and the same numbers the landing page shows and
      // billing/entitlements.ts actually enforces — the old vague copy ("higher
      // automation caps") had no relationship to what the code allowed.
      features: [
        "Unlimited voice-matched drafts",
        "Auto Agent: 5 posts / month (you approve each)",
        "Buyer radar: 25 leads / month",
        "30 scheduled posts / month, with media",
        "Telegram agent",
      ],
    },
    {
      key: "scale",
      name: "Scale",
      price: scalePrice,
      was: scaleWas,
      blurb: "For accounts shipping every day and running more agents.",
      features: [
        "Everything in Growth",
        "Auto Agent: 90 posts / month, hands-off",
        "Buyer radar: 300 leads / month",
        "Unlimited scheduled posts, with media",
        "Proactive resurfacing, 5 a week",
      ],
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
        const { amount, unit } = splitPrice(c.price);
        return (
          <div key={c.key} className={`${styles.card} ${isCurrent ? styles.cardCurrent : ""}`}>
            <div className={styles.cardTop}>
              <span className={styles.name}>{c.name}</span>
              {isCurrent && <span className={styles.badge}>Current</span>}
            </div>
            <div className={styles.priceRow}>
              <span className={styles.price}>{amount}</span>
              {unit && <span className={styles.priceUnit}>{unit}</span>}
              {c.was && <span className={styles.priceWas}>{c.was}</span>}
            </div>
            {c.was && <div className={styles.priceNote}>Early-bird price, first 50 users</div>}
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
              <span className={styles.ctaDisabled}>You&apos;re on this plan</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
