# Yoinky — internal team guide

Everything a teammate needs to work in this codebase that doesn't belong in the
public README. Read the [README](../README.md) first for the product pitch and
setup; this doc is the how-it-actually-works.

> **Keep this current.** When you change how a subsystem works, add/remove an env
> var, or ship a user-visible behavior change, update the relevant section here
> and the README's "Latest updates". Treat stale docs as a bug.

---

## 1. Shape of the system

One Fastify monolith (`packages/backend`), one Postgres (with pgvector), one
Telegram bot. **Single process, single instance** — pg-boss cron and the Telegram
webhook both assume exactly one running replica. Do not scale horizontally.

```
Telegram (voice/text)
      │
      ▼
grammY bot ──► capture pipeline ──► pg-boss jobs ──► memory core (Postgres + pgvector)
      │              (immutable)      (extract, embed,       │
      │                                link, cluster,        ▼
      ▼                                resurface, trends)  positions / voice / consistency
strategist flow ◄──────────────────────────────────────────┘
(connect → diagnose → goals → plan → proactive)
      │
      ▼
drafting (angles, draft, repurpose) ──► Telegram reply
```

HTTP surface is deliberately tiny: `/health` plus webhooks (`/webhooks/telegram`,
`/webhooks/dodo`). No session auth, no web UI. Identity is the Telegram user id.

Entry point: `src/index.ts` (Fastify + bot bootstrap, migrations on boot).

---

## 2. LLM gateway — one model, one path

**Every model call routes through `src/llm/gateway.ts`. No module calls a provider
directly.** As of 2026-07-10 this is deliberately simple:

- One model for **all** requests: `z-ai/glm-5.2` via **OpenRouter**
  (`config.MODEL_CHAT`). No tier routing, no multi-provider fallback chain.
- `llmCall(req)` does: per-user daily cap check → single OpenRouter call with
  retries (`withRetries`, 3 attempts, backoff on 429/5xx/timeout) → optional
  JSON extraction with one corrective retry (`extractJson`).
- Cost metering: every call writes a row to `usage_events` (`src/usage/meter.ts`).
- Hard per-call timeout via `fetchWithTimeout` (`LLM_PROVIDER_TIMEOUT_MS`, default 45s).
- Per-user daily call cap (`LLM_DAILY_CALL_CAP`, default 400) bounds interactive
  command spam. Ingest-driven events (`embed`, `link`, `extract`, `stt`) are
  exempt so onboarding's fan-out doesn't burn a user's day-one budget.

### What the `tier` field is now

`LlmRequest.tier` and `Prompt.tier` (`"cheap" | "frontier"`) still exist and
callsites/prompts still set them, but **routing ignores them** — they're advisory
metadata only. This was kept on purpose so the ~40 callsites and every
`prompts/*.v1.ts` compiled unchanged when tiers were collapsed. If you want to
reintroduce differentiated routing later, `tier` is the hook; don't delete it.

### Switching models

Set `MODEL_CHAT=<openrouter-model-id>` in the env and redeploy. No code change.
Update the price entry in `gateway.ts` (`PRICE`) so cost metering stays honest.

### Embeddings are separate

GLM 5.2 is chat-only. Embeddings go through `src/llm/embeddings.ts`: OpenAI
(`OPENAI_API_KEY`) when set, else Qwen/DashScope (`QWEN_API_KEY`). DashScope caps
a request at 10 inputs, so batches are chunked to 10 (`MAX_BATCH_SIZE`).

### History

The routing used to be a tier system (cheap / cheap_floor / frontier) with
per-tier OpenRouter fallback chains down to legacy direct providers
(Anthropic / Kimi / Qwen), plus a `NO_SILENT_DOWNGRADE` set that made
diagnosis/voice queue-retry rather than complete on a lesser model. All removed
in the single-model simplification. `git log` on `src/llm/gateway.ts` has the
full prior implementation if it ever needs to come back.

---

## 3. Subsystems

