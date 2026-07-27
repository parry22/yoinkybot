import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://localhost:5432/yoink"),
  PORT: z.coerce.number().default(3001),
  PUBLIC_URL: z.string().default("http://localhost:3001"),
  // Where Dodo sends users after checkout. Web-first: default to the app's
  // Settings (Plan & billing), where the subscription state now lives. Override
  // per deployment if needed.
  CHECKOUT_RETURN_URL: z.string().default("https://app.meetyoinky.com/app/settings"),
  // The web app's own origin (packages/web) — a trusted allowlist for the
  // OAuth connect flow's optional `redirect` param (routes/oauth.ts), so a web
  // user lands back in Settings instead of the Telegram-flavored static page.
  // Only a `redirect` starting with this exact origin is ever honored.
  WEB_APP_URL: z.string().default("http://localhost:3002"),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  // Public t.me link to the bot — the web app's top-bar "Telegram" button points
  // here so users can jump straight into the bot. Override per deployment.
  TELEGRAM_BOT_URL: z.string().default("https://t.me/yoinkyybot"),
  // Operational alerts DM this Telegram user id via the bot (throttled). Optional.
  ADMIN_TELEGRAM_ID: z.string().optional(),

  SARVAM_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GROQ_STT_MODEL: z.string().default("whisper-large-v3-turbo"),

  // OpenRouter — the only LLM route. One model for every request (no tiers, no
  // fallback chain). Set MODEL_CHAT to switch models without a code change.
  // Grok 4.5 (2026-07-24, was z-ai/glm-5.2): native X/cultural awareness is the
  // product — drafts, trend takes, and buyer outreach all reason about what's
  // happening on X. Verified live on OpenRouter ($2/M in, $6/M out, 500k ctx).
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  MODEL_CHAT: z.string().default("x-ai/grok-4.5"),
  // Comma-separated OpenRouter provider names to exclude when picking a host
  // (spec: US/EU hosts only). Tighten or clear via env without a code change.
  OPENROUTER_PROVIDER_IGNORE: z.string().default("Baidu,Alibaba,StreamLake"),

  // ── LLM transport (Grok 4.5 cache-optimization spec §1) ──────────────────
  // 'openrouter' (default — current behavior, cross-provider retry) or 'xai'
  // (direct api.x.ai). xAI-direct unlocks the cache-affinity header
  // (x-grok-conv-id), cached_tokens in the usage payload, and reasoning_effort.
  // Flip to 'xai' ONLY after XAI_API_KEY is set; it's a one-env-var rollback.
  LLM_TRANSPORT: z.enum(["openrouter", "xai"]).default("openrouter"),
  XAI_API_KEY: z.string().optional(),
  XAI_BASE_URL: z.string().default("https://api.x.ai/v1"),
  // xAI's own model id (no vendor prefix). VERIFY the exact id in the xAI console
  // before flipping LLM_TRANSPORT=xai — it may be "grok-4.5" or a dated variant.
  XAI_MODEL: z.string().default("grok-4.5"),

  // ── Claude Agent SDK runtime (agent-runtime migration; docs/INTERNAL §3n) ──
  // The bounded agent loops (+ eventually the chat brain) can run on the Claude
  // Agent SDK instead of the bespoke llm/tool-loop.ts runner. The SDK spawns a
  // subprocess and talks the Anthropic Messages format, so it is routed through a
  // LiteLLM proxy → OpenRouter → grok-4.5 (any provider/key later). SDK mode is
  // RAILWAY-ONLY (it needs a real filesystem/subprocess — never Vercel).
  //   Per-feature runtime switch, default 'legacy' so nothing changes until a
  //   feature is deliberately flipped AFTER the Phase-0 spike passes.
  AGENT_RUNTIME_VIRAL: z.enum(["legacy", "sdk"]).default("legacy"),
  AGENT_RUNTIME_TREND_TAKE: z.enum(["legacy", "sdk"]).default("legacy"),
  AGENT_RUNTIME_CONSISTENCY: z.enum(["legacy", "sdk"]).default("legacy"),
  AGENT_RUNTIME_BUYER: z.enum(["legacy", "sdk"]).default("legacy"),
  AGENT_RUNTIME_REPLY: z.enum(["legacy", "sdk"]).default("legacy"),
  AGENT_RUNTIME_CHAT: z.enum(["legacy", "sdk"]).default("legacy"),
  //   LiteLLM proxy the SDK points at (ANTHROPIC_BASE_URL). Private Railway URL,
  //   e.g. http://litellm.railway.internal:4000. Empty → SDK mode fails loud.
  LITELLM_BASE_URL: z.string().default(""),
  //   Virtual key scoped to the agent models (NOT the LiteLLM master key).
  LITELLM_API_KEY: z.string().optional(),
  //   The LiteLLM `model_name` the SDK sends, and its fallback (both resolve to
  //   OpenRouter upstream in litellm-config.yaml).
  AGENT_MODEL: z.string().default("yoinky-agent"),
  AGENT_FALLBACK_MODEL: z.string().default("yoinky-agent-fallback"),
  //   Max concurrent SDK subprocesses — enforced by agent-runtime/capacity.ts.
  //   NO RAILWAY UPGRADE IS NEEDED for this. Measured on the current plan
  //   (scripts/validate-agent-runtime.ts, test B): container limit 7629 MB,
  //   backend idle ~240 MB, and ONE subprocess peaks at +152 MB — not the ~1 GiB
  //   originally assumed. 4 concurrent is ~1 GB of a 7.6 GB box. The ceiling is
  //   far higher; 4 is deliberately conservative, not a plan limit.
  AGENT_MAX_CONCURRENCY: z.coerce.number().default(4),
  //   Per-loop hard cost ceiling (USD), independent of the turn cap → maxBudgetUsd.
  AGENT_MAX_BUDGET_USD: z.coerce.number().default(0.5),
  //   Admission control (capacity.ts), MB. 256 = the measured 152 MB peak plus
  //   headroom for a heavier loop. The adapter logs the real delta per run
  //   (`agent-runtime … memΔ=`), so re-tune from logs rather than guessing.
  AGENT_SUBPROCESS_MB: z.coerce.number().default(256),
  AGENT_MEMORY_RESERVE_MB: z.coerce.number().default(512),
  //   How long a loop waits for a slot before giving up. Exceeding this raises
  //   AgentCapacityError, which the adapter turns into a legacy run rather than a
  //   failure — an unbounded queue would turn memory pressure into silent latency.
  AGENT_ACQUIRE_TIMEOUT_MS: z.coerce.number().default(20_000),
  //   When an SDK run fails (capacity, proxy down, translation bug), re-run it on
  //   the legacy runner instead of failing the feature. Loud, never silent: every
  //   fallback logs `agent-runtime FALLBACK`. This is a RUNTIME fallback (same
  //   model, different runner) — distinct from the model-level fallback §3n
  //   deliberately refuses to make automatic. Set false to surface SDK errors raw.
  AGENT_SDK_FALLBACK_TO_LEGACY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Embeddings are separate from the chat model (the chat model is chat-only):
  // OpenAI when OPENAI_API_KEY is set, else Qwen/DashScope (OpenAI-compatible mode).
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
  // Trend-delivery band (2026-07-12 rework; replaces the old "at most one a day"
  // + 4-per-30-days caps, which are arithmetically incompatible with a 2/day
  // target). Two distinct, load-bearing knobs:
  //   MIN = per-RUN send cap. trendMatch runs 3×/day; one run delivers at most
  //   this many, so a single run serves a helping rather than dumping the whole
  //   day's band at once, leaving room for a fresher/bigger trend a later run
  //   finds. This is the "target 2 a day from one good run" number.
  //   MAX = hard per-DAY ceiling, checked before any paid provider work.
  // A quiet day delivers fewer — the code fills toward the band from qualifying
  // candidates but never manufactures buzz or relaxes a gate to hit the number.
  MIN_DAILY_TREND_SENDS: z.coerce.number().default(2),
  MAX_DAILY_TREND_SENDS: z.coerce.number().default(3),
  // buzzScore (trends/scoring.ts, components normalized 0..1) must clear this.
  BUZZ_THRESHOLD: z.coerce.number().default(0.5),
  // Max cosine distance between a trend and the user's nearest position for the
  // niche gate. Calibrated against live data (2026-07-12): with text-embedding-v4,
  // genuinely on-niche trends sit 0.40-0.55 from the nearest position while
  // off-niche chatter sits 0.61+ — at the old 0.7 the junk not only passed, it
  // ate the top-3 volume-verification slots and could crowd a real trend out.
  NICHE_THRESHOLD: z.coerce.number().default(0.6),
  // twitterapi.io advanced_search pagination cap per query — $0.00015/tweet is
  // cheap per topic but not free at scale; never paginate unbounded.
  TWITTERAPI_SEARCH_PAGE_CAP: z.coerce.number().default(3),

  // ── Daily viral tweet case study (jobs/viral-benchmark.ts, §3h) ──────────
  // The impression band a candidate must land in: high-six-to-seven-digit, so
  // it's a genuine breakout but not a once-a-year megaviral outlier.
  VIRAL_VIEW_MIN: z.coerce.number().default(100_000),
  VIRAL_VIEW_MAX: z.coerce.number().default(9_999_999),
  // No min_views search operator exists on twitterapi.io — we floor the search
  // by likes as a proxy, then post-filter the returned set by real viewCount.
  // ~600 likes empirically corresponds to the low-100k-views band for this ICP.
  VIRAL_MIN_FAVES_PROXY: z.coerce.number().default(600),
  // "Blew up recently", not an evergreen-viral archive lookup. 48h matches the
  // niche news cycle (a launch/take is still worth a case study a day later).
  VIRAL_RECENCY_HOURS: z.coerce.number().default(48),
  // Don't resurface the same author within this window (repeat-offender guard).
  VIRAL_AUTHOR_COOLDOWN_DAYS: z.coerce.number().default(14),
  // Bounded composition agent (why-it-worked + one angle).
  VIRAL_MAX_TOOL_CALLS: z.coerce.number().default(3),

  // ── Buyer Radar (§3h) ────────────────────────────────────────────────────
  // Finds in-market prospects on X, scores intent deterministically, gates on
  // domain fit, drafts an approval-only reply. Uses TWITTERAPI_IO_KEY; if unset,
  // the feature is unavailable and says so plainly (fail-closed, like the buzz
  // gate degrading without the key). Never auto-sends.
  //   Master switch. Off → the whole feature is unavailable everywhere.
  BUYER_RADAR_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  //   The proactive recurring scan/DM path ships DARK — pull-only at launch;
  //   flip on per rollout AFTER the search-budget behavior is observed in prod.
  BUYER_RADAR_PROACTIVE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  //   Deterministic intent gate: intentScore (buyer/scoring.ts, 0..1) must clear
  //   this. Live-calibrate like BUZZ_THRESHOLD.
  INTENT_THRESHOLD: z.coerce.number().default(0.45),
  //   Semantic niche gate: max cosine distance between a candidate tweet and the
  //   ICP vector for a CONFIDENT pass. Recalibrated 2026-07-24 from live geometry
  //   (Qwen embeddings put on-topic candidates at ~0.57; the old 0.55 rejected
  //   100% of everything, forever).
  BUYER_NICHE_THRESHOLD: z.coerce.number().default(0.62),
  //   Hard ceiling for the top-K rescue pass in the niche gate: when nothing
  //   clears the threshold, the K nearest candidates under this ceiling still go
  //   to the composition agent (which researches + declines off-fit ones).
  BUYER_NICHE_CEILING: z.coerce.number().default(0.78),
  //   Intent decays: a 3-week-old "looking for" is likely resolved, so the window
  //   stays short — but 72h left niche categories with no volume at all to search
  //   (verified live 2026-07-23), so a week is the floor that still reads as fresh.
  //   Recency is a decay inside this window, not a cliff (buyer/scoring.ts).
  BUYER_LOOKBACK_HOURS: z.coerce.number().default(168),
  //   When a pass finds NOTHING in-window, discovery retries the strongest queries
  //   once over this multiple of the window — an empty radar is worse than an old
  //   candidate that still has to clear both gates on its own merits.
  BUYER_WIDEN_FACTOR: z.coerce.number().default(4),
  //   Bounded composition loop cap (mirrors REPLY_AGENT_MAX_TOOL_CALLS).
  MAX_BUYER_TOOL_CALLS: z.coerce.number().default(4),
  //   Per-query advanced_search pagination cap (cost: $0.00015/tweet, and buyer
  //   search is per-user O(users), not shared like trends/viral).
  BUYER_SEARCH_PAGE_CAP: z.coerce.number().default(2),
  //   Bounded set of distilled intent queries run per scan.
  BUYER_MAX_QUERIES: z.coerce.number().default(8),
  //   NOTE: there is deliberately no BUYER_MONTHLY_SIGNAL_CAP here any more. It
  //   existed, was read by nothing, and was actively misleading — the real cap is
  //   per-plan (`entitlementsFor().buyerIntentsPerMonth`: Growth 25, Scale
  //   unlimited), so setting the env var changed nothing while looking like it
  //   should. Change the cap in billing/entitlements.ts.
  //   Don't resurface the same prospect within this window (repeat-author guard).
  BUYER_AUTHOR_COOLDOWN_DAYS: z.coerce.number().default(21),

  // ── Automations (multi-automation "auto agent", §3l) ─────────────────────
  // The unattended AUTO cron ships DARK (mirrors BUYER_RADAR_PROACTIVE): approval
  // mode can be validated in prod before any hands-off post fires.
  AUTOMATIONS_AUTO_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Global ceiling on posts/day across ALL of a user's automations (flood guard).
  AUTOMATION_USER_DAILY_CAP: z.coerce.number().default(3),
  // Auto mode schedules this many minutes out (cancellable from the web queue
  // before it fires) rather than posting instantly — the escape hatch in hands-off mode.
  AUTOMATION_AUTO_DELAY_MIN: z.coerce.number().default(60),
  // Warmup ramp: the first N posts of a new AUTO automation route through approval
  // first, so the user confirms the voice before it goes fully unattended.
  AUTOMATION_AUTO_WARMUP: z.coerce.number().default(3),
  // Edit-loop cap in approval mode before forcing an approve/reject.
  AUTOMATION_MAX_EDITS: z.coerce.number().default(5),
  // Default monthly post cap for a new automation.
  AUTOMATION_DEFAULT_MONTHLY_CAP: z.coerce.number().default(30),

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

  // Product analytics (PostHog, server-side via posthog-node). Optional: unset
  // → every track/identify call is a silent no-op, nothing else changes. This
  // is a Telegram backend with no web frontend, so there's no client snippet /
  // autocapture — events are captured explicitly at product choke points
  // (analytics/posthog.ts), keyed by the internal user id.
  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().default("https://us.i.posthog.com"),
  // Optional: a personal API key + project id enable erasing a user's analytics
  // person on account wipe (clear_everything). Without them, wipe still clears
  // everything in our own DB; PostHog erasure is just skipped (best-effort).
  POSTHOG_PERSONAL_API_KEY: z.string().optional(),
  POSTHOG_PROJECT_ID: z.string().optional(),

  DODO_API_KEY: z.string().optional(),
  DODO_WEBHOOK_SECRET: z.string().optional(),
  DODO_ENV: z.enum(["test_mode", "live_mode"]).default("test_mode"),
  DODO_PRODUCT_PAID: z.string().optional(),
  // "Scale" tier — the higher landing plan (?plan=scale). Real, higher caps than
  // Growth (see billing/entitlements.ts); distinct product so billing/telemetry
  // can tell Growth from Scale.
  DODO_PRODUCT_SCALE: z.string().optional(),
  DODO_PRODUCT_FOUNDING: z.string().optional(),
  // Human-readable prices shown in /upgrade copy, the checkout button and the
  // Settings plan picker. Keep in sync with the actual Dodo product prices AND
  // with the landing page (separate repo) — nothing derives these from Dodo, so
  // a price change is a three-place edit.
  //
  // Today: early-bird pricing, Growth $9/mo and Scale $49/mo, anchored against
  // the standard $29 / $79. The *_WAS_LABEL values are display-only strikethroughs.
  PAID_PRICE_LABEL: z.string().default("$9/mo"),
  PAID_PRICE_WAS_LABEL: z.string().default("$29"),
  SCALE_PRICE_LABEL: z.string().default("$49/mo"),
  SCALE_PRICE_WAS_LABEL: z.string().default("$79"),
  // Off during testing → everyone gets full features. Set true to enforce plans.
  // NOTE: a boot warning fires (index.ts) if this is false in production, so a
  // deploy that forgets the flag can't silently give everyone the paid tier.
  // Case- and whitespace-insensitive on purpose. This used to be a bare
  // `v === "true" || v === "1"`, so `True`, `TRUE` or a value with a stray space
  // silently disabled the paywall and handed every user the full Scale tier —
  // a typo in a dashboard field, with no error and no way to notice.
  PAYWALL_ENABLED: z
    .string()
    .default("false")
    .transform((v) => ["true", "1", "yes", "on"].includes(v.trim().toLowerCase())),
  // Comma-separated Telegram user ids that bypass the paywall entirely (founder +
  // testers). ADMIN_TELEGRAM_ID is auto-exempted on top of this, so the operator
  // never has to upgrade themselves. Empty = only ADMIN_TELEGRAM_ID is exempt.
  PAYWALL_WHITELIST: z.string().optional(),
  // Free users get this many LIFETIME drafts before the paywall — so the core
  // promise (a post in your voice) is felt before the ask, instead of the
  // paywall landing on /draft before they've ever seen output.
  FREE_DRAFT_ALLOWANCE: z.coerce.number().default(3),
  // Length of the free trial every new signup gets (full paid-tier access).
  // After it lapses, entitlements fall to free and the upgrade wall applies on
  // both web and Telegram. Enforcement requires PAYWALL_ENABLED=true.
  TRIAL_DAYS: z.coerce.number().default(7),

  NODE_ENV: z.string().default("development"),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

