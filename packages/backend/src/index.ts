import Fastify from "fastify";
import { config, isDev } from "./config.js";
import { migrate } from "./db/migrate.js";
import { startBoss } from "./jobs/boss.js";
import { registerWorkers } from "./jobs/workers.js";
import { createBot } from "./telegram/bot.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { oauthRoutes } from "./routes/oauth.js";
import { analyticsEnabled, shutdownAnalytics } from "./analytics/posthog.js";

async function main(): Promise<void> {
  await migrate();

  const boss = await startBoss();
  await registerWorkers(boss);

  const bot = createBot();
  // Initialize eagerly: the webhook route calls bot.handleUpdate directly
  // (no webhookCallback), which requires botInfo to be loaded up front.
  if (bot) await bot.init();
  // The bot's own t.me link, derived from Telegram rather than hardcoded or
  // borrowed from an unrelated config value — always correct for whichever
  // token is actually configured.
  const botLink = bot ? `https://t.me/${bot.botInfo.username}` : "https://telegram.org";

  // Telegram-native: the only HTTP surface is health + webhooks.
  const app = Fastify({ logger: { level: isDev ? "info" : "warn" } });

  // `llm` reports whether the single LLM route is configured (key presence only,
  // never the key) — so "the bot replies but sounds like a broken robot" is
  // diagnosable with one curl instead of a log dive. Every conversational turn
  // needs OPENROUTER_API_KEY; without it the bot can only serve fallback lines.
  // `trends` does the same for the macro-moment pipeline (env drift on a deploy
  // once silently killed it): provider key presence, the buzz-gate key, and the
  // age of the last successful fetch.
  app.get("/health", async () => {
    const lastTrend = await import("./db/pool.js")
      .then(({ queryOne }) => queryOne<{ last: string | null }>(`SELECT max(fetched_at)::text AS last FROM trends`))
      .catch(() => null);
    return {
      ok: true,
      llm: Boolean(config.OPENROUTER_API_KEY),
      analytics: analyticsEnabled(),
      trends: {
        provider: Boolean(config.APIFY_TOKEN || config.BRAVE_API_KEY || config.TAVILY_API_KEY),
        buzz_gate: Boolean(config.TWITTERAPI_IO_KEY),
        last_fetch: lastTrend?.last ?? null,
      },
    };
  });
  // Telegram-only, no web dashboard — anyone landing on the bare domain in a
  // browser should bounce straight to the actual bot, not see a raw 404.
  app.get("/", async (_req, reply) => reply.redirect(botLink));
  await app.register(webhookRoutes);
  // Write-scope OAuth (posting). No-ops to 503 unless X_/LINKEDIN_ creds are set.
  await app.register(oauthRoutes);

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
      // Fire-and-forget by design (bot.start's promise only resolves on
      // shutdown) — but it must still be caught. If a webhook gets registered
      // elsewhere for this same token (e.g. a prod instance switching modes),
      // Telegram kills this poll with a 409 "terminated by setWebhook
      // request" — expected, not an operational problem, so log it locally
      // instead of letting it surface as an unhandled rejection that pages
      // the admin for something that isn't actually broken.
      bot.start({ onStart: () => console.log("telegram bot polling (dev)") }).catch((err) => {
        console.warn("polling loop ended (likely superseded by a webhook elsewhere):", err instanceof Error ? err.message : err);
      });
    }

    // The bot without an LLM key is a zombie: it delivers, but every turn falls
    // back to canned lines (exactly the "asks the same question forever" bug).
    // Scream at boot AND page the admin so this can never be a silent state.
    if (!config.OPENROUTER_API_KEY) {
      console.error(
        "OPENROUTER_API_KEY is NOT set — every conversational turn will fail into fallback lines. " +
          "Set it in the service env and redeploy. /health reports llm:false until then.",
      );
      void import("./lib/alerts.js").then(({ alertAdmin }) =>
        alertAdmin(
          "llm:unconfigured",
          "OPENROUTER_API_KEY is not set on this deploy — the bot is running but can only send canned fallback lines. Set it in the service env and redeploy.",
        ),
      );
    }
  }
}

// Render sends SIGTERM before a redeploy/spin-down. Flush any buffered
// analytics events so the ones captured in the last few seconds aren't lost;
// then exit and let the platform restart us.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    void shutdownAnalytics().finally(() => process.exit(0));
  });
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