| Area | Path | What it does |
|---|---|---|
| Telegram bot | `src/telegram/` | grammY bot, command handlers, conversation state, `/settings`. Commands: `start, help, connect, diagnose, diagnosis, goals(implicit), plan, ask, draft, check, voice, positions, repurpose, peers, forget, settings, status, upgrade, clear, demo`. Plain-language equivalents of most commands run through the agentic chat layer (see §3a). |
| Strategist flow | `src/strategist/` | The a16z Personal Brand Strategist onboarding. Profile-first arc: profiling (Stages 1-7) → connect → gap analysis → three-month plan → proactive. `session-machine.ts` is the state machine; `state.ts` persists it; `profile.ts` owns the stated profile; `gap.ts` computes the stated-vs-actual gap. See §3b. |
| Capture pipeline | `src/capture/` | Immutable capture of user input + imports (X via twitterapi.io→Apify, LinkedIn via Apify). Captures are never mutated. |
| Memory core | `src/memory/` | Extraction → embed → link → search (RRF hybrid). `positions.ts` (stated positions), `confidence.ts`, `forget.ts` (hard delete). |
| Voice | `src/voice/` | Voice profile from a user's own corpus; used to ground drafting. |
| Consistency | `src/consistency/` | Pre-publish check: does a draft contradict a stated position? Embed → match positions → LLM meaning-level compare. |
| Drafting | `src/drafting/` | `angle-draft.ts` (3 ways to tell a story), `draft.ts`, `repurpose.ts` (transform, not regenerate). |
| Trends | `src/trends/` | Provider registry with ordered fallback (`TREND_PROVIDER`: apify → brave → tavily). Actor ids in config are verified against live runs — see provider files for field shapes. |
| Engagement | `src/engagement/` | Reply-worthiness scored in code (`scoring.ts`); the model only drafts. One draft per slot; DMs out of scope. |
| Benchmark / peers | `src/benchmark/` | Peer benchmarking as territory, not scoreboard; relative-only. |
| Surfacing | `src/surfacing/` | Deterministic resurfacing selection (`scoring.ts`), cadence, nudges. LLM only composes the message. |
| Jobs | `src/jobs/` | pg-boss workers: extract, embed-link, cluster, resurface, offer-angles, trend-fetch, trend-match, weekly-plan, transcribe. `boss.ts`/`workers.ts` wire them. |
| Billing | `src/billing/` | DodoPayments (merchant of record). Webhook `webhook.ts` (Standard Webhooks sig), `entitlements.ts`, `PAYWALL_ENABLED` gate. |
| STT | `src/stt/` | Speech-to-text, tried in order: Sarvam → Groq → OpenAI Whisper. |
| Usage | `src/usage/` | `meter.ts` writes `usage_events` for every LLM/embed call (cost visibility, daily cap). |
| Prompts | `src/prompts/*.v{n}.ts` | Versioned prompt files (never inline strings; `converse` is at v2). `types.ts`, `style.ts`. |
| Lib | `src/lib/` | `apify.ts`, `alerts.ts` (admin DM on job failure, throttled), `auth.ts`, `kmeans.ts`, `time.ts` (quiet hours), `voice-stats.ts`. |

---

## 3a. The agentic chat layer (how a message becomes a turn)

The steady-state conversation is a tool-calling agent, not a classify-and-reply
chatbot. As of 2026-07-10:

**Delivery path.** The Telegram webhook (`routes/webhooks.ts`) acks immediately,
dedupes recent `update_id`s in memory (single instance by design), and processes
the update detached — a slow LLM turn can no longer trigger Telegram redelivery
and replay itself. `bot.init()` runs eagerly in `index.ts` because we call
`bot.handleUpdate` directly.

**Turn discipline.** All free-text input funnels through
`telegram/turns.ts#runSerializedTurn`: one turn per user at a time; messages
arriving mid-turn are merged (newline-joined) into a single follow-up turn, so a
thought typed as three fragments gets one considered reply. The typing indicator
is kept alive for the whole turn (`withTyping`, 4.5s heartbeat).

**Routing inside a turn** (`bot.ts#handleTextTurn`):
1. Deterministic connect fast-path — plain-language "read my x @handle" scrapes
   immediately, but only when the message has a first-person ownership cue
   (`detectConnectIntent().owned`) or the user hasn't been read yet
   (stage `new`/`connected`/`awaitingConnect`). Someone else's handle in chat
   goes to the brain instead.
2. Onboarding phases → the paced strategist session (`session-machine.ts`),
   unchanged.
3. Everything else → `conversation.ts#converseWithUser` with the `converse.v2`
   prompt, which returns `{reply, tool?, capture, offer_angles}`.

