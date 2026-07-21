import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { saveBuyerIcp, ModerationError } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Accepts either a string[] or a comma-separated string for list fields. */
function toArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}
function toStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const view = await saveBuyerIcp(user.id, {
      product_oneliner: toStr(body.productOneliner),
      buyer_description: toStr(body.buyerDescription),
      pain_signals: toArray(body.painSignals),
      competitor_terms: toArray(body.competitorTerms),
      exclusions: toArray(body.exclusions),
    });
    return NextResponse.json(view);
  } catch (err) {
    if (err instanceof ModerationError) return NextResponse.json({ error: err.reason }, { status: 400 });
    throw err;
  }
}
