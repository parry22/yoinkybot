"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";
import "./globals.css";

/**
 * Last resort: a crash in the root layout itself, which replaces the entire
 * document — so this has to ship its own <html>/<body> and its own stylesheet
 * import (the root layout, and with it ClerkProvider and the theme script, never
 * ran). Without it Next renders an unstyled black-on-white "Application error".
 * Theme falls back to the OS preference here; the saved-theme script lives in the
 * layout that just failed.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("web global error", error);
  }, [error]);

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ErrorState
          title="Yoinky failed to start."
          message="Something broke before the app could load. Reloading usually clears it."
          digest={error.digest}
          onRetry={reset}
        />
      </body>
    </html>
  );
}
