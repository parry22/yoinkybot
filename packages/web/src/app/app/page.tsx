import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { setIntendedPlan } from "@yoink/backend/web";

export const dynamic = "force-dynamic";

// The app landing. Agent is a section (Compose + Automation), not a page, so we
// send people to Compose. The Connect-X gate in the layout still fires here.
// If we arrived from a landing-page plan CTA (?plan=growth|scale|founding), we
// record the chosen plan on the trial before bouncing on.
export default async function AppIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>;
}) {
  const sp = await searchParams;
  const plan = Array.isArray(sp.plan) ? sp.plan[0] : sp.plan;
  if (plan) {
    const user = await getSessionUser();
    if (user) await setIntendedPlan(user.id, plan).catch(() => {});
  }
  redirect("/app/compose");
}
