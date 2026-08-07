"use client";

import panel from "./panel.module.css";

/**
 * The shared "this page didn't load" surface, in the same visual language as the
 * app's empty states (panel.module.css) rather than Next's bare "Application
 * error" screen - which is what every uncaught page-level DB read used to render:
 * no shell, no explanation, and no way back.
 *
 * `onRetry` is the boundary's own `reset()` where there is one (error.tsx), which
 * re-renders the failed segment without a full reload - the right first move for
 * a transient database or upstream hiccup.
 */
export function ErrorState({
  title,
  message,
  digest,
  onRetry,
  homeHref = "/app",
  homeLabel = "Back to Yoinky",
}: {
  title: string;
  message: string;
  digest?: string;
  onRetry?: () => void;
  homeHref?: string;
  homeLabel?: string;
}) {
  return (
    <div className={panel.page}>
      <div className={panel.inner}>
        <div className={panel.empty}>
          <div className={panel.emptyTitle}>{title}</div>
          <p>{message}</p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap", marginTop: 20 }}>
            {onRetry && (
              <button type="button" className="btnPrimary" onClick={onRetry}>
                Try again
              </button>
            )}
            <a className="btnGhost" href={homeHref}>
              {homeLabel}
            </a>
          </div>
          {/* Next's error digest is the only handle support has on a production
           *  stack trace, so it has to be on screen - quietly. */}
          {digest && <p style={{ marginTop: 16, fontSize: 11, color: "var(--ink-500)" }}>reference {digest}</p>}
        </div>
      </div>
    </div>
  );
}
