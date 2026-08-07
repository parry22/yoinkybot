import Fastify from "fastify";
import { config, isDev } from "./config.js";
import { migrate } from "./db/migrate.js";
import { startBoss, stopBoss } from "./jobs/boss.js";
import { registerWorkers } from "./jobs/workers.js";
import { createBot } from "./telegram/bot.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { oauthRoutes } from "./routes/oauth.js";
import { analyticsEnabled, shutdownAnalytics } from "./analytics/posthog.js";

/**
 * Postgres error classes that mean "the database is not available right now",
 * as opposed to "your SQL is wrong". 53xxx is insufficient_resources - which is
 * what Neon returns (53000) when a project has burned its compute-time quota.
 * 57P0x is admin shutdown / crash recovery, 08xxx is connection failure.
 */
function isDatabaseUnavailable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? "";
  return (
    code.startsWith("53") ||
    code.startsWith("08") ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"].includes(code)
  );
}

/**
 * Migrate, but never turn a database outage into a restart storm.
 *
 * WHAT HAPPENED ON 2026-07-30. Neon cut the database off for exceeding its
 * compute-time quota. `migrate()` threw PG 53000 on line one of main(), the
 * bottom-of-file `.catch` called process.exit(1), Railway restarted the
 * container, and it threw again - 22 times in one log window. Every one of those
 * restarts opened a fresh pool, ran pg-boss's schema check, re-declared 27
 * queues and fired both boot nudges, all aimed at a database that was already
 * over its compute budget. The crash loop was actively feeding the outage it was
 * caused by, and it kept the endpoint pinned awake so the quota could never
 * recover on its own.
 *
 * So: back off patiently when the database is merely unavailable, and let the
 * process live. A broken migration still fails fast and loudly, because that is a
 * deterministic error a retry cannot fix - the distinction is the whole point.
 */
