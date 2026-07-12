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

- **2026-07-12 — Macro-moment: a daily *band* of high-volume trends, each
  showing the post that's driving it.** The trend agent used to send at most one
  trend a day (capped at 4 a month). It now aims for **at least 2 genuinely
  high-volume, on-niche trends per user per day** (hard ceiling 3) — the kind of
  thing you'd already be seeing on your own feed. Every delivery now names the
  specific post/thread driving the volume: a permalink plus a one-line
  paraphrase (never a long quote), so you can see exactly what you'd be riding
  before you weigh in, alongside the angle that's yours to take. Selection stays
  fully deterministic — candidates are volume-verified (distinct-author-weighted
  buzz), ranked, and taken top-down until the day's band fills; the model only
  writes the take, never picks the trend (this rework actually *tightened* that,
  moving the position match from a cross-trend pick to a per-trend yes/no). The
  old 4-per-month rarity cap was removed on purpose — it's incompatible with a
  2/day target; rarity is now the daily band plus the unchanged niche/buzz/
  position gates. Not deployed/observed live yet — pending a real trend firing.
- **2026-07-12 — Migrated production from Render to Railway (Hobby plan).**
  Render's free tier spins the process down when idle, which silently broke
  `pg-boss`'s in-process cron (see the trend-discovery fix below) — moving to
  an always-on plan fixes that class of bug outright instead of working around
  it. The database (**Neon**, external, pgvector) never moved — same instance,
  zero data migrated, zero data risk; only compute changed. `bot.meetyoinky.com`
  now points at Railway; Render is suspended (not deleted) as an instant DNS-
  flip rollback. Also recharged `twitterapi.io` (was hard-failing on `402
  Credits is not enough`, degrading trend-take quality) and verified it's
  fetching real tweet data again. See [DEPLOY.md](DEPLOY.md) for the real
  topology and rollback steps.
- **2026-07-12 — Product analytics via PostHog (server-side).** Since Yoinky is
  Telegram-native with no web frontend, there's no browser snippet — events are
  captured server-side with `posthog-node`, keyed by the internal user id, at
  the funnel choke points: `user_signed_up`, `message_received`,
  `capture_created`, `account_connected`, `draft_generated`,
  `onboarding_completed`, `subscription_activated`. Fully optional and
  privacy-conscious: no `POSTHOG_API_KEY` → every call is a silent no-op, and
  only metadata (platform, plan, counts) is ever sent — never post text or
  captured thoughts. `/health` reports `analytics: true|false`. Set
  `POSTHOG_API_KEY` (project key) to turn it on.
- **2026-07-12 — Trend discovery actually finds the niche's news cycle now.**
  The macro-moment pipeline was searching X for the user base's biggest memory
  clusters verbatim — which are dominated by personal-life chatter — so a week
  of major AI news (a Musk/Altman feud, model launches) produced zero trend
  offers. Three fixes, all verified against live data: (1) discovery seeds are
  now LLM-distilled from brand profiles + clusters + positions into 4-6 short
  professional search terms ("AI agents", not "Punjab and Drinks"), with a
  deterministic fallback; (2) the niche gate tightened 0.7 → 0.6 — at 0.7,
  off-niche junk passed and ate the top-3 volume-verification slots, crowding
  real trends out; (3) a trend the agent declined / cadence held / send dropped
  is now recorded on the moment (verdict + reason) instead of vanishing — and
  no longer burns the 4-per-month cap, which invisible declines used to starve.
  `/health` now also reports trend-scrape readiness (provider key, buzz-gate
  key, last fetch time) so a prod env drift can't silently kill the pipeline
  again. Root-caused why prod had zero trend rows in the first place: a
  one-time crash on 2026-07-08 (already fixed the same day) meant the trends
  table sat empty for 4 days after, because Render's free tier spins the
  process down when idle and a missed cron minute never gets backfilled. Every
  process boot now also tries `trendFetch`/`trendMatch` once (both safe to
  over-fire), so a process that's constantly restarting still gets a
  guaranteed floor of at least one real attempt per lifetime.
- **2026-07-12 — Onboarding connect is now OAuth-first.** When the platform
  apps are configured, the connect hand-off leads with real account
  authorization (tap → approve → done) instead of asking for a handle to
  scrape: X is offered first, LinkedIn once X resolves; either can be skipped
  but skipping both is refused until at least one account is connected (a
  typed @handle / profile URL still counts and stays the fallback everywhere,
  including on instances with no platform apps). What auth buys, honestly: on
  X, one sanctioned `users.read` call resolves the *verified* handle + profile
  metadata and the history ingest runs against that (so we only read accounts
  the user demonstrably owns) — and the same consent unlocks posting, so no
  second `/connectposting` auth later. On LinkedIn no open API scope can read
  a member's posts (the read scope is partner-gated, we don't request it), so
  auth there means verified identity + posting rights, and the bot asks for
  the profile URL right after to do the actual reading. Credential-gated and
  not live-tested against the real providers, like the rest of the OAuth
  surface (see docs/INTERNAL.md §3f).
