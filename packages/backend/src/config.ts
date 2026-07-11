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

  // OpenRouter — the only LLM route. One model for every request (no tiers, no
  // fallback chain). Set MODEL_CHAT to switch models without a code change.
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  MODEL_CHAT: z.string().default("z-ai/glm-5.2"),
  // Comma-separated OpenRouter provider names to exclude when picking a GLM host
  // (spec: US/EU hosts only). Tighten or clear via env without a code change.
  OPENROUTER_PROVIDER_IGNORE: z.string().default("Baidu,Alibaba,StreamLake"),

  // Embeddings are separate from the chat model (GLM 5.2 is chat-only): OpenAI
  // when OPENAI_API_KEY is set, else Qwen/DashScope (OpenAI-compatible mode).
  EMBEDDING_MODEL: z.string().default("text-embedding-3-large"),
  EMBEDDING_DIMS: z.coerce.number().default(1536),
  QWEN_API_KEY: z.string().optional(),
  QWEN_BASE_URL: z.string().default("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
  QWEN_EMBEDDING_MODEL: z.string().default("text-embedding-v4"),

  TAVILY_API_KEY: z.string().optional(),

  // Trends subsystem — provider chosen by TREND_PROVIDER, with ordered fallback.
  // "x_api" was never implemented — dropped from the enum so a misconfigured
  // instance fails loudly at boot instead of silently having no trends provider.
  TREND_PROVIDER: z.enum(["apify", "brave", "tavily"]).default("apify"),
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

  // ── Bounded agent loops (see llm/tool-loop.ts). Hard caps, never open-ended. ──
  // Chat brain: max tool calls in one conversational turn (converse.v3).
  MAX_TOOL_CALLS_PER_TURN: z.coerce.number().default(3),
  // Consistency check: embed-distance gap between the top-2 position matches
  // below which "which position is this even about" is genuinely ambiguous and
  // the agentic path runs instead of the single-shot compare.
  CONSISTENCY_AMBIGUITY_DELTA: z.coerce.number().default(0.08),
  // Below this confidence, the consistency agent's verdict is reported as
  // "no conflict" — a shaky catch erodes trust in every real one after it.
  CONSISTENCY_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.6),
  CONSISTENCY_MAX_TOOL_CALLS: z.coerce.number().default(3),
  // Engagement reply drafting agent.
  REPLY_AGENT_MAX_TOOL_CALLS: z.coerce.number().default(3),
  // Macro-moment (trend take) agent + its deterministic gates.
  TREND_TAKE_MAX_TOOL_CALLS: z.coerce.number().default(4),
  // buzzScore (trends/scoring.ts, components normalized 0..1) must clear this.
  BUZZ_THRESHOLD: z.coerce.number().default(0.5),
  // Max cosine distance between a trend and the user's nearest position for the
  // niche gate (was hardcoded 0.7 in trend-match; text-embedding-v4 puts
  // on-topic paraphrases around 0.55-0.65).
  NICHE_THRESHOLD: z.coerce.number().default(0.7),
  // twitterapi.io advanced_search pagination cap per query — $0.00015/tweet is
  // cheap per topic but not free at scale; never paginate unbounded.
  TWITTERAPI_SEARCH_PAGE_CAP: z.coerce.number().default(3),

  // ── Native scheduled posting (write access) ─────────────────────────────
  // OAuth 2.0 user-context credentials for PUBLISHING on the user's behalf —
  // separate from the read-only ingestion above (Apify/twitterapi.io scrape by
  // handle, no auth). Without these, scheduling still works but a due post
  // fails closed with "not connected for posting". Redirect URIs are built from
  // PUBLIC_URL (/oauth/x/callback, /oauth/linkedin/callback).
  //   X: OAuth 2.0 PKCE, scope tweet.write (needs a paid X API tier to post).
  //   LinkedIn: scope w_member_social (needs an approved LinkedIn dev app).
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),

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
