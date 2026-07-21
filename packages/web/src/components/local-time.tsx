"use client";

/**
 * Renders an ISO timestamp in the viewer's local timezone. The server renders in
 * its own zone (UTC on Vercel) and the client re-renders in the browser's zone,
 * so `suppressHydrationWarning` silences the expected text mismatch - after
 * hydration the user always sees their own local time.
 */
export function LocalTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  const text = Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
  return <time dateTime={iso} suppressHydrationWarning>{text}</time>;
}
