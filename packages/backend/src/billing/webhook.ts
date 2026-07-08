import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * DodoPayments signs webhooks per the Standard Webhooks spec:
 * signed content = `${webhook-id}.${webhook-timestamp}.${rawBody}`,
 * HMAC-SHA256 with the base64-decoded secret (after the `whsec_` prefix),
 * compared against each space-separated `v1,<base64>` entry in webhook-signature.
 */
export function verifyWebhookSignature(params: {
  secret: string;
  webhookId: string;
  webhookTimestamp: string;
  webhookSignature: string;
  rawBody: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const { secret, webhookId, webhookTimestamp, webhookSignature, rawBody } = params;
  if (!secret || !webhookId || !webhookTimestamp || !webhookSignature) return false;

  const tolerance = params.toleranceSeconds ?? 5 * 60;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ts = Number(webhookTimestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) return false;

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key)
    .update(`${webhookId}.${webhookTimestamp}.${rawBody}`)
    .digest("base64");

  for (const entry of webhookSignature.split(" ")) {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}
