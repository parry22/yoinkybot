import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createCheckout } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Start a Dodo checkout for the signed-in user and redirect to the hosted
 * checkout page. Reached from the trial pill's "Upgrade" link and Settings.
 * `plan` mirrors the landing plans — founding, scale, or (default) the paid
 * Growth product.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", origin));

  const planParam = new URL(req.url).searchParams.get("plan");
  const plan: "paid" | "scale" | "founding" =
    planParam === "founding" ? "founding" : planParam === "scale" ? "scale" : "paid";

  try {
    const { url } = await createCheckout(user.id, user.email, plan);
    return NextResponse.redirect(url);
  } catch (err) {
    console.error("web checkout failed", err);
    return NextResponse.redirect(new URL("/app/settings?billing_error=1", origin));
  }
}