async function migrateWithBackoff(): Promise<void> {
  const MAX_DELAY_MS = 60_000;
  let delay = 2_000;
  let attempt = 0;

  for (;;) {
    try {
      await migrate();
      if (attempt > 0) console.log(`migrations applied after ${attempt} retr${attempt === 1 ? "y" : "ies"}`);
      return;
    } catch (err) {
      if (!isDatabaseUnavailable(err)) throw err; // real migration bug - surface it
      attempt++;
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `database unavailable (attempt ${attempt}) - retrying in ${Math.round(delay / 1000)}s: ${detail}`,
      );
      // Page the operator once, early. This is the state where the product is
      // fully down and nothing in the app itself is wrong, which is exactly the
      // case that took hours to diagnose the first time.
      if (attempt === 3) {
        void import("./lib/alerts.js").then(({ alertAdmin }) =>
          alertAdmin(
            "db:unavailable",
            `Backend cannot reach Postgres: ${detail}. If this is Neon reporting a compute-time quota (PG 53000), the plan needs upgrading - the app is fully down until then.`,
          ),
        );
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}

async function main(): Promise<void> {
  await migrateWithBackoff();

  const { markWorkersBooted } = await import("./jobs/health.js");
  markWorkersBooted();

  const boss = await startBoss();
  await registerWorkers(boss);

  const bot = createBot();
  // Initialize eagerly: the webhook route calls bot.handleUpdate directly
  // (no webhookCallback), which requires botInfo to be loaded up front.
  if (bot) await bot.init();
  // The bot's own t.me link, derived from Telegram rather than hardcoded or
  // borrowed from an unrelated config value - always correct for whichever
  // token is actually configured.
  const botLink = bot ? `https://t.me/${bot.botInfo.username}` : "https://telegram.org";

  // Telegram-native: the only HTTP surface is health + webhooks.
  const app = Fastify({ logger: { level: isDev ? "info" : "warn" } });

  // `llm` reports whether the selected LLM transport is configured (key presence
  // only, never the key) - so "the bot replies but sounds like a broken robot" is
  // diagnosable with one curl instead of a log dive. `trends` does the same for
  // the macro-moment pipeline (env drift on a deploy once silently killed it):
  // provider key presence, the buzz-gate key, and the age of the last successful
  // fetch. DB ping failure returns HTTP 503 so orchestrators stop routing traffic.
  const llmConfigured =
    config.LLM_TRANSPORT === "xai" ? Boolean(config.XAI_API_KEY) : Boolean(config.OPENROUTER_API_KEY);
  app.get("/health", async (_req, reply) => {
    const { queryOne } = await import("./db/pool.js");
    const {
      evaluateWorkerHealth,
      fetchQueueDepth,
      getWorkerHeartbeatAt,
      getWorkerHeartbeatMs,
    } = await import("./jobs/health.js");
    let dbOk = false;
    try {
      dbOk = Boolean(await queryOne(`SELECT 1`));
    } catch {
      dbOk = false;
    }
    const lastTrend = dbOk
      ? await queryOne<{ last: string | null }>(`SELECT max(fetched_at)::text AS last FROM trends`).catch(
          () => null,
        )
      : null;
    const depth = dbOk ? await fetchQueueDepth() : null;
    const heartbeatAt = getWorkerHeartbeatAt();
    const workerEval = dbOk
      ? evaluateWorkerHealth({ depth, heartbeatAt: getWorkerHeartbeatMs() })
      : { ok: false as const };
    const body = {
      ok: dbOk && workerEval.ok,
      llm: llmConfigured,
      analytics: analyticsEnabled(),
      trends: {
        provider: Boolean(config.APIFY_TOKEN || config.BRAVE_API_KEY || config.TAVILY_API_KEY),
        buzz_gate: Boolean(config.TWITTERAPI_IO_KEY),
        last_fetch: lastTrend?.last ?? null,
      },
      workers: {
        ok: workerEval.ok,
        depth: depth ?? { created: 0, retry: 0, active: 0, oldestAgeSec: null },
        oldestAgeSec: depth?.oldestAgeSec ?? null,
        heartbeatAt,
      },
    };
    if (!dbOk || !workerEval.ok) {
      if (dbOk && !workerEval.ok) {
        void import("./lib/alerts.js").then(({ alertAdmin }) =>
          alertAdmin("queue:stale", `Queue/worker health check failed: ${workerEval.reason ?? "unknown"}`),
        );
      }
      return reply.code(503).send(body);
    }
    return body;
  });
  // Telegram-only, no web dashboard - anyone landing on the bare domain in a
  // browser should bounce straight to the actual bot, not see a raw 404.
  app.get("/", async (_req, reply) => reply.redirect(botLink));
  await app.register(webhookRoutes);
  // Write-scope OAuth (posting). No-ops to 503 unless X_/LINKEDIN_ creds are set.
  await app.register(oauthRoutes);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`yoinky backend on :${config.PORT}`);

  // The production misconfiguration warnings (paywall off, colliding Dodo
  // product ids, localhost WEB_APP_URL) now live in config.ts and fire at module
  // load instead of here. This guard only ever ran in the backend process, and
  // the Next.js app imports the same config without executing this file - so the
  // one surface where a disabled paywall does the most damage was the surface
  // that never got warned.

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
      // shutdown) - but it must still be caught. If a webhook gets registered
      // elsewhere for this same token (e.g. a prod instance switching modes),
      // Telegram kills this poll with a 409 "terminated by setWebhook
      // request" - expected, not an operational problem, so log it locally
      // instead of letting it surface as an unhandled rejection that pages
      // the admin for something that isn't actually broken.
      bot.start({ onStart: () => console.log("telegram bot polling (dev)") }).catch((err) => {
        console.warn("polling loop ended (likely superseded by a webhook elsewhere):", err instanceof Error ? err.message : err);
      });
    }

    // The bot without an LLM key is a zombie: it delivers, but every turn falls
    // back to canned lines (exactly the "asks the same question forever" bug).
    // Scream at boot AND page the admin so this can never be a silent state.
    // Check the key for whichever transport is selected (OpenRouter vs xAI).
    if (!llmConfigured) {
      const keyName = config.LLM_TRANSPORT === "xai" ? "XAI_API_KEY" : "OPENROUTER_API_KEY";
      console.error(
        `${keyName} is NOT set (LLM_TRANSPORT=${config.LLM_TRANSPORT}) - every conversational turn will fail into fallback lines. ` +
          "Set it in the service env and redeploy. /health reports llm:false until then.",
      );
      void import("./lib/alerts.js").then(({ alertAdmin }) =>
        alertAdmin(
          "llm:unconfigured",
          `${keyName} is not set on this deploy (LLM_TRANSPORT=${config.LLM_TRANSPORT}) - the bot is running but can only send canned fallback lines. Set it in the service env and redeploy.`,
        ),
      );
    }
  }
}

// The platform sends SIGTERM before a redeploy. Stop pg-boss so in-flight jobs
// finish cleanly, flush buffered analytics, then exit for the restart.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    void stopBoss()
      .catch((err) => console.error("stopBoss failed", err))
      .finally(() => {
        void shutdownAnalytics().finally(() => process.exit(0));
      });
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
