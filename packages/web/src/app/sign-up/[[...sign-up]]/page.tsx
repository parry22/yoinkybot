import { SignUp } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

/**
 * Sign-up starts the 7-day free trial. After Clerk creates the account we send
 * the user to `/api/billing/start-trial`, which opens the Dodo
 * subscription-with-trial checkout (card collected now, auto-charged when the
 * trial ends). The landing plan CTAs arrive as `?plan=growth|scale|founding`
 * and ride along so the right product + intended plan are used. A local trial
 * row is also minted on first sign-in, so abandoning the checkout still grants
 * the 7 days (it just won't auto-charge).
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>;
}) {
  const sp = await searchParams;
  const plan = Array.isArray(sp.plan) ? sp.plan[0] : sp.plan;
  const redirectUrl = `/api/billing/start-trial${plan ? `?plan=${encodeURIComponent(plan)}` : ""}`;

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
        <div style={{ color: "var(--ink-700)", fontSize: 13 }}>Start your 7-day free trial — cancel anytime before it ends.</div>
      </div>
      <SignUp signInUrl="/sign-in" forceRedirectUrl={redirectUrl} />
    </div>
  );
}