export const isDev = config.NODE_ENV !== "production";

/**
 * Misconfigurations that are silent, expensive, and only observable in
 * production. Checked at module load — NOT at server boot — because the Next.js
 * app (packages/web) imports this config directly and never executes
 * `src/index.ts`, so a boot-time-only guard cannot see the surface where most of
 * these actually bite. Vercel would have run the entire web app with the paywall
 * off and nothing would have said a word.
 *
 * Warn, never throw: a config warning must not be able to take the product down.
 */
function warnOnDangerousConfig(): void {
  if (config.NODE_ENV !== "production") return;
  const warn = (msg: string) => console.warn(`⚠️  config: ${msg}`);

  if (!config.PAYWALL_ENABLED) {
    warn(
      "PAYWALL_ENABLED is not true in production — every user currently gets the full paid tier for free. " +
        'Accepted truthy values: "true", "1", "yes", "on".',
    );
  }

  // A duplicated product id makes planForProduct() mis-map silently: it tests
  // FOUNDING → SCALE → PAID in order, so reusing (say) the Growth id for
  // Founding records every Growth buyer as founding — full Scale entitlements
  // for $9, and a burnt founding seat.
  const products = {
    DODO_PRODUCT_PAID: config.DODO_PRODUCT_PAID,
    DODO_PRODUCT_SCALE: config.DODO_PRODUCT_SCALE,
    DODO_PRODUCT_FOUNDING: config.DODO_PRODUCT_FOUNDING,
  };
  const set = Object.entries(products).filter(([, v]) => v);
  const seen = new Map<string, string>();
  for (const [name, id] of set) {
    const prior = seen.get(id!);
    if (prior) warn(`${name} and ${prior} share the same Dodo product id — plan mapping will be wrong.`);
    else seen.set(id!, name);
  }
  if (!config.DODO_PRODUCT_PAID) warn("DODO_PRODUCT_PAID is unset — Growth checkout will fail.");
  if (!config.DODO_PRODUCT_SCALE) warn("DODO_PRODUCT_SCALE is unset — Scale purchases will be recorded as Growth.");

  // WEB_APP_URL is the allowlist the OAuth connect flow checks a `redirect`
  // against (routes/oauth.ts). Left at its localhost default in production, no
  // web redirect is ever honoured and every user who connects from the web is
  // returned to the Telegram-flavoured static page instead of Settings.
  if (config.WEB_APP_URL.startsWith("http://localhost")) {
    warn("WEB_APP_URL is still the localhost default in production — web OAuth redirects will not be honoured.");
  }
}

warnOnDangerousConfig();
