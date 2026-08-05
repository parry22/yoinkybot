import styles from "./plan-picker.module.css";

type PlanKey = "open_source" | "growth" | "scale" | "founding";

const GITHUB_URL = "https://github.com/parry22/yoinkybot";

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
 * Both prices now come from config (PAID_PRICE_LABEL / SCALE_PRICE_LABEL) -
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
  selfHosted,
}: {
  currentKey: PlanKey;
  onTrial: boolean;
  hasSubscription: boolean;
  growthPrice: string;
  growthWas: string;
  scalePrice: string;
  scaleWas: string;
  selfHosted: boolean;
}) {
  const base = onTrial ? "/api/billing/start-trial" : "/api/billing/checkout";

  const cards: {
    key: PlanKey;
    name: string;
    price: string;
    was: string;
    blurb: string;
    features: string[];
    /** The visually promoted hosted card. */
    featured?: boolean;
    /** Replaces the unit parsed from the price. */
    unitOverride?: string;
    note?: string;
  }[] = [
    {
      key: "open_source",
      name: "Open Source",
      price: "$0",
      was: "",
      unitOverride: "self-hosted",
      blurb: "Run the complete Yoinky codebase on your own infrastructure.",
      features: [
        "Web app and Telegram agent",
        "Bring your own AI and research API keys",
        "Connect your own X and LinkedIn apps",
        "Your database, infrastructure, and data",
        "MIT licensed and community supported",
      ],
    },
    {
      key: "growth",
      name: "Growth",
      price: growthPrice,
      was: growthWas,
      blurb: "The full Yoinky brain for building your brand.",
      // Concrete, and the same numbers the landing page shows and
      // billing/entitlements.ts actually enforces - the old vague copy ("higher
      // automation caps") had no relationship to what the code allowed.
      features: [
        "Unlimited voice-matched drafts",
        "Auto Agent: 30 posts per platform / month (you approve each)",
        "Buyer radar: 25 leads / month",
        "30 scheduled posts / month, with media",
        "Telegram agent",
      ],
      featured: true,
    },
    {
      key: "scale",
      name: "Scale",
      price: scalePrice,
      was: scaleWas,
      blurb: "For accounts shipping every day and running more agents.",
      features: [
        "Everything in Growth",
        "Auto Agent: 90 posts per platform / month, hands-off",
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
        const isOpenSource = c.key === "open_source";

        let href: string | null;
        let ctaLabel: string | null;
        if (isOpenSource) {
          href = GITHUB_URL;
          ctaLabel = "View on GitHub";
        } else if (selfHosted) {
          href = `https://app.meetyoinky.com/sign-up?plan=${c.key}`;
          ctaLabel = `Try managed ${c.name}`;
        } else if (isCurrent) {
          href = null;
          ctaLabel = null;
        } else if (hasSubscription) {
          href = "/api/billing/portal";
          ctaLabel = `Switch to ${c.name}`;
        } else {
          href = `${base}?plan=${c.key}`;
          ctaLabel = onTrial ? `Choose ${c.name}` : `Get ${c.name}`;
        }
        const { amount, unit } = splitPrice(c.price);
        const shownUnit = c.unitOverride ?? unit;
        return (
          <div
            key={c.key}
            className={`${styles.card} ${isCurrent ? styles.cardCurrent : ""} ${c.featured ? styles.cardFeatured : ""}`}
          >
            <div className={styles.cardTop}>
              <span className={styles.name}>{c.name}</span>
              {isCurrent ? (
                <span className={styles.badge}>Current</span>
              ) : (
                c.featured && <span className={styles.badge}>Best value</span>
              )}
            </div>
            <div className={styles.priceRow}>
              <span className={styles.price}>{amount}</span>
              {shownUnit && <span className={styles.priceUnit}>{shownUnit}</span>}
              {c.was && <span className={styles.priceWas}>{c.was}</span>}
            </div>
            {c.was && <div className={styles.priceNote}>Early-bird price, first 50 users</div>}
            {c.note && <div className={styles.priceNote}>{c.note}</div>}
            <div className={styles.blurb}>{c.blurb}</div>
            <ul className={styles.features}>
              {c.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {href && ctaLabel ? (
              <a
                href={href}
                className={isCurrent ? styles.ctaGhost : styles.cta}
                {...(isOpenSource ? { target: "_blank", rel: "noreferrer" } : {})}
              >
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
