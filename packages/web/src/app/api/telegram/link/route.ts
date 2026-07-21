import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createTelegramLinkToken, config } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const token = await createTelegramLinkToken(user.id);
  const url = `${config.TELEGRAM_BOT_URL}?start=${token}`;
  return NextResponse.json({ url });
}
