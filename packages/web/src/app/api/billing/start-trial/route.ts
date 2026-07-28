import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { billingOverview, createCheckout, setIntendedPlan, config } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * "Add payment" — the in-app card capture. Reached from the trial banner and
 * Settings → Billing, AFTER the user has seen the product. It opens the Dodo
 * subscription-with-trial checkout: the card is collected now but not charged
 * until the trial ends, when Dodo auto-charges and converts to paid.
 *
 * The Dodo trial length is the user's REMAINING local trial days, so adding a
 * card on day 5 still charges on day 7 (no free-period extension). A user whose
 * trial already lapsed gets no trial here — they're charged immediately (this
 * doubles as the plain upgrade for the expired state).
 *
 * Robustness: the local `trialing` row already grants access, so if Dodo isn't
 * configured or the call fails, we fall back to the app.
 *
 * Like /api/billing/checkout, a user who already has a Dodo subscription is sent
 * to the portal rather than allowed to mint a second one.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", origin));

  const planParam = new URL(req.url).searchParams.get("plan");
  const plan: "paid" | "scale" | "founding" | "lifetime" =
    planParam === "founding"
      ? "founding"
      : planParam === "scale"
        ? "scale"
        // Lifetime is a ONE-TIME product — createCheckout omits subscription_data
        // for it, so it never carries a trial and never renews.
        : planParam === "lifetime"
          ? "lifetime"
          : "paid";
  if (planParam) await setIntendedPlan(user.id, planParam).catch(() => {});

  try {
    // One read for both the duplicate-subscription check and the trial days —
    // billingOverview already carries trialInfo.
    const ov = await billingOverview(user.id).catch(() => null);
    if (ov?.hasDodoSubscription) {
      return NextResponse.redirect(new URL("/api/billing/portal", origin));
    }
    const info = ov?.trial ?? null;
    const trialDays = info?.onTrial ? Math.max(1, info.daysLeft) : 0;
    const { url } = await createCheckout(user.id, user.email, plan, {
      ...(trialDays > 0 ? { trialDays } : {}),
      // Web buyers return to Settings, not to the Telegram bot that
      // CHECKOUT_RETURN_URL points at in production.
      returnUrl: `${config.WEB_APP_URL}/app/settings`,
    });
    return NextResponse.redirect(url);
  } catch (err) {
    console.error("start-trial checkout failed (falling back to local trial)", err);
    return NextResponse.redirect(new URL("/app/settings?billing_error=1", origin));
  }
}
