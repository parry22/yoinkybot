import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createCheckout, setIntendedPlan, trialInfo } from "@yoink/backend/web";

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
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", origin));

  const planParam = new URL(req.url).searchParams.get("plan");
  const plan: "paid" | "scale" | "founding" =
    planParam === "founding" ? "founding" : planParam === "scale" ? "scale" : "paid";
  if (planParam) await setIntendedPlan(user.id, planParam).catch(() => {});

  try {
    const info = await trialInfo(user.id).catch(() => null);
    const trialDays = info?.onTrial ? Math.max(1, info.daysLeft) : 0;
    const { url } = await createCheckout(user.id, user.email, plan, trialDays > 0 ? { trialDays } : {});
    return NextResponse.redirect(url);
  } catch (err) {
    console.error("start-trial checkout failed (falling back to local trial)", err);
    return NextResponse.redirect(new URL("/app/settings?billing_error=1", origin));
  }
}
