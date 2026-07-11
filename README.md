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

- **2026-07-11 — Onboarding trimmed from 21 fields to 8.** The intake now only
  asks niche, primary goal, audience, two inspiration/tone questions, the
  derived-and-confirmed content pillars, and two format questions (camera,
  primary platform) — the deeper positioning/audience/constraints fields (and
  all of the old constraints stage) are gone. Also fixed a real bug this
  surfaced: array-valued answers (inspiration, tone) could get double-encoded
  into a single garbled string instead of a clean array — `normalizeArray` now
  defends against it. Verified live end-to-end.
- **2026-07-11 — Skipping an onboarding question now always works.** "let's
  skip this question", "next question please", "pass", "move on" etc. are
  matched deterministically (`detectSkipIntent`) and always advance on the
  first try — not left to the model to recognize reliably, since a model that
  misses an explicit decline just re-asks the same question forever. The
  skipped field is marked unresolved, never forced. Distinct from a real empty
  answer ("none"/"n/a" for e.g. off-limits topics), which still captures as
  intentional-empty, not unresolved.
- **2026-07-11 — A dead LLM route can't hide anymore.** `/health` now reports
  `llm: true|false` (key presence), boot screams and DMs the admin when
  `OPENROUTER_API_KEY` is missing, and every failed live turn DMs the admin the
  real error (hourly-throttled). Context: prod was set up before the
  single-model change and never got `OPENROUTER_API_KEY`, so every turn fell to
  canned fallback lines — invisibly. See DEPLOY.md troubleshooting.
- **2026-07-11 — Onboarding actually listens now.** Fixed the intake loop: the
  paced-session turns read chat history *before* the just-sent message was saved,
  so the strategist reacted a turn late and re-asked the same question. The
  current message is now included in the turn — it captures answers immediately,
  handles off-topic replies, and refers back to what you said. Also hardened the
  path end to end: per-turn DB reads are non-fatal (a hiccup can't dead-end the
  intake), the LLM gateway falls back to plain mode when a routed provider rejects
  JSON mode (was silently breaking every structured call), a backstop advances
  past any field after a few tries so nothing can loop, and `/start` no longer
  claims "already set up" while you're mid-onboarding.
- **2026-07-11 — Removed `/plan`, `/positions`, `/clear`.** All three are now
  plain-language only. `/plan` and `/positions` already had `show_plan` /
  `show_positions` chat tools, so nothing else changed there. `/clear` gets a
  new `clear_everything` chat tool (`chat-tools.ts`, `actions.ts`) that — like
  the old command — never wipes directly; it surfaces the same yes/no
  `clr:confirm`/`clr:cancel` buttons the existing callback handler in `bot.ts`
  already processed, so the destructive path is unchanged, only its entry point
  moved to natural language. The prompt is told to only fire it on an
  unambiguous "wipe everything / start completely over" request, never on
  vague frustration.
- **2026-07-11 — Casual texting voice.** Yoinky now talks like a real person
  texting, not an assistant: lowercase, short, contractions, dry, casual even
  while kicking off a task. Driven by a shared `CASUAL_VOICE` prompt block
  injected into every Yoinky-*voice* prompt (chat, onboarding, the reveals,
  plan/progress/proactive DMs) plus a deterministic `casualize()` backstop that
  lowercases the opener (leaving proper-noun/acronym openers like LinkedIn/AI/X
  alone). Content written **for the user's public feed** — post drafts, reply
  drafts, repurposed posts, angle hooks — deliberately stays properly
  capitalized; only Yoinky's own chatter goes lowercase. Hardcoded acks and
  task-execution scaffolding were rewritten to match.
- **2026-07-11 — Leaner commands, resilient intake, cold-start feedback.**
  Removed the `check`, `ask`, `forget`, `status`, `diagnosis`, `diagnose`, `demo`,
  and `voice` slash commands (all still available in plain language via the chat
  brain). `/clear` now restarts the profile-first onboarding from question one
  instead of a dead "connect an account" prompt. The intake never dead-ends on a
  transient LLM hiccup anymore — it falls back to asking the next question
  plainly. And a typing indicator fires the instant a message is received, so a
  slow cold start reads as thinking, not offline.
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
`/start` walks you through the profile intake → you `/connect` your X/LinkedIn → I read your
history and reveal the gap → confirm your plan → I work it proactively (unlock nudges, trend
moments, consistency, drafting). The command set is deliberately lean: `/connect`, `/draft`,
`/repurpose`, `/peers`, `/settings`, `/upgrade`. Everything else is plain language — "does this
contradict what I've said", "what have I said about pricing", "where am I at", "what's my plan",
"what do I believe", "wipe everything and start over" (wipes everything, chat history included,
and restarts onboarding).

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
