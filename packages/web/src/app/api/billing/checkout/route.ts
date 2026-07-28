import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { billingOverview, createCheckout, config } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Start a Dodo checkout for the signed-in user and redirect to the hosted
 * checkout page. Reached from the trial pill's "Upgrade" link and Settings.
 * `plan` mirrors the landing plans — founding, scale, or (default) the paid
 * Growth product.
 *
 * Anyone who ALREADY has a Dodo subscription is sent to the customer portal
 * instead. This route used to mint a second subscription unconditionally (the
 * portal route checked, this one didn't), and the on_hold path made that easy to
 * hit: a dunning customer got classified as an expired trialist, the pill
 * pointed here, and they ended up paying twice while Dodo was still retrying the
 * first card. The portal is also the right place to CHANGE plans, which is what
 * an existing subscriber clicking "upgrade" actually wants.
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

  try {
    const ov = await billingOverview(user.id);
    if (ov.hasDodoSubscription) {
      return NextResponse.redirect(new URL("/api/billing/portal", origin));
    }
    // Web buyers come back to Settings. The shared CHECKOUT_RETURN_URL points at
    // the Telegram bot in production, which is right for a Telegram buyer and
    // wrong for someone who never left the browser.
    const { url } = await createCheckout(user.id, user.email, plan, {
      returnUrl: `${config.WEB_APP_URL}/app/settings`,
    });
    return NextResponse.redirect(url);
  } catch (err) {
    console.error("web checkout failed", err);
    return NextResponse.redirect(new URL("/app/settings?billing_error=1", origin));
  }
}
