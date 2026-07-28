import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { rateLimited } from "@/lib/rate-limit";
import { byokStatus, saveKey, deleteKey, KEY_PROVIDERS, type KeyProvider } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Saving validates the key against the provider first, which is a live call.
export const maxDuration = 60;

/**
 * BYOK key management for the lifetime plan.
 *
 * GET    → status (which keys are present + validated, last4 only)
 * POST   → { provider, key }  validate then store encrypted
 * DELETE → ?provider=…        remove one
 *
 * There is deliberately NO endpoint that returns a stored key. Once saved a key
 * can be replaced or deleted, never read back — `last4` is the only fragment
 * that ever leaves the database, so a compromised session can't exfiltrate the
 * user's live provider credentials.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await byokStatus(user.id));
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Each save is an outbound call to a third party; bounded like the other
  // money/network-touching routes.
  const limited = await rateLimited(user.id, "byok_save");
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as { provider?: unknown; key?: unknown };
  const provider = body.provider as KeyProvider;
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!KEY_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }
  if (!key) return NextResponse.json({ error: "Paste a key first." }, { status: 400 });

  try {
    const res = await saveKey(user.id, provider, key);
    if (!res.ok) return NextResponse.json({ error: res.reason ?? "Couldn't save that key." }, { status: 400 });
    return NextResponse.json({ ok: true, status: await byokStatus(user.id) });
  } catch (err) {
    // The most likely cause is a missing/short BYOK_ENCRYPTION_KEY, which
    // lib/crypto.ts throws on rather than storing a live key in plaintext.
    console.error("byok save failed", err);
    return NextResponse.json({ error: "Couldn't save that key on our side." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const provider = new URL(req.url).searchParams.get("provider") as KeyProvider | null;
  if (!provider || !KEY_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }
  await deleteKey(user.id, provider);
  return NextResponse.json({ ok: true, status: await byokStatus(user.id) });
}
