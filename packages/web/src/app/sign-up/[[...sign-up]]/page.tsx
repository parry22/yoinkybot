import { SignUp } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

/**
 * Sign-up starts the 7-day free trial (no card up front - we collect it inside
 * the app once the user has seen the value). The trial row is minted on the
 * first authenticated request (lib/session → findOrCreateUserByClerkId →
 * startTrial); the user lands straight in /app with full access. The landing
 * plan CTAs arrive as `?plan=growth|scale|founding` and are recorded on /app so
 * the in-app "add payment" / upgrade CTA is preselected. Card capture +
 * auto-charge happen later via the Settings → Billing / trial-banner flow.
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
        <div style={{ color: "var(--ink-700)", fontSize: 13 }}>Start your 7-day free trial - no card required.</div>
      </div>
      <SignUp signInUrl="/sign-in" forceRedirectUrl={redirectUrl} />
    </div>
  );
}
