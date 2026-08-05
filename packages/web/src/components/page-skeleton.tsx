import styles from "./page-skeleton.module.css";

/**
 * A neutral loading placeholder shown while a new app page's server component
 * fetches its data (wired via the App Router `loading.tsx` files). It mirrors the
 * common panel layout - a header plus a few cards - so navigation feels instant:
 * the shell and this skeleton paint immediately, then the real page swaps in.
 */
export function PageSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div className={styles.page} aria-hidden="true">
      <div className={styles.inner}>
        <div className={styles.head}>
          <div className={`${styles.block} ${styles.title}`} />
          <div className={`${styles.block} ${styles.subtitle}`} />
        </div>
        {Array.from({ length: cards }).map((_, i) => (
          <div key={i} className={styles.card}>
            <div className={`${styles.block} ${styles.line} ${styles.w40}`} />
            <div className={`${styles.block} ${styles.line} ${styles.w90}`} />
            <div className={`${styles.block} ${styles.line} ${styles.w70}`} />
            <div className={`${styles.block} ${styles.line} ${styles.w60}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
