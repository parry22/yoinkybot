import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./webhook.js";

const rawSecret = Buffer.from("super-secret-signing-key");
const secret = `whsec_${rawSecret.toString("base64")}`;

function sign(id: string, ts: string, body: string): string {
  return `v1,${createHmac("sha256", rawSecret).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

describe("verifyWebhookSignature (Standard Webhooks)", () => {
  const body = JSON.stringify({ type: "subscription.active", data: { subscription_id: "sub_1" } });
  const now = 1_750_000_000;
  const ts = String(now);

  it("accepts a valid signature", () => {
    expect(
      verifyWebhookSignature({
        secret,
        webhookId: "msg_1",
        webhookTimestamp: ts,
        webhookSignature: sign("msg_1", ts, body),
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(true);
  });

  it("accepts when a valid sig is one of several space-separated entries", () => {
    const sig = `v2,bogus ${sign("msg_1", ts, body)}`;
    expect(
      verifyWebhookSignature({
        secret,
        webhookId: "msg_1",
        webhookTimestamp: ts,
        webhookSignature: sig,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyWebhookSignature({
        secret,
        webhookId: "msg_1",
        webhookTimestamp: ts,
        webhookSignature: sign("msg_1", ts, body),
        rawBody: body.replace("sub_1", "sub_2"),
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay protection)", () => {
    const oldTs = String(now - 3600);
    expect(
      verifyWebhookSignature({
        secret,
        webhookId: "msg_1",
        webhookTimestamp: oldTs,
        webhookSignature: sign("msg_1", oldTs, body),
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(
      verifyWebhookSignature({
        secret,
        webhookId: "",
        webhookTimestamp: ts,
        webhookSignature: sign("msg_1", ts, body),
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false);
  });
});
