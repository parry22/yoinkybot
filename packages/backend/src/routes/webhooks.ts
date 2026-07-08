import type { FastifyInstance } from "fastify";
import { webhookCallback } from "grammy";
import { config } from "../config.js";
import { getBot } from "../telegram/bot.js";
import { verifyWebhookSignature } from "../billing/webhook.js";
import { handleDodoEvent } from "../billing/dodo.js";

/**
 * Webhook routes. The Dodo route needs the raw body string (Standard Webhooks
 * signature verification), while the Telegram route needs the default parsed
 * JSON body — so the raw-body parser is confined to a nested scope around the
 * Dodo route only.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // The raw-string parser exists solely for Dodo's signature check, so it lives
  // in its own encapsulated scope. If it leaked to the Telegram route, grammY
  // would receive the update as a string, match nothing, and drop every message
  // with a silent 200.
  await app.register(async (dodo) => {
    dodo.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      done(null, body);
    });

    dodo.post("/webhooks/dodo", async (req, reply) => {
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