**Tools.** The brain may call at most ONE tool per turn, declared in
`telegram/chat-tools.ts` (zod, schemas only — no imports, so no module cycles)
and executed by `telegram/actions.ts#executeChatTool`: `draft_post`,
`repurpose`, `search_memory`, `check_draft`, `show_plan`, `show_positions`,
`show_status`, `refresh_diagnosis`, `connect_account`, `forget`. Each tool runs
the *same code path* as its slash command (the commands now call the shared
executors too), including entitlement gates. What a tool delivered is persisted
as an assistant turn so the next turn's history reflects what actually happened.
The executor is channel-based (`Channel = {say, typing?}`): live chat wraps
`ctx`, async paths wrap `sendTelegram` (`dmChannel`).

**Every input type gets an answer.** Voice notes are acked, transcribed
(`jobs/transcribe.ts`), then the transcript runs through the same brain and the
reply is DM'd (capture suppressed — the voice capture already exists).
Caption-bearing media routes the caption through the normal turn with an honest
"[attached media you can't see]" frame; captionless media and unsupported types
(stickers, polls, …) get a plain "text and voice only" reply instead of silence.

When adding a capability: add the schema to `chat-tools.ts`, the executor case
to `actions.ts`, document it in the `converse.v2` tool list, and keep the slash
command a thin wrapper over the same executor.

---

## 3b. Onboarding: profile-first, then the gap (Stages 1-11)

As of 2026-07-11 onboarding is **profile-first**. It draws out a stated brand
profile *before* reading history, so the diagnosis lands as a measured
stated-vs-actual gap rather than a cold read. The whole arc runs on the same
deterministic-reducer + paced-LLM engine as before.

**The arc.** `profiling` (Stages 1-7 intake) → `connect_transition` (Stage 8) →
connect + ingest + diagnosis → `gap_analysis` (Stage 10) → `plan_build` (Stage 11,
the three-month plan) → `active`. Phases live in `state.ts#SessionPhase`;
`isProfilingPhase`/`isOnboardingPhase` gate routing. Durable milestones on
`users.strategist_stage`: `new → profiling → profile_set → connected → diagnosed
→ plan_active` (the CHECK was widened in `0013`; old values kept).

**The stated profile.** `strategist/profile.ts` owns it: the `brand_profiles`
table (one row/user, migration `0013`), the ordered `PROFILE_FIELDS` the intake
walks (21 fields across 7 stages), the tone taxonomy + goal options, and the DB
helpers (`upsertProfileField`, `confirmPillars`, `finalizeProfile`,
`profileSummaryForPrompt` — NULL-aware, never fabricates). Nullable scalars =
unknown; `unresolved[]` records fields the user was pushed on once and still
couldn't answer.

**The intake loop.** `session-machine.ts#runProfilingTurn` + `applyProfileActions`
(pure, unit-tested). A `ProfileCursor` on `strategist_state` is the anti-loop
ledger; the machine deterministically asks the next uncaptured field, so it always
advances regardless of what the model emits. The `strategist-session.v2` prompt is
phase-conditional and gets both the current field's spec and the *following*
field's spec (avoids a one-turn lag on option-heavy fields). Push-once discipline
is enforced via the `pushed` ledger + `alreadyPushed` flag; a runaway backstop
force-resolves after `WATCHDOG.profiling` turns. Each answer persists turn-by-turn
(crash-safe + feeds the drop-off nudge).

**Tone multi-select** is an inline keyboard (`bot.ts#toneKeyboard`,
`maybeSendToneMenu`). Toggles write straight to `brand_profiles` (its own row — no
`strategist_state` race); "Done" marks the field captured and hands back to the
intake, all inside `runSerializedTurn` so the cursor write stays serialized.

**The gap analysis** (`gap.ts#computeGap`) is deterministic math, model only
interprets — same doctrine as `evidence.ts`/`performance.ts`. It measures:
positioning drift (cosine of idea/claim embeddings vs the stated niche vector, as
an off-niche %), goal alignment (inside-out ratio vs what the stated goal needs),
tone gap (selected taxonomy keys vs `voice-stats` measurements, incl. cross-cluster
tensions), audience fit, and the plain baseline (followers, cadence, top/bottom X
posts; LinkedIn perf acknowledged unavailable). `openGapSession` narrates it via
`gap-analysis.v1` as a paced reveal and stashes the gap text on state for the plan.

**The three-month plan** (`plan.ts#generateThreeMonthPlan` + `plan.v2`): a
repositioning statement, three month-by-month phases tied to the goal, named first
pieces from the unlock list, cadence taken from stated `posting_capacity` (not
asked). Persists throughline/unlock/outside-in + a `roadmap` jsonb (migration
`0014`). Delivered by `openPlanSession`; committed on confirmation via the existing
`plan_build` commit path.

