import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createCheckout, setIntendedPlan, config } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Signup lands here (Clerk's after-sign-up redirect). It starts the Dodo
 * subscription-with-trial: a checkout that collects a card now but doesn't
 * charge until the 7-day trial ends, at which point Dodo auto-charges and the
 * subscription converts to paid. We redirect the user to Dodo's hosted checkout.
 *
 * Robustness: `getSessionUser()` has already minted the local `trialing` row
 * (immediate access), so if Dodo isn't configured or the call fails, we fall
 * back to the app — the user still gets their 7-day trial, it just won't
 * auto-charge (they'll hit the upgrade wall when it lapses). Same if they
 * abandon the hosted checkout.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", origin));

  const planParam = new URL(req.url).searchParams.get("plan");
  const plan: "paid" | "founding" = planParam === "founding" ? "founding" : "paid";
  if (planParam) await setIntendedPlan(user.id, planParam).catch(() => {});

  try {
    const { url } = await createCheckout(user.id, user.email, plan, { trialDays: config.TRIAL_DAYS });
    return NextResponse.redirect(url);
  } catch (err) {
    console.error("start-trial checkout failed (falling back to local trial)", err);
    return NextResponse.redirect(new URL("/app", origin));
  }
}
