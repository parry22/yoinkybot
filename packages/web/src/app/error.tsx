"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Route-level error boundary for everything outside the app shell (the landing
 * redirect, sign-in/sign-up, and any /app page whose own layout failed to
 * render). Errors inside the shell are caught closer, by app/app/error.tsx, so
 * the sidebar survives them.
 */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("web route error", error);
  }, [error]);

  return (
    <ErrorState
      title="Something went wrong."
      message="That page didn't load. It's usually momentary — try again, and if it keeps happening we'd like to hear about it."
      digest={error.digest}
      onRetry={reset}
    />
  );
}
