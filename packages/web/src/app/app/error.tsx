"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Error boundary for the app pages. It lives under app/app/layout.tsx, so a page
 * that throws (an uncaught getAnalytics / getGrowthState / buyerRadarStatus read,
 * say) loses only the panel - the sidebar, top bar and navigation stay up and the
 * user can move somewhere else. Without it those throws fell all the way to the
 * root boundary and took the whole shell with them.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("app page error", error);
  }, [error]);

  return (
    <ErrorState
      title="This page didn't load."
      message="Yoinky couldn't fetch what it needed just now. Nothing is lost - try again, or head somewhere else in the app."
      digest={error.digest}
      onRetry={reset}
    />
  );
}
