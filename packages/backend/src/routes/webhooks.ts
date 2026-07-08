import type { FastifyInstance } from "fastify";
import { webhookCallback } from "grammy";
import { config } from "../config.js";
import { getBot } from "../telegram/bot.js";
import { verifyWebhookSignature } from "../billing/webhook.js";
import { handleDodoEvent } from "../billing/dodo.js";

/**
 * Webhook routes live in their own Fastify scope so we can keep the raw body
 * string (required for Dodo's Standard Webhooks signature) without affecting
 * JSON parsing anywhere else.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  app.post("/webhooks/dodo", async (req, reply) => {
    if (!config.DODO_WEBHOOK_SECRET) return reply.code(503).send({ error: "billing not configured" });
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const ok = verifyWebhookSignature({
      secret: config.DODO_WEBHOOK_SECRET,
      webhookId: String(req.headers["webhook-id"] ?? ""),
      webhookTimestamp: String(req.headers["webhook-timestamp"] ?? ""),
      webhookSignature: String(req.headers["webhook-signature"] ?? ""),
      rawBody,
    });
    if (!ok) return reply.code(401).send({ error: "bad signature" });
    await handleDodoEvent(JSON.parse(rawBody));
    return { ok: true };
  });

  // Only wire the webhook route when we actually intend to run in webhook mode
  // (see index.ts) — grammY's Bot instance can't be consumed by both
  // webhookCallback() and bot.start() (long polling) at once.
  const bot = getBot();
  const usingWebhooks = config.PUBLIC_URL.startsWith("https://");
  if (bot && config.TELEGRAM_BOT_TOKEN && usingWebhooks) {
    app.post(
      "/webhooks/telegram",
      webhookCallback(bot, "fastify", {
        secretToken: config.TELEGRAM_WEBHOOK_SECRET || undefined,
      }),
    );
  }
}