**The escape hatch.** A user who drops a handle or says "just diagnose me" mid-
intake connects early and gets the **cold** diagnosis reveal (`openSession`);
`runDiagnosis` branches on `isProfileComplete` — gap reveal when a profile exists,
cold reveal otherwise. Legacy phases (`diagnosis_dialogue`/`goals`) are retained so
users mid-old-flow at deploy still route correctly.

**Drop-off nudges.** `surfacing/nudges.ts` adds `profile_stall` (intake idle
≥20h) and `connect_stall` (profile done, no account, idle ≥24h), deduped and
quiet-hours-aware like the other structural nudges.

**Downstream.** The stated profile grounds drafting (`draft.v1` gets pillars/tone/
formality and HARD-BLOCKS off-limits topics), steady-state chat (`converse.v2`
profile block + stage rules), and is available to consistency/plan. Rule: a draft
that crosses a stated constraint is a failure, not a draft.

---

## 4. Data model

Schema is a linear migration chain in `src/db/migrations/` (`0001`…`0014`),
applied on boot and via `pnpm db:migrate` (`src/db/migrate.ts`). pgvector is
required for embedding columns.

Design invariants:
- **Captures are immutable**; memories are derived and re-derivable from captures.
- **Forget is hard deletion**, not a tombstone.
- `brand_profiles` is the stated profile (one row/user, `0013`); it is user-stated
  input, distinct from `brand_diagnoses` (derived analysis). `/clear`
  (`resetUserData`) wipes it with everything else.
- `profile_id` is stored separately from `user_id` on memories/positions/moments
  (agency prep); they are equal in v1.

When adding a migration: next number in sequence, forward-only (no down
migrations), and it must apply cleanly on a fresh DB and an existing one.

---

## 5. Config & secrets

All config is parsed and validated once in `src/config.ts` (zod). Missing
optional keys degrade features gracefully; a bad enum fails loudly at boot.
`.env.example` is the canonical list — keep it in sync when you add a key.

Keys that matter most:
- `OPENROUTER_API_KEY` — **required** for any LLM feature (the only route).
- `MODEL_CHAT` — the single chat model (default `z-ai/glm-5.2`).
- `OPENROUTER_PROVIDER_IGNORE` — comma-separated OpenRouter host names to exclude
  when picking a GLM upstream (spec: US/EU hosts only).
- `OPENAI_API_KEY` / `QWEN_API_KEY` — embeddings (OpenAI preferred, Qwen fallback).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ADMIN_TELEGRAM_ID`.
- `TREND_PROVIDER` + `APIFY_TOKEN` / `TWITTERAPI_IO_KEY` / `BRAVE_API_KEY` / `TAVILY_API_KEY`.
- `DODO_*`, `PAYWALL_ENABLED`.

Never commit real secrets. Secrets in git history stay there forever even after
deletion — set them in the deploy dashboard only.

---

## 6. Ops

- **Deploy:** see [DEPLOY.md](../DEPLOY.md) (Railway). Single instance only.
- **Pre-deploy gate:** `pnpm verify` (typecheck + full unit suite). Don't ship red.
- **Migrations** run automatically on boot; also `pnpm db:migrate`.
- **Prod vs dev bot:** with `PUBLIC_URL=https://…` the bot uses webhooks; without
  it, long-polling. No flag to flip.
- **Alerts:** job failures/crashes DM `ADMIN_TELEGRAM_ID` via the bot (throttled).
- **Cost & abuse:** `usage_events` is the source of truth for per-user spend; the
  daily call cap (`LLM_DAILY_CALL_CAP`) bounds interactive spam.
- **Keep-alive:** `.github/workflows/keepalive.yml` pings the service to survive
  free-tier cold starts.

---

## 7. Conventions

- TypeScript, ESM, pnpm workspace. No ORM — raw SQL via `src/db/pool.ts`.
- Prompts are versioned files (`*.v1.ts`); bump the version, don't edit in place
  when you change a prompt's meaning.
- Deterministic logic stays in code; the LLM composes/drafts but does not decide
  selection, scoring, or reply-worthiness.
- Commit/PR prose: plain and direct, no fluff.
- Keep `.env.example`, this doc, and the README's "Latest updates" in sync with
  behavior changes — same PR.