- **2026-07-12 — Native scheduled posting, engine built (not yet user-facing).**
  Built natively on the existing job queue (a due post is just a delayed job,
  no third-party scheduler) with real X/LinkedIn publishers behind a write-scope
  OAuth connect (**/connectposting**), verified end-to-end against the real
  queue and DB. Held back on purpose right after being built: X's official API
  charges per post (no free tier), so exposing "/scheduled" and the natural-
  language scheduling tool waits on that call. Nothing user-facing changed yet.
- **2026-07-11 — Posts are now classified by rhetorical mode, sincerity, and
  motive — not just content.** The direct fix for shitposts/jokes being
  misread as sincere beliefs: extraction now also scores sincerity register
  (sincere/ironic/self_deprecating/absurdist/ambiguous) and motive, and
  positions are only ever extracted from content that clears a confidence
  gate. Build-in-public series ("day N of...") are detected — by structural
  marker or thematic continuity across a user's recent posts — and linked
  into a `campaigns` timeline with retroactive tagging. Voice, diagnosis,
  and performance analytics all now respect the sincerity signal (a shitpost
  outperforming a sincere post is flagged as exactly that, not just more
  engagement). Users can correct a misread ("that was a joke") via chat or a
  one-tap button on any resurfaced post; repeated corrections trigger a
  one-time acknowledgment, and get folded into a monthly per-user
  recalibration. Verified live end-to-end against the real model + DB.
- **2026-07-11 — Four features went agentic (bounded loops, not open ReAct).**
  A shared runner (`llm/tool-loop.ts`) gives the model a small toolset and a
  hard call cap (2–4 per feature, config); repeat calls with the same args are
  rejected, every step is logged and persisted, and all calls still route
  through `llm/gateway.ts`. The doctrine is unchanged: code decides *whether*
  something fires (buzz/niche/position gates, reply-worthiness scoring,
  consistency ambiguity delta); the model only researches and composes.
  What changed per feature:
  - **Chat brain (converse.v3):** up to `MAX_TOOL_CALLS_PER_TURN` (3) tools in
    one turn — "check this against what I've said, then clean it up" is now one
    turn. Each tool's delivery is persisted as its own assistant-turn fragment.
  - **Macro-moment agent:** trend candidates are now *volume-verified* against
    twitterapi.io advanced_search (deterministic `buzzScore` in
    `trends/scoring.ts`: distinct authors > raw count, engagement, velocity)
    before the position gate; a composition agent then researches (cached top
    tweets, memory, voice, goals) and writes the take — or declines. Distinct
    `trend_take` delivery (migration 0016), at most one a day, shared proactive
    budget. Degrades to the old angle-offer flow when `TWITTERAPI_IO_KEY` is
    unset.
  - **Consistency check:** two code-decided escalation signals send a draft to
    the agent — top-2 position matches within `CONSISTENCY_AMBIGUITY_DELTA`, or
    a single-shot first pass that comes back under
    `CONSISTENCY_CONFIDENCE_THRESHOLD` (a shaky read is re-checked, not acted
    on). The agent resolves *which* statement the draft actually conflicts with
    (position context, wider search, memory) and reports catch /
    intentional-evolution / no-conflict; low-confidence catches are suppressed.
    The confident, clean-match common case stays single-shot.
  - **Reply drafting (reply-draft.v2):** scoring still decides *whether*; the
    drafter now pulls its own grounding — memory, voice, pillars, full thread,
    and computed visibility facts (`engagement/heuristics.ts`, deterministic
    and unit-tested) — before writing the one reply.
- **2026-07-11 — The connect hand-off names the concrete action.** "Now connect
  your X or LinkedIn" told you nothing about what to actually send. It now says
  "drop your X handle (like @yourname) or your LinkedIn profile URL" — fixed at
  the prompt instruction, the deterministic fallback, the `/start` resume path,
  and the connect-stall nudge, so it's consistent everywhere this hand-off can
  fire. Verified live: the actual model output now names a concrete handle/link
  action.
- **2026-07-11 — Onboarding trimmed from 21 fields to 7.** The intake now only
  asks niche, primary goal, audience, two inspiration/tone questions, the
  derived-and-confirmed content pillars, and one format question (camera
  comfort) — the deeper positioning/audience/constraints/platform fields (and
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
