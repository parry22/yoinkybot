import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { setIntendedPlan } from "@yoink/backend/web";

export const dynamic = "force-dynamic";

/** Params the X OAuth callback lands on /app with, and that the Connect-X gate
 *  in the layout reads. They have to survive the bounce to Compose. */
const CONNECT_PARAMS = ["connected", "connect_error"] as const;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// The app landing. Agent is a section (Compose + Automation), not a page, so we
// send people to Compose. The Connect-X gate in the layout still fires here.
// If we arrived from a landing-page plan CTA (?plan=growth|scale|founding), we
// record the chosen plan on the trial before bouncing on.
//
// This redirect used to be a bare `redirect("/app/compose")`, which dropped the
// query string entirely. `/api/auth/x/callback` lands here as `/app?connected=x`
// (or `/app?connect_error=1`), so the drop meant the gate never saw either: the
// post-connect "Reading your X" state was unreachable dead code, and a failed
// OAuth was completely silent — the user was bounced into the app with no idea
// the connect hadn't worked. Anything the gate reads must be forwarded.
export default async function AppIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const plan = one(sp.plan);
  if (plan) {
    const user = await getSessionUser();
    if (user) await setIntendedPlan(user.id, plan).catch(() => {});
  }

  const forward = new URLSearchParams();
  for (const key of CONNECT_PARAMS) {
    const value = one(sp[key]);
    if (value) forward.set(key, value);
  }
  const qs = forward.toString();
  redirect(qs ? `/app/compose?${qs}` : "/app/compose");
}
