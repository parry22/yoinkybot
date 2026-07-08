import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://localhost:5432/yoink"),
  PORT: z.coerce.number().default(3001),
  PUBLIC_URL: z.string().default("http://localhost:3001"),
  // Where Dodo sends users after checkout — no web app, so default to the bot.
  CHECKOUT_RETURN_URL: z.string().default("https://t.me"),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  // Operational alerts DM this Telegram user id via the bot (throttled). Optional.
  ADMIN_TELEGRAM_ID: z.string().optional(),

  SARVAM_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GROQ_STT_MODEL: z.string().default("whisper-large-v3-turbo"),

  ANTHROPIC_API_KEY: z.string().optional(),
  KIMI_API_KEY: z.string().optional(),
  KIMI_BASE_URL: z.string().default("https://api.moonshot.ai/v1"),
  KIMI_MODEL: z.string().default("kimi-k2.6"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-large"),
  EMBEDDING_DIMS: z.coerce.number().default(1536),

  // Qwen (DashScope, OpenAI-compatible mode) — stand-in provider covering both
  // LLM tiers and embeddings when dedicated Anthropic/Kimi/OpenAI keys aren't set.
  QWEN_API_KEY: z.string().optional(),
  QWEN_BASE_URL: z.string().default("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
  QWEN_MODEL_CHEAP: z.string().default("qwen-turbo"),
  QWEN_MODEL_FRONTIER: z.string().default("qwen-max"),
  QWEN_EMBEDDING_MODEL: z.string().default("text-embedding-v4"),

  TAVILY_API_KEY: z.string().optional(),

  // Trends subsystem — provider chosen by TREND_PROVIDER, with ordered fallback.
  TREND_PROVIDER: z.enum(["apify", "brave", "tavily", "x_api"]).default("apify"),
  // Actor ids verified against live Apify runs on 2026-07-04 — see
  // trends/providers/apify.ts and capture/imports/apify-profile.ts for the
  // exact input/output field shapes each one expects.
  APIFY_TOKEN: z.string().optional(),
  APIFY_X_ACTOR: z.string().default("kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest"),
  APIFY_LINKEDIN_ACTOR: z.string().default("harvestapi/linkedin-post-search"),
  // Profile-history actors for the strategist's connect+ingest (by handle/URL).
  APIFY_X_PROFILE_ACTOR: z.string().default("kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest"),
  APIFY_LINKEDIN_PROFILE_ACTOR: z.string().default("apimaestro/linkedin-profile-posts"),
  BRAVE_API_KEY: z.string().optional(),
  X_API_BEARER_TOKEN: z.string().optional(),

  // twitterapi.io — preferred X profile-ingestion source when set (richer than
  // the Apify actor: engagement counts, thread/reply context, bio + follower
  // count). Apify remains the fallback when this is unset. LinkedIn always
  // uses Apify; twitterapi.io is X-only.
  TWITTERAPI_IO_KEY: z.string().optional(),
  TWITTERAPI_IO_BASE_URL: z.string().default("https://api.twitterapi.io"),

  DODO_API_KEY: z.string().optional(),
  DODO_WEBHOOK_SECRET: z.string().optional(),
  DODO_ENV: z.enum(["test_mode", "live_mode"]).default("test_mode"),
  DODO_PRODUCT_PAID: z.string().optional(),
  DODO_PRODUCT_FOUNDING: z.string().optional(),
  // Off during testing → everyone gets full features. Set true to enforce plans.
  PAYWALL_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  NODE_ENV: z.string().default("development"),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

export const isDev = config.NODE_ENV !== "production";
