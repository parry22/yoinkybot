import { PageSkeleton } from "@/components/page-skeleton";

/**
 * App Router loading UI: rendered inside the persistent app shell (sidebar +
 * top bar stay put) whenever a child route's server component is still
 * fetching. This is what makes moving between pages show a skeleton instead of
 * a blank pause.
 */
export default function AppLoading() {
  return <PageSkeleton />;
}
