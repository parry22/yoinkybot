import { SignUp } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

/**
 * Sign-up starts the 7-day free trial (the trial is minted on the first
 * authenticated request — see lib/session + backend findOrCreateUserByClerkId).
 * The landing page's plan CTAs arrive here as `?plan=growth|scale|founding`; we
 * forward that to /app so the chosen plan is recorded on the trial and the
 * in-app upgrade CTA is preselected.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>;
}) {
  const sp = await searchParams;
  const plan = Array.isArray(sp.plan) ? sp.plan[0] : sp.plan;
  const redirectUrl = plan ? `/app?plan=${encodeURIComponent(plan)}` : "/app";

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        background: "var(--main-bg)",
        padding: 24,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 20, fontWeight: 470, color: "var(--ink-900)" }}>
          <img src="/favicon.png" alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
          Yoinky
        </div>
        <div style={{ color: "var(--ink-700)", fontSize: 13 }}>Create your account — 7 days free, no card required.</div>
      </div>
      <SignUp signInUrl="/sign-in" forceRedirectUrl={redirectUrl} />
    </div>
  );
}
