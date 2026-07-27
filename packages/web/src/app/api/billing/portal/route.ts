import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { billingOverview, createCustomerPortal, config } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Open the Dodo customer portal so the user can change/upgrade/cancel their
 * plan and update their card. Reached from Settings → Billing. If there's no
 * Dodo customer on file yet (they never added a card), we route them to
 * start-trial instead, which collects one.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", origin));

  try {
    const ov = await billingOverview(user.id);
    if (!ov.dodoCustomerId) {
      return NextResponse.redirect(new URL("/api/billing/start-trial", origin));
    }
    // Back to Settings, not to the Telegram bot that CHECKOUT_RETURN_URL points
    // at in production — cancelling from the web app should return to the web app.
    const { url } = await createCustomerPortal(ov.dodoCustomerId, `${config.WEB_APP_URL}/app/settings`);
    return NextResponse.redirect(url);
  } catch (err) {
    console.error("billing portal failed", err);
    return NextResponse.redirect(new URL("/app/settings?billing_error=1", origin));
  }
}
