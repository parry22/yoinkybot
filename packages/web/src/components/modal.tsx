"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import styles from "./modal.module.css";

/** Centered overlay card. `dismissible=false` disables backdrop/X close - for
 *  flows (like onboarding) that should only close via an explicit in-flow action. */
export function Modal({
  open,
  onClose,
  children,
  wide,
  dismissible = true,
}: {
  open: boolean;
  onClose?: () => void;
  children: React.ReactNode;
  wide?: boolean;
  dismissible?: boolean;
}) {
  if (!open) return null;
  return (
    <div className={styles.backdrop} onClick={dismissible ? onClose : undefined}>
      <div
        className={`${styles.card} ${wide ? styles.wide : ""}`}
        style={{ position: "relative" }}
        onClick={(e) => e.stopPropagation()}
      >
        {dismissible && onClose && (
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.8} />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
