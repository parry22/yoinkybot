import type { FastifyInstance } from "fastify";
import type { Update } from "grammy/types";
import { config } from "../config.js";
import { getBot } from "../telegram/bot.js";
import { verifyWebhookSignature } from "../billing/webhook.js";
import { handleDodoEvent } from "../billing/dodo.js";

/**
 * Webhook routes. The Dodo route needs the raw body string (Standard Webhooks
 * signature verification), while the Telegram route needs the default parsed
 * JSON body - so the raw-body parser is confined to a nested scope around the
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
      const webhookId = String(req.headers["webhook-id"] ?? "");
      const webhookTimestamp = String(req.headers["webhook-timestamp"] ?? "");
      const ok = verifyWebhookSignature({
        secret: config.DODO_WEBHOOK_SECRET,
        webhookId,
        webhookTimestamp,
        webhookSignature: String(req.headers["webhook-signature"] ?? ""),
        rawBody,
      });
      if (!ok) return reply.code(401).send({ error: "bad signature" });
      // The signed id and timestamp were verified and then thrown away. They are
      // the handler's idempotency key and its ordering clock - a retried delivery
      // used to be applied twice, and a late-arriving event could overwrite a
      // newer one. Both only work because the signature check above proves these
      // headers came from Dodo.
      await handleDodoEvent(JSON.parse(rawBody), { webhookId, webhookTimestamp });
      return { ok: true };
    });
  });

  // Only wire the webhook route when we actually intend to run in webhook mode
  // (see index.ts) - grammY's Bot instance can't be consumed by both a webhook
  // route and bot.start() (long polling) at once.
  //
  // The route acks Telegram IMMEDIATELY and processes the update detached.
  // grammY's webhookCallback awaits the full handler with a 10s timeout - but a
  // real turn (retrieval + LLM, worst case with retries) can run well past
  // that, and an unacked/failed webhook makes Telegram REDELIVER the update:
  // the whole turn replays and the user sees duplicate or ghost replies.
  // Because updates can also be redelivered across restarts, recently seen
  // update_ids are dropped (in-memory is correct: single instance by design).
  const bot = getBot();
  const usingWebhooks = config.PUBLIC_URL.startsWith("https://");
  if (bot && config.TELEGRAM_BOT_TOKEN && usingWebhooks) {
    // Fail closed: in webhook mode the secret is the ONLY thing stopping anyone
    // who knows the public URL from POSTing forged updates and acting as any
    // user (including wiping their data). An unset secret must abort boot, not
    // silently ship the endpoint wide open (the old `if (secret && …)` guard
    // meant "no secret configured" degraded to "accept everything").
    if (!config.TELEGRAM_WEBHOOK_SECRET) {
      throw new Error(
        "TELEGRAM_WEBHOOK_SECRET is required in webhook mode (PUBLIC_URL is https). " +
          "Without it the Telegram webhook accepts forged updates from anyone. Set it and redeploy.",
      );
    }
    const secret = config.TELEGRAM_WEBHOOK_SECRET;
    const seen = new Set<number>();
    const seenOrder: number[] = [];
    const SEEN_MAX = 5_000;

    app.post("/webhooks/telegram", async (req, reply) => {
      if (req.headers["x-telegram-bot-api-secret-token"] !== secret) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const update = req.body as Update | undefined;
      const id = update?.update_id;
      if (typeof id !== "number") return { ok: true };
      if (seen.has(id)) return { ok: true }; // redelivery - already handled
      seen.add(id);
      seenOrder.push(id);
      if (seenOrder.length > SEEN_MAX) seen.delete(seenOrder.shift()!);

      // Detached on purpose; bot.catch is the error boundary for handlers.
      void bot.handleUpdate(update as Update).catch((err) => {
        console.error("telegram update processing failed", err);
      });
      return { ok: true };
    });
  }
}
