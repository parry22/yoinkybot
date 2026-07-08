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

## Layout

```
packages/backend   Fastify monolith: strategist flow (connect/diagnose/goals/plan/proactive),
                   capture pipeline, moment gate, angle engine, trends (Apify default,
                   Brave/Tavily fallback), memory core, voice/consistency/drafting,
                   DodoPayments billing, the grammY Telegram bot, pg-boss jobs
docs/PHASES.md     Original build phases; see .claude plan for the narrative-engine phases

# HTTP surface is minimal: /health and webhooks (Dodo billing + Telegram in production).
# No session auth, no web UI.
```

## Prerequisites

- Node 20+, pnpm 9+
- Postgres 16+ with the **pgvector** extension available
- API keys (all optional in dev; features degrade gracefully): Telegram bot token, Sarvam,
  OpenAI (embeddings + Whisper fallback), Anthropic (frontier tier), Kimi/Moonshot (cheap tier),
  Tavily (macro-matching), DodoPayments (billing)

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
`/clear`, `/upgrade`, `/status`. `/clear` wipes everything and restarts the connect flow.

Local dev without a public HTTPS URL runs the Telegram bot in **long-polling** mode automatically.
In production set `PUBLIC_URL=https://…` and the bot switches to webhooks
(`/webhooks/telegram`, guarded by `TELEGRAM_WEBHOOK_SECRET`).

### DodoPayments

1. Create two subscription products (paid, founding) in the Dodo dashboard; put their ids in
   `DODO_PRODUCT_PAID` / `DODO_PRODUCT_FOUNDING`.
2. Point a webhook at `POST /webhooks/dodo` and set `DODO_WEBHOOK_SECRET` (Standard Webhooks).
3. `DODO_ENV=test_mode` until launch.

## Architecture notes

- **Captures are immutable**; memories are derived and re-derivable. Forget is hard deletion.
- **Every LLM call** goes through `src/llm/gateway.ts` — tier routing (cheap/frontier, currently
  both Qwen), retries, and per-user cost metering into `usage_events`.
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
```
