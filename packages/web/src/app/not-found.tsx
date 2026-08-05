import { ErrorState } from "@/components/error-state";

/**
 * 404. Renders inside the root layout only (a missing /app/* route never reaches
 * the app shell), so it deliberately points back at Compose - the app's landing
 * surface - rather than at the marketing site.
 */
export default function NotFound() {
  return (
    <ErrorState
      title="There's nothing here."
      message="That link doesn't point at a page. It may have moved, or never existed."
      homeLabel="Go to Yoinky"
    />
  );
}
