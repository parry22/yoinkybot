import styles from "./agent-shimmer.module.css";

/**
 * The "what the agent is doing right now" indicator that replaces the old
 * three-dot typing bubble and the append-only tick list. One line of grayish
 * text - the current stage label ("Retrieving relevant memories", "Drafting
 * angle hooks", …) - with a light band sweeping across the glyphs, so a turn in
 * flight always reads as active work rather than a hang. The label is whatever
 * stage the stream last emitted; callers pass the current one.
 */
export function AgentShimmer({ label }: { label: string }) {
  return (
    <div className={styles.wrap} role="status" aria-live="polite">
      <span key={label} className={styles.text}>
        {label}
      </span>
    </div>
  );
}
