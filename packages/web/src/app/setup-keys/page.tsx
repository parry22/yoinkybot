import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { byokStatus } from "@yoink/backend/web";
import { SetupKeys } from "@/components/setup-keys";

export const dynamic = "force-dynamic";

export const metadata = { title: "Set up your keys | Yoinky" };

/**
 * The BYOK setup gate for the lifetime plan.
 *
 * Deliberately OUTSIDE `/app`: the app layout redirects here when keys are
 * missing, so living under that layout would make this page bounce to itself.
 * It also has no sidebar on purpose - there is nothing in the app to navigate to
 * until the keys are in.
 */
export default async function SetupKeysPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const status = await byokStatus(user.id);
  // Not on the plan that needs keys, or already done - nothing to do here.
  if (!status.required || status.complete) redirect("/app");

  return <SetupKeys initial={status} />;
}
