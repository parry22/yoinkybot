# Yoinky — the narrative engine for personal brands

Inspired by the a16z "new media" thesis: own your narrative, ship consistently, ride the moment.

The loop: you connect your X/LinkedIn and drop thoughts to the **Yoinky Telegram bot** (voice or
text) → the backend extracts what's genuinely narratable → the bot **suggests 3 ways to tell each
story** and writes the full post in your voice on tap → in parallel, **live X/LinkedIn trends** (via
Apify, with news-search fallback) are matched against your stated positions so the conversation
comes to you.

Underneath sits the memory core: everything you capture is extracted, embedded, linked, and
searchable, powering voice profiles, consistency checks ("does this draft contradict what you've
said?"), and grounded drafting.

> Payments: **DodoPayments** (merchant of record) — one integration for India + international.

Yoinky is **Telegram-native — there is no web dashboard.** Everything happens in the chat:
connect your accounts, get diagnosed, build a plan, and ship content.

## Latest updates

<!-- Keep newest-first. Update this whenever a change ships that a reader of the repo should know about. -->

- **2026-07-11 — `/clear` now deletes the visible chat too.** Every Telegram
  message (yours and the bot's) is tracked as it's sent; `/clear` batch-deletes
  all of them before wiping the DB, so a reset actually clears the conversation,
  not just the underlying data.
- **2026-07-11 — Profile-first onboarding + gap analysis.** Onboarding is now an
  11-stage strategist conversation: it draws out a full stated brand profile
  (positioning, goal, audience, voice/tone, pillars, format, constraints) one
  question at a time *before* reading your history, then delivers a **gap
  analysis** measuring your actual posts against what you said you were building,
  then a month-by-month plan. New `brand_profiles` table; the profile now grounds
  drafting (hard-blocks off-limits topics), consistency, and steady-state chat. A
  connect-first escape hatch still gives the instant cold diagnosis for anyone who
  drops a handle early, and a drop-off nudge follows up if the intake stalls.
- **2026-07-10 — Agentic chat layer.** The conversational brain can now *do*
  things, not just talk: plain language reaches the same code paths as the
  slash commands via a one-tool-per-turn contract (`converse.v2` +
  `telegram/chat-tools.ts` + `telegram/actions.ts`) — draft, repurpose, memory
  search, consistency check, plan/positions/status, diagnosis refresh, connect,
  forget. Also: per-user turn serialization with burst merging (fragments typed
  in quick succession get one considered reply), a typing heartbeat for long
  turns, voice notes get a real conversational reply after transcription,
  caption-bearing media and unsupported message types are answered instead of
  ignored, the Telegram webhook fast-acks with update dedup (no more redelivery
  replays), and "check out @naval on x" no longer scrapes naval as your account.
- **2026-07-10 — Single-model LLM routing.** Every AI call now goes to one model
  (**GLM 5.2**, `z-ai/glm-5.2` via OpenRouter). The previous tier system
  (cheap / cheap_floor / frontier) and the multi-provider fallback chains
  (Anthropic / Kimi / Qwen) are gone — one model, retries, JSON repair, per-user
  daily cap. Set `MODEL_CHAT` to switch models without a code change. Embeddings
  are unchanged (OpenAI, else Qwen — GLM 5.2 is chat-only).
- **2026-07-08 — Delivery hardening.** Keep-alive survives Render cold starts;
  the Telegram webhook no longer silently drops updates; embedding batches are
  chunked to avoid DashScope 400s on trend fetches; the diagnosis reveal is
  paced instead of one prose dump.

## Layout

```
packages/backend   Fastify monolith: strategist flow (connect/diagnose/goals/plan/proactive),
                   capture pipeline, moment gate, angle engine, trends (Apify default,
                   Brave/Tavily fallback), memory core, voice/consistency/drafting,
                   DodoPayments billing, the grammY Telegram bot, pg-boss jobs
docs/INTERNAL.md   Full internal team guide: architecture, subsystems, ops, conventions
docs/PHASES.md     Original build phases (historical)
DEPLOY.md          Railway deploy runbook

# HTTP surface is minimal: /health and webhooks (Dodo billing + Telegram in production).
# No session auth, no web UI.
```

## Prerequisites

- Node 20+, pnpm 9+
- Postgres 16+ with the **pgvector** extension available
- API keys (features degrade gracefully where possible): Telegram bot token,
  **OpenRouter** (the only LLM route — required for any AI feature), OpenAI or
  Qwen (embeddings), Groq/Sarvam (speech-to-text), Apify (trends), DodoPayments
  (billing).

## Setup

```bash
pnpm install
createdb yoink
cp .env.example packages/backend/.env      # fill in what you have
pnpm db:migrate                            # applies packages/backend/src/db/migrations
pnpm dev                                   # backend + bot on :3001 (runs migrations on boot too)
```

Everything else is in Telegram — DM the bot and use `/help`. The core loop:
`/connect` your X/LinkedIn → I ingest and `/diagnosis` your presence → you answer a couple of
goal questions → confirm your `/plan` → I work it proactively (unlock nudges, trend moments,
consistency, drafting). Other commands: `/ask`, `/draft`, `/check`, `/voice`, `/positions`,
`/repurpose`, `/peers`, `/settings`, `/clear`, `/upgrade`, `/status`. `/clear` wipes everything
and restarts the connect flow.

Local dev without a public HTTPS URL runs the Telegram bot in **long-polling** mode automatically.
In production set `PUBLIC_URL=https://…` and the bot switches to webhooks
(`/webhooks/telegram`, guarded by `TELEGRAM_WEBHOOK_SECRET`).

### DodoPayments

1. Create two subscription products (paid, founding) in the Dodo dashboard; put their ids in
   `DODO_PRODUCT_PAID` / `DODO_PRODUCT_FOUNDING`.
2. Point a webhook at `POST /webhooks/dodo` and set `DODO_WEBHOOK_SECRET` (Standard Webhooks).
3. `DODO_ENV=test_mode` until launch.

## Architecture notes

- **One LLM model, one path.** Every model call goes through `src/llm/gateway.ts`
  → `z-ai/glm-5.2` via OpenRouter, with retries, a JSON-repair pass, and per-user
  cost metering into `usage_events`. No tier routing, no fallback chain. Change
  the model with `MODEL_CHAT`. Embeddings live in `src/llm/embeddings.ts`
  (OpenAI, else Qwen).
- **Captures are immutable**; memories are derived and re-derivable. Forget is hard deletion.
- **Prompts are versioned files** in `src/prompts/*.v1.ts`, not inline strings.
- **Resurfacing selection is deterministic** (`src/surfacing/scoring.ts` — novelty ×
  link-density × recency ÷ surface count); the LLM only composes the message.
- **Identity is the Telegram user** (`telegram_id`) — no login.
- Agency prep: `profile_id` is stored separately from `user_id` on memories/positions/moments;
  they are equal in v1.

## Tests

```bash
pnpm test         # unit tests for scoring, quiet hours, parsers, RRF, k-means, webhook signatures
pnpm typecheck
pnpm verify       # typecheck + full unit suite — the pre-deploy gate
```
