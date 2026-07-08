import Fastify from "fastify";
import { config, isDev } from "./config.js";
import { migrate } from "./db/migrate.js";
import { startBoss } from "./jobs/boss.js";
import { registerWorkers } from "./jobs/workers.js";
import { createBot } from "./telegram/bot.js";
import { webhookRoutes } from "./routes/webhooks.js";

async function main(): Promise<void> {
  await migrate();

  const boss = await startBoss();
  await registerWorkers(boss);

  const bot = createBot();

  // Telegram-native: the only HTTP surface is health + webhooks.
  const app = Fastify({ logger: { level: isDev ? "info" : "warn" } });

  app.get("/health", async () => ({ ok: true }));
  await app.register(webhookRoutes);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`yoinky backend on :${config.PORT}`);

  if (bot) {
    const publicIsHttps = config.PUBLIC_URL.startsWith("https://");
    if (publicIsHttps) {
      await bot.api.setWebhook(`${config.PUBLIC_URL}/webhooks/telegram`, {
        secret_token: config.TELEGRAM_WEBHOOK_SECRET || undefined,
      });
      console.log("telegram webhook set");
    } else {
      // Local dev: no public HTTPS URL, fall back to long polling.
      await bot.api.deleteWebhook();
      void bot.start({ onStart: () => console.log("telegram bot polling (dev)") });
    }
  }
}

// Last-resort process guards: log + page the admin instead of dying silently.
// Import lazily so a broken bot module can't take the guards down with it.
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection", err);
  void import("./lib/alerts.js").then(({ alertAdmin }) =>
    alertAdmin("process:rejection", `unhandledRejection: ${err instanceof Error ? err.message : String(err)}`),
  );
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err);
  void import("./lib/alerts.js")
    .then(({ alertAdmin }) => alertAdmin("process:exception", `uncaughtException: ${err.message}`))
    .finally(() => process.exit(1));
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
