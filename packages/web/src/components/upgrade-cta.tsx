"use client";

/**
 * Inline upgrade prompt shown when a paid action is blocked - a 402
 * (upgrade_required, free/expired) or 429 (cap_reached, plan limit hit). Links
 * straight to the Dodo checkout for the target plan (default Scale, since caps
 * are what Scale removes). Reused across Buyer Radar, Automations, Scheduled.
 */
export function UpgradeCTA({ message, plan = "scale" }: { message?: string; plan?: "growth" | "scale" }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        padding: "10px 14px",
        borderRadius: 10,
        border: "0.5px solid var(--accent-border)",
        background: "var(--accent-soft)",
        fontSize: 13,
        color: "var(--ink-900)",
      }}
    >
      <span>{message ?? "This is a paid feature."}</span>
      <a
        href={`/api/billing/checkout?plan=${plan}`}
        className="btnPrimary"
        style={{ display: "inline-flex", alignItems: "center", textDecoration: "none", whiteSpace: "nowrap" }}
      >
        Upgrade to {plan === "scale" ? "Scale" : "Growth"}
      </a>
    </div>
  );
}
