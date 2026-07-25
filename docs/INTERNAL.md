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

The backend's own HTTP surface is deliberately tiny: `/health` plus webhooks
(`/webhooks/telegram`, `/webhooks/dodo`) and the write-OAuth routes. The
user-facing web UI is a **separate Next.js app** (`packages/web`) that imports
backend domain functions in-process — see §8. Identity is the internal
`users.id` (uuid); a user row is created by **web sign-in** (Google/email) and
keyed by `email`. Telegram is now **web-account-gated** (2026-07-20): DMing the
bot no longer creates a row — the chat must be linked to an existing web account
via the deep-link token (Settings → Connect Telegram), which attaches
`telegram_id` to that row. An unlinked Telegram visitor is turned away with a
"sign in on the web first" message; the bot also subscription-gates every action
(`upgradeWall` → `!isPaidOrExempt`) and runs no onboarding.

Entry point: `src/index.ts` (Fastify + bot bootstrap, migrations on boot).

---

## 2. LLM gateway — one model, one path

> **2026-07-24: the one model is now `x-ai/grok-4.5`** (was `z-ai/glm-5.2`) — set via `MODEL_CHAT` env on both deploys and as the config default. Chosen for native X/cultural awareness (drafts, trend takes, buyer outreach). The GLM-era JSON recovery ladder, provider-ignore list, and reasoning-field fallback in `llm/gateway.ts` are model-agnostic and stay.

**Every model call routes through `src/llm/gateway.ts`. No module calls a provider
directly.** As of 2026-07-10 this is deliberately simple:

- One model for **all** requests (Grok 4.5), reached over one of two transports
  chosen by `LLM_TRANSPORT`: `openrouter` (default; `config.MODEL_CHAT`,
  cross-provider retry) or `xai` (direct `api.x.ai`, `config.XAI_MODEL`). xAI-direct
  unlocks the `x-grok-conv-id` cache-affinity header, `cached_tokens` in the usage
  payload, and native `reasoning_effort`. The switch is a one-env-var rollback;
  `gateway.ts` stays the single path either way. **No multi-provider fallback chain.**
- **Cache affinity + reasoning effort (2026-07-24 cost spec):** `LlmRequest.cacheKey`
  (build with `hashForCacheKey`, never a raw id) routes same-key calls to one server
  so the prefix cache is warm — the code is correct at a 0% hit rate, a warm cache is
  opportunistic. `tier` now maps to `reasoning_effort` (`frontier→high`, everything
  else→`low`); reasoning tokens bill at the output rate, so this is the biggest
  per-call lever. On xAI it's the `x-grok-conv-id` header + `reasoning_effort`; on
  OpenRouter it's `session_id` + `reasoning:{effort}`. **Wired (2026-07-24):** the
  chat turn passes one `cacheKey` across all its tool-loop iterations (`converse` +
  `runToolLoop`), and `converse` computes `now` once per turn so the user-message
  front is byte-stable across iterations (only appended tool notes vary). Loop
  context is append-only (`toolNotes` push-only); `reasoning_content` replay is N/A
  — the gateway sends a fresh system+user pair per iteration, not a replayed
  assistant transcript. **Native structured output (§5):** `LlmRequest.jsonSchema`
  → `response_format: json_schema` (opt-in per call); on a 400 the degrade drops it
  and the JSON ladder still runs (kept as fallback). `ladderEntryCounts()` /
  `json-ladder-entry` logs track which prompts still hit the ladder — a prompt that
  never does under a schema can drop it; one that keeps doing signals a too-tight
  `max_tokens`, not a flaky model.
- `llmCall(req)` does: per-user daily cap check → single provider call with
  retries (`withRetries`, 3 attempts, backoff on 429/5xx/timeout) → for
  `json: true`, a **bounded JSON recovery ladder** (2026-07-13 — GLM's flaky
  JSON was silently killing resurface/mentions/clustering/trend-compose jobs):
  1. `extractJson` — string/escape-aware balanced-slice parse, tolerating code
     fences (even unterminated), leading AND trailing prose, trailing commas.
  2. finish_reason `"length"` → the JSON was truncated: re-run once with a
     doubled token budget (capped 4096). GLM front-loads prose before the JSON,
     so tight budgets cut the JSON off mid-structure.
  3. Repair, not re-ask: hand the model its OWN previous output and ask it to
     convert that to the required JSON (the old "corrective retry" re-asked
     cold and just re-rolled the same dice; live it failed back-to-back).
  4. `salvageTruncatedJson` — last resort: close open strings/brackets and
     parse, chopping the broken tail if needed, so a cut-off array degrades to
     its complete items instead of a dead job. Logged with a `salvage used`
     warning; callers zod-validate whatever comes out.
  Also fixed at the source: GLM is a hybrid reasoning model and some providers
  return the whole answer in `message.reasoning` with empty `content` —
  `callModel` now falls back to `reasoning` text, which used to surface as
  "no JSON found" on calls that had actually answered.
  - `asObject(res.parsed)` (exported from `gateway.ts`, 2026-07-13): GLM also
    emits valid-but-wrong-*shape* JSON — the single object wrapped in an array
    (`[{...}]`) or split across array elements. That parses fine so the ladder
    above never sees it, but a caller's `schema.parse` then threw a raw Zod
    "expected object, received array" and killed the turn (hit live when a user
    asked to change a draft mid-chat). `asObject` shallow-merges array-of-objects
    back into one object; `conversation.ts` now runs it before a `safeParse` and
    degrades to a soft nudge instead of the glitch line on any residual mismatch.
    Other object-parsing call sites (draft/repurpose/angle) can adopt it too.
- Cost metering: every call writes a row to `usage_events` (`src/usage/meter.ts`).
- Hard per-call timeout via `fetchWithTimeout` (`LLM_PROVIDER_TIMEOUT_MS`, default 45s).
- Per-user daily call cap (`LLM_DAILY_CALL_CAP`, default 400) bounds interactive
  command spam. Ingest-driven events (`embed`, `link`, `extract`, `stt`) are
  exempt so onboarding's fan-out doesn't burn a user's day-one budget.

### What the `tier` field is now

`LlmRequest.tier` / `Prompt.tier` (`"none" | "cheap" | "frontier"`) now **map to
`reasoning_effort`** in the gateway: `frontier→high`, `cheap`/`cheap_floor`/`none→low`
(`none` is a placeholder for a true no-reasoning mode should one land). This is the
2026-07-24 revival of the field that was previously advisory-only. Composition
prompts that are the product (`draft.v1`, `reply-draft.v2`, `trend-take.v2`) are kept
`frontier` (=high) until the §10 A/B decides whether `low` flattens voice — a cheaper
draft that doesn't sound like the user is a worse outcome than a larger bill. The
JSON-repair rung forces `none` (reformatting needs no deliberation).

### Cost metering (cached tokens)

`PRICE` is `{ in, cachedIn, out }` per 1M (grok-4.5: $2 / $0.50 / $6, confirm from the
console). `cost()` bills `(in−cached)·in + cached·cachedIn + out·out`. `usage_events`
carries `cached_input_tokens` (nullable — NULL = transport didn't report it, ≠ 0) and
`reasoning_effort` (migration `0028`); `usageSummary` exposes `cache_hit_rate`
(cached ÷ input), the primary success metric for the cache work. `LLM_DEBUG=1` logs
the raw `usage` payload so the live `cached_tokens` location can be confirmed.

### Switching models / transports

Set `MODEL_CHAT` (OpenRouter) or `XAI_MODEL` (xAI) + `LLM_TRANSPORT` in the env and
redeploy. No code change. Update the `PRICE` row so cost metering stays honest.

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
| Telegram bot | `src/telegram/` | grammY bot, command handlers, conversation state. Commands (deliberately lean): `start, help, connect, draft, repurpose, peers, settings, upgrade`. `/connectposting` was removed 2026-07-13 — `/connect` is the only connect command. The scheduling engine is built and tested, but its user-facing surface (`/scheduled`, the `schedule_post` chat tool) is deliberately not wired in yet — see §3e. Everything else (check, search/ask, status, diagnosis refresh, voice, forget, positions, clearing your account) is done in plain language via the agentic chat layer (see §3a). |
| Strategist flow | `src/strategist/` | The a16z Personal Brand Strategist onboarding. Profile-first arc: profiling (Stages 1-6, 7 fields) → connect → **brand diagnosis (terminal free step)** → paywall/steady-state. The three-month plan was removed from the funnel 2026-07-13 (see §3b). `session-machine.ts` is the state machine; `state.ts` persists it; `profile.ts` owns the stated profile; `gap.ts` computes the stated-vs-actual gap. See §3b. |
| Capture pipeline | `src/capture/` | Immutable capture of user input + imports (X via twitterapi.io→Apify, LinkedIn via Apify). Captures are never mutated. |
| Memory core | `src/memory/` | Extraction → embed → link → search (RRF hybrid). `positions.ts` (stated positions), `confidence.ts`, `forget.ts` (hard delete), `classification.ts` (rhetorical mode/sincerity/motive taxonomy + gating helper), `corrections.ts` (user-correction mechanism + monthly recalibration). See §3d. |
| Voice | `src/voice/` | Voice profile from a user's own corpus; used to ground drafting. |
| Consistency | `src/consistency/` | Pre-publish check: does a draft contradict a stated position? Embed → match positions → LLM meaning-level compare. Ambiguous matches (top-2 within `CONSISTENCY_AMBIGUITY_DELTA`) escalate to a bounded agent (see §3c). |
| Drafting | `src/drafting/` | `angle-draft.ts` (3 ways to tell a story), `draft.ts`, `repurpose.ts` (transform, not regenerate). |
| Trends | `src/trends/` | **X trend discovery is cluster-first** (`trends/discover-x.ts`, 2026-07-12): same-day tweets → LLM-clustered into searchable topic TERMS (`prompts/trend-clusters.v1.ts`) → each verified for live volume and grounded in a driving source tweet. Falls back to the interest terms themselves when GLM's cluster JSON flakes. Interest terms are LLM-distilled (`prompts/trend-themes.v1.ts`, `jobs/trend-fetch.ts#interestThemes`) into short professional search terms. The old provider registry (`TREND_PROVIDER`: apify → brave → tavily, verbatim-tweet trends) remains only as the fallback when twitterapi isn't configured. `scoring.ts` (deterministic buzzScore) + `providers/twitterapi.ts` (advanced_search volume verification) gate the macro-moment agent, which delivers a daily *band* of fresh, source-grounded takes (§3c). |
| Engagement | `src/engagement/` | Reply-worthiness scored in code (`scoring.ts`); the model only drafts — now via a bounded agent (`reply-agent.ts`, §3c) grounded by `heuristics.ts` (deterministic visibility facts). One draft per slot; DMs out of scope. |
| Benchmark / peers | `src/benchmark/` | Peer benchmarking as territory, not scoreboard; relative-only. |
| Surfacing | `src/surfacing/` | Deterministic resurfacing selection (`scoring.ts`), cadence, nudges. LLM only composes the message. |
| Jobs | `src/jobs/` | pg-boss workers: extract, embed-link, cluster, resurface, offer-angles, trend-fetch, trend-match, weekly-plan, transcribe, campaign-detect, classification-recalibrate, scheduled-post. `boss.ts`/`workers.ts` wire them. |
| Scheduling | `src/scheduling/` + `src/social/` | Native scheduled posting. `scheduling/service.ts` queues/lists/cancels; `jobs/scheduled-post.ts` publishes at fire time; `social/publish.ts` calls the X/LinkedIn write APIs; `routes/oauth.ts` is the user-context OAuth (onboarding connect §3f + posting §3e), with `telegram/connect-auth.ts` running the offer/skip sequence. |
| Billing | `src/billing/` | DodoPayments (merchant of record). Webhook `webhook.ts` (Standard Webhooks sig), `entitlements.ts`, `PAYWALL_ENABLED` gate. |
| STT | `src/stt/` | Speech-to-text, tried in order: Sarvam → Groq → OpenAI Whisper. |
| Usage | `src/usage/` | `meter.ts` writes `usage_events` for every LLM/embed call (cost visibility, daily cap). |
| Analytics | `src/analytics/` | Product analytics via PostHog (`posthog-node`, server-side — no web frontend so no browser snippet). `posthog.ts` exposes `track`/`identify`/`shutdownAnalytics`, gated on `POSTHOG_API_KEY` (unset → silent no-op). Events fired at funnel choke points; metadata only, never raw content. See §3g. |
| Prompts | `src/prompts/*.v{n}.ts` | Versioned prompt files (never inline strings; `converse` is at v3, `reply-draft` and `consistency-check` at v2). `types.ts`, `style.ts`. |
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
is kept alive for the whole turn (`withTyping`, 4.5s heartbeat). The slow inline-
button handlers (angle→draft, repurpose, make-angles, voice build) also run their
work inside `withTyping` (2026-07-13): they `answerCallbackQuery` immediately to
clear the button spinner with a toast, then the heartbeat keeps "typing…" alive
for the full 15-30s LLM op — a one-shot `replyWithChatAction` only lasts ~5s and
left dead air on every button that does model work.

**Routing inside a turn** (`bot.ts#handleTextTurn`):
1. Deterministic connect fast-path — plain-language "read my x @handle" scrapes
   immediately, but only when the message has a first-person ownership cue
   (`detectConnectIntent().owned`) or the user hasn't been read yet
   (stage `new`/`connected`/`awaitingConnect`). Someone else's handle in chat
   goes to the brain instead.
2. Onboarding phases → the paced strategist session (`session-machine.ts`),
   unchanged.
3. Everything else → `conversation.ts#converseWithUser` with the `converse.v3`
   prompt — a bounded multi-tool loop (2026-07-11, replaced the v2 single call).

**Tools + the turn loop.** Tools are declared in `telegram/chat-tools.ts` (zod,
schemas only — no imports, so no module cycles) and executed by
`telegram/actions.ts#executeChatTool`: `draft_post`, `repurpose`,
`search_memory`, `check_draft`, `show_plan`, `show_positions`, `show_status`,
`refresh_diagnosis`, `connect_account`, `forget`, `clear_everything`. Most
tools run the *same code path* their slash command used to (some, like
`show_plan`/`show_positions`/`clear_everything`, never had one — plan,
positions, and clear are chat-only). Entitlement gates still apply.

The brain may chain up to `MAX_TOOL_CALLS_PER_TURN` (config, 3) tool calls in
one turn: `converseWithUser` calls the model, and when the steady-state
executor (`actions.ts#chatToolExecutor`) is passed, each requested tool runs
immediately (its output delivered in-chat), a compact `tool → result` note is
appended to the turn's context (never the raw payloads), and the model is
called again until it answers without a tool. Guardrails: hard call cap; the
same tool with the same args twice in one turn is rejected and forces a final
reply; each tool delivery (and any mid-turn reply beat) is persisted as its own
assistant-turn fragment, so a 3-tool turn shows up as 3 fragments in history,
not one opaque blob. The paced onboarding session (`session-machine.ts`) still
uses the legacy single-tool path (no executor passed → the first tool is
returned to `deliverTurnOutput` as before). The executor is channel-based
(`Channel = {say, typing?}`): live chat wraps `ctx`, async paths wrap
`sendTelegram` (`dmChannel`).

`clear_everything` is the one destructive tool: it never wipes anything itself,
it only surfaces the same `clr:confirm`/`clr:cancel` inline buttons the removed
`/clear` command used, and the existing `callback_query:data` handler in
`bot.ts` does the actual wipe + onboarding restart. The prompt is instructed to
call it only on an unambiguous "wipe everything / start completely over"
request — never on vague frustration or a request to forget one specific
thing (that's the separate `forget` tool).

**Every input type gets an answer.** Voice notes are acked, transcribed
(`jobs/transcribe.ts`), then the transcript runs through the same brain and the
reply is DM'd (capture suppressed — the voice capture already exists).
Caption-bearing media routes the caption through the normal turn with an honest
"[attached media you can't see]" frame; captionless media and unsupported types
(stickers, polls, …) get a plain "text and voice only" reply instead of silence.

When adding a capability: add the schema to `chat-tools.ts`, the executor case
to `actions.ts`, document it in the `converse.v3` tool list, and keep the slash
command a thin wrapper over the same executor.

**Voice: casual for Yoinky, polished for the user's feed** (2026-07-11). There are
two registers and they must not bleed into each other, because they share
`prompts/style.ts`:
- **Yoinky's own chatter** (chat replies, onboarding questions, the
  diagnosis/gap/plan reveals, proactive DMs, plan/progress reads) is casual
  texting: lowercase, short, contractions, dry. Driven by the `CASUAL_VOICE`
  block, which is appended *after* `CHAT_STYLE_RULES` in the ~13 Yoinky-voice
  prompts, plus the deterministic `casualize()` backstop (enforceStyle + lowercase
  the opener, leaving proper-noun/acronym openers like LinkedIn/AI/X alone).
  `casualize()` runs at the finalization points: `conversation.ts`,
  `session-machine.ts` replies, and inside `sendTelegramSequence`.
- **Content written for the user's public feed** (post drafts, reply drafts,
  repurposed posts, angle hooks) stays properly capitalized. Its prompts
  (`draft.v1`, `reply-draft.v2`, `repurpose.v1`, `generate-angles.v1`, the
  `embedded_draft` field of `trend-take.v2`) use
  `CHAT_STYLE_RULES`/`POST_WRITING_RULES` but **must never** get `CASUAL_VOICE`,
  and `casualize()`/`enforceStyle` is never run over their output as a
  lowercasing pass. `sendTelegram` (single-message) is deliberately NOT
  casualized because it carries this content; only `sendTelegramSequence` is.
  When a chat wrapper embeds content (e.g. `"✍️ here you go:\n\n{draft}"`), only
  the label is casual — the draft body keeps its own capitalization.

**Reach/copywriting layer: `REACH_PRINCIPLES`** (2026-07-13, `prompts/style.ts`).
`POST_WRITING_RULES` governs *how the words are built* (sentence craft, anti-AI-tells,
narrative structure). `REACH_PRINCIPLES` is a companion block governing *what makes a
published post travel and earn a reply* — the strategy layer distilled from the
x-copywriting skill (`docs/x-copywriting-personal-branding-skill.md`, the full source):
first-30-60-min reply velocity, replies weighted over likes,
links-to-first-reply (never in body), Schwartz awareness levels (open at insight, the
reader is already problem/solution-aware), and the connection drivers behind
replies/saves. Injected into the prompts that write content the user **publishes** —
`draft.v1`, `generate-angles.v1`, `repurpose.v1`, and the `embedded_draft` of
`trend-take.v2`. Deliberately **not** in `reply-draft.v2`: a reply into someone else's
thread is a different game (hooks/threads/media don't apply), and its own doctrine is
already tuned. It is scoped to the feed/"properly-written" side exactly like
`POST_WRITING_RULES`, never the casual side.
- **Reconciled against `POST_WRITING_RULES`, not stacked blindly** (the conflicts were
  decided explicitly). Adopted: grounded **contrarian + real-number hooks** are allowed
  openers (the ban on bait-label openers like "Unpopular opinion:" stays); a **soft,
  genuine closing invitation** is allowed (engagement-bait like "tag someone" stays
  banned); **thread-lean-for-depth** — `POST_WRITING_RULES` platform calibration now
  defaults X to a thread when the idea has real sequential beats, still never padded.
  Held to the stricter existing register: no guru power-words, emoji still voice-profile-
  gated, and numbers must be grounded in a real memory (never invented for a hook). Where
  the two documents touch the same rule, they state it identically.
- **Media suggestion.** The draft engine (`draft.v1`) now emits a `media_suggestion`
  field (concrete visual to pair with the post, or `""` for genuinely text-only posts).
  It flows through `DraftResult.mediaSuggestion` / `AngleDraftResult.mediaSuggestion` and
  renders as a casual `📎 pair it with: …` line under the draft in both delivery paths
  (`telegram/actions.ts` `deliverDraft`, `telegram/bot.ts` angle-draft handler). Not
  persisted — it's ephemeral guidance, not part of the draft body.

**Message tracking + wiping everything** (`telegram/message-log.ts`, added
2026-07-11; the `/clear` command itself was removed 2026-07-11, superseded by
the `clear_everything` chat tool above — the mechanism below is unchanged).
Telegram gives bots no "list messages in a chat" API, so actually clearing the
visible chat on a wipe requires recording every message_id as it happens — it
cannot be backfilled for history that predates this. Two hooks, both
registered once in `createBot()` right after `new Bot(...)`:
- **Outgoing:** `trackOutgoingMessages`, a `bot.api.config.use(...)` transformer.
  It filters on "does the response carry a `message_id`" rather than a
  hardcoded method list, so any send-shaped call is covered automatically and
  non-message calls (`answerCallbackQuery`, `setMyCommands`, …) are naturally
  skipped. grammY re-applies transformers installed on `bot.api.config` to
  every per-update `ctx.api` instance AND to direct `bot.api.*` calls made from
  job/worker code with no `ctx` in scope (`sendTelegram`, `sendTelegramSequence`)
  — one registration covers the whole app.
- **Incoming:** a `bot.use(...)` global middleware checking `ctx.update.message`
  directly (never `ctx.message`, which would also resolve for other update
  shapes) and `ctx.chat?.type === "private"`.
- Both write to `telegram_messages` (migration `0015`, one row per message).
  The `clr:confirm` callback handler in `bot.ts` calls
  `deleteAllTrackedMessages(ctx.api, userId)` — chunks ids into batches of 100
  (the `deleteMessages` API cap),
  falling back to per-message `deleteMessage` calls if a batch fails, never
  throwing — BEFORE `resetUserData`, since that wipes `telegram_messages` along
  with everything else. Best-effort by design: a message too old or already
  gone doesn't block the rest of the wipe.

---

## 3b. Onboarding: profile-first, then the gap (Stages 1-11)

> **Web-only as of 2026-07-20.** Onboarding no longer runs on Telegram at all —
> the bot is auth-/subscription-gated and just chats (see §3i and the Telegram
> section below). The conversational, LLM-driven intake described here
> (`session-machine.ts`) is now reached *only* if something still drives the
> `profiling` phase; the live web path is the structured form wizard
> (`web/onboarding-form.ts`, §3i). This section documents the conversational
> engine, which the web wizard bypasses and Telegram no longer invokes.

As of 2026-07-11 onboarding is **profile-first**. It draws out a stated brand
profile *before* reading history, so the diagnosis lands as a measured
stated-vs-actual gap rather than a cold read. The whole arc runs on the same
deterministic-reducer + paced-LLM engine as before.

**The arc.** `profiling` (Stages 1-6 intake) → `connect_transition` (Stage 7,
OAuth-first when the platform apps are configured — see §3f) →
connect + ingest + diagnosis → **the brand diagnosis reveal is the last free
step.** Phases live in `state.ts#SessionPhase`; `isProfilingPhase`/
`isOnboardingPhase` gate routing.

**The diagnosis is the terminal free step (2026-07-13).** There is no longer a
goals phase or a three-month plan in the onboarding funnel. `openGapSession`
(profile-first) / `openSession` (cold arc) deliver the diagnosis reveal, then
call `concludeAfterDiagnosis(userId)`, which clears the onboarding state and
routes on entitlement: paid/whitelisted users go straight to `active` (steady-
state chat, all features); everyone else is parked at the new
`awaiting_upgrade` stage behind the paywall and shown the upgrade offer once.
The old `gap_analysis`/`goals`/`plan_build` phase code in
`session-machine.ts#runSessionTurn` + `openPlanSession`/`generateThreeMonthPlan`
is retained but is no longer reachable by new users (legacy mid-flow users at
deploy still resolve). Durable milestones on `users.strategist_stage`:
`new → profiling → profile_set → connected → diagnosed → awaiting_upgrade →
active` (the CHECK was widened in `0013`; old values incl. `plan_active` kept).

**Post-diagnosis paywall / hard wall (2026-07-13).** Once a non-exempt user is at
`awaiting_upgrade`, every further action returns the same preset upgrade offer
with **no LLM or external-API call behind it** — they cannot chat, draft,
repurpose, connect, send a voice note, or tap a content button until they
upgrade. The single choke point is `bot.ts#upgradeWall(user)`: returns the offer
(and blocks) at `awaiting_upgrade` unless `isPaidOrExempt`, in which case it
lazily promotes the user to `active` and lets them through. Applied at the top of
`handleTextTurn`, the voice-note handler, the LLM/API commands (`/draft`,
`/repurpose`, `/connect`, `/peers`), and the content callback buttons (`ang`,
`mkang`, `dxang`, `dxsyn`, `rpz`, `nudge:voice`). Exemption
(`billing/entitlements.ts#isPaidOrExempt`): paywall off entirely → everyone
exempt; else whitelisted (`whitelistIncludes`: `PAYWALL_WHITELIST` csv +
`ADMIN_TELEGRAM_ID`, always exempt so the operator never upgrades themselves); else
a real paid/founding plan. The offer copy/keyboard is one shared builder,
`billing/upgrade-offer.ts#buildUpgradeOffer` (also used by `/upgrade` and the
conclusion message), so benefits never drift. NOTE: `FREE_DRAFT_ALLOWANCE` is now
superseded — the wall blocks drafting entirely before that allowance is ever
consulted.

**Commands (2026-07-13).** `/connectposting` was removed (command + `setMyCommands`
entry); `/connect` is the only connect command. `/start` now leads with a single
`CAPABILITIES` blurb (`bot.ts`, the one place to edit as features ship; `/help`
renders from it too) before the profile opener.

**The stated profile.** `strategist/profile.ts` owns it: the `brand_profiles`
table (one row/user, migration `0013`), the ordered `PROFILE_FIELDS` the intake
walks, the tone taxonomy + goal options, and the DB helpers
(`upsertProfileField`, `confirmPillars`, `finalizeProfile`,
`profileSummaryForPrompt` — NULL-aware, never fabricates). Nullable scalars =
unknown; `unresolved[]` records fields the user was pushed on once (or
explicitly skipped) and still didn't answer.

**Trimmed to 7 fields (2026-07-11, two passes).** The intake originally asked
21 fields across 7 stages; it's now: `niche` (1) → `primary_goal` (2) →
`audience_who` (3) → `inspiration_creators`, `tone_selections` (4) →
`content_pillars` derived + confirmed (5) → `camera_comfort` (6, last question).
The deeper positioning/audience/constraints/platform fields (`sub_niche_angle`,
`credibility_source`, `unique_pov`, `secondary_goals`,
`audience_sophistication`, `audience_pain_point`, `formality_gradient`,
`vulnerability_threshold`, `visual_comfort`, `primary_platform`,
`platform_adaptation`, `posting_capacity`, and the entire old Stage 7
constraints trio `employer_restrictions`/`topics_off_limits`/`anonymity_needs`)
were cut for a faster, less form-like onboarding. Their `brand_profiles`
columns stay (additive schema, no drops) and downstream code that reads them
(`gap.ts`, `plan.ts`, `draft.ts`'s off-limits hard-block) is null-aware and
degrades gracefully — those specific findings just never fire for new users.
`FIELD_STAGE`/`fieldSpec`/`FALLBACK_QUESTION` are keyed only off the current
`PROFILE_FIELDS`, so re-adding a field later means updating those three plus
`profile.ts`'s `ARRAY_FIELDS`, nothing else.

**Explicit skip always advances (2026-07-11).** "let's skip this", "next
question", "pass", "move on" etc. are matched deterministically
(`session-machine.ts#detectSkipIntent`), not left to the model — a model that
fails to recognize an explicit decline just re-asks the same question forever.
On a match, the current field is captured as `unresolved` and the intake
advances on the first try, regardless of whether the model's own JSON emission
got it right. Distinct from `push_field` (which is for vague-but-attempted
answers): an explicit skip is honored immediately, no push.

**Skip buttons + skip-all (2026-07-17).** Every intake question now ships with a
two-button inline keyboard — `onboardingSkipKeyboard()` in `telegram/actions.ts`
— shown under the `/start` opener, each resumed question, and every profiling
turn (`deliverTurnOutput`'s `onboardingSkip` option, gated on the phase still
being `profiling`). **skip this step** (`obskip:step`) re-drives the turn with
the text "skip this question", reusing `detectSkipIntent` so exactly one path
handles both taps and typed skips. **skip onboarding** (`obskip:all`) calls
`session-machine.ts#skipAllIntake`, which marks every uncaptured field
`unresolved`, runs `finalizeProfile`, sets stage `profile_set`, and jumps to
`connect_transition` — same end state as answering every question, so the
diagnosis still runs (off a thinner stated profile). Both handlers live in the
`callback_query:data` router in `bot.ts` and run inside `runSerializedTurn`.

**Reveals trimmed for length (2026-07-17).** The diagnosis and gap reveals were
long: `diagnosis-reveal.v1` / `gap-analysis.v1` now target 3–4 messages (was
5–8), cap 350 chars (was 500) and 3 bullets (was 4) per message, and the
`openSession` / `openGapSession` LLM calls dropped from 2200/2500 to 1500
`maxTokens`.

**Array fields can double-encode (fixed 2026-07-11).** The model sometimes
emits an array-valued field (`inspiration_creators`, `tone_selections`,
`content_pillars`) as one JSON-stringified string instead of a real JSON array.
`profile.ts#normalizeArray` defends against this: tries `JSON.parse` on a
bracketed string first, then comma-splits, before ever treating the string as
one opaque item. Verified live — this was silently corrupting stored arrays
into a single garbled string element.

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

## 3c. Bounded agent loops (2026-07-11)

Four features run a **bounded agent loop** instead of one fixed-context LLM
call: the model gets a small toolset and can make a few research calls before
it must commit. The doctrine is unchanged — deterministic code still decides
*whether* anything fires (selection, scoring, gating); the loop only buys the
model grounding before it composes.

**Shared runner** — `llm/tool-loop.ts#runToolLoop`. Envelope convention: each
model response is JSON with an optional `"tool"` key; `tool: null` means the
rest of the object is the final output. Guardrails baked into the runner:
- Hard `maxToolCalls` cap per feature (config, 2–4). Hitting it forces a final
  answer. No open-ended ReAct loops, ever.
- Same tool + same args twice in one loop → rejected, forces a final answer
  (the anti-loop ledger pattern from the profiling intake).
- Every step is console-logged and returned as `steps`, which callers persist
  (surfacing payloads carry `agent_steps`) — inspectable, never a black box.
- Every call goes through `llm/gateway.ts` → `usage_events`. No new call path.
- Tool *schemas* live in a `*/tools.ts` file with no imports (the
  `chat-tools.ts` rule); executors live at the callsite.

The chat turn loop (§3a) is the same pattern but bespoke in `conversation.ts`,
because its tools have chat side effects (deliveries, turn persistence).

**The three runner-based loops:**

| Loop | Deterministic gate (code, before any loop runs) | Tools | Cap |
|---|---|---|---|
| Macro-moment (`jobs/trend-match.ts` → `trend-take.v2`) | daily-band gate (`MAX_DAILY_TREND_SENDS`, checked *before* provider spend) → niche gate (pgvector vs positions, `NICHE_THRESHOLD`, *before* any paid twitterapi.io call) → buzz gate (`trends/providers/twitterapi.ts` two-pass advanced_search → `trends/scoring.ts#buzzScore` > `BUZZ_THRESHOLD`; distinct authors weigh more than raw tweet count) → **rank survivors by buzzScore, iterate top-down** → position gate (macro-match.v1, now run PER-TREND: a yes/no on one candidate, not a cross-trend pick) | `get_top_tweets` (cached verified pool w/ permalinks, no new spend), `search_memory`, `get_voice_profile`, `get_goals_and_pillars`, `get_positions` | 4 |
| Consistency (`consistency/check.ts` → `consistency-check.v2`) | two escalation signals, both code-decided: top-2 position matches within `CONSISTENCY_AMBIGUITY_DELTA` (from embeddings, before any model call), OR the single-shot v1 pass returns `confidence < CONSISTENCY_CONFIDENCE_THRESHOLD` (a shaky first read is escalated, not acted on). The confident, clean-match common case stays single-shot v1 | `search_more_positions`, `get_position_context`, `search_memory` | 3 |
| Reply drafting (`engagement/reply-agent.ts` → `reply-draft.v2`) | reply-worthiness scoring + learned threshold (`engagement/scoring.ts`) — untouched, decides *whether* to draft at all | `search_memory`, `get_voice_profile`, `get_content_pillars`, `get_thread_context`, `get_engagement_heuristics` | 3 |

Notes worth knowing:
- **Macro-moment delivery** is distinct: surfacing type `trend_take` (migration
  0016, in `PROACTIVE_TYPES` so it shares the unified budget + quiet hours), a
  `⚡`-framed DM with no 🔥/💤/🗑 resurfacing card. The agent may return
  `fires: false` — a skipped moment costs nothing, a forced one costs trust; a
  declined trend doesn't burn the band (only a *sent* take counts), but the
  trend itself is dedup'd via its moment row. Without `TWITTERAPI_IO_KEY` the
  buzz gate can't run and the pipeline degrades to the old niche+position →
  angle-offer flow.
- **≥2 high-volume trends/day, source-post grounded** (2026-07-12 rework):
  the pipeline was reworked from "at most ONE send a day + 4-per-30-days" to a
  two-knob band: **`MIN_DAILY_TREND_SENDS`=2 is the per-RUN cap** (one run
  serves a helping, not the whole day — leaving room for a fresher/bigger trend
  a later run finds) and **`MAX_DAILY_TREND_SENDS`=3 is the hard per-DAY
  ceiling** (checked before any provider spend). The per-candidate loop is
  bounded by `min(MAX − sentToday, MIN)`. WHICH trends and HOW MANY is fully
  code-decided: buzz-verified survivors are ranked by `buzzScore` and taken
  top-down. The macro-match position gate went from a *cross-trend selector*
  (picked one from a list — a latent doctrine leak) to a *per-trend gate*
  (yes/no on a single candidate), so the model never picks which trend to cover.
  `trendMatch` is scheduled 3×/day: point-4 answer — 2/day comes from a single
  good run sending up to MIN, topped up by later runs up to MAX. **The old
  `TREND_MONTHLY_CAP`=4 was removed, deliberately** — 2/day and 4/30-days are
  arithmetically incompatible (burns out in two days); rarity is now the daily
  band + the gates, not a monthly counter. Delivery names the **source post**:
  `trend-take.v2` requires the permalink + a one-line paraphrase (never a long
  quote — copyright) of the specific tweet driving the volume, plus the user's
  angle; `get_top_tweets` now includes each tweet's permalink so the agent can
  cite it. Stored on the surfacing payload (`source_url`, `source_note`). The
  delivery shows exactly ONE link (the X driving-post, or the trend's own X
  permalink as fallback) — no trailing seed URL.
- **Fresh, cluster-based, term-searchable trends** (2026-07-12 — the fix that
  made the feature actually fire): trends used to be stored as individual hot
  tweets with the *verbatim tweet text* as the topic. Volume verification then
  searched that exact sentence and found only the one original tweet — proven
  live at **buzz 0.15 (0 authors)**, so nothing ever cleared the 0.5 gate. Now
  `trends/discover-x.ts` pulls same-day tweets, LLM-clusters them into
  searchable TERMS (with a driving source tweet), and verifies each term —
  `"Claude Code"` scores **buzz 0.86 with ~58 authors**. Three concrete fixes:
  (1) discovery stores a term as `topic` + the driving tweet as `url` +
  `observed_at` = that tweet's time; (2) trend-match gates on
  `observed_at > now() - 36h` so a 5-day-stale tweet can't resurface (the
  "why did it show me a 5-day-old tweet" bug); (3) `verifyTrendVolume` uses
  queryType `"Latest"` for both passes (twitterapi's `"Top"` returns nothing on
  windowed queries — it silently zeroed the engagement pass and the source-tweet
  pool) and pools source tweets from the UNION of both passes.
- **X-only candidate pool** (2026-07-12): the Apify fetch seeds `trends` from
  BOTH X and LinkedIn, but the macro-moment niche query filters to
  `t.platform = 'x'`. The feature is X-native end to end — buzz is verified on
  X (twitterapi.io) and the cited source post comes from X — so a LinkedIn-
  seeded trend would arrive with an X driving-post but a LinkedIn seed link,
  which is incoherent. (The filter is a single `AND t.platform = 'x'` in
  `trendMatchForUser`; flip it to re-include LinkedIn seeds. LinkedIn trend rows
  are otherwise unused today.)
- **Trend non-deliveries are recorded** (2026-07-12): agent declined / cadence
  held / send dropped / no position collides → the moment gets
  `verdict='rejected'` + `verdict_reason`, so "why did nothing fire this week?"
  is answerable from SQL, and a rejected trend is dedup'd out of the next run's
  niche query (not re-verified). `NICHE_THRESHOLD` default is 0.6 (calibrated
  live: on-niche trends sit 0.40-0.55 from the nearest position, junk 0.61+; at
  the old 0.7 the junk passed and ate the volume-verification slots). `/health`
  reports trend readiness (`trends.provider`, `trends.buzz_gate`,
  `trends.last_fetch`).
- **Boot-time catch-up for the two trend jobs** (`jobs/workers.ts#nudgeStaleTrendJobs`,
  2026-07-12): on a host that spins the process down when idle (Render free
  tier — this app's deploy target), a missed cron minute is gone forever;
  `boss.schedule()` does not backfill it. Production hit this for real: a
  `trend.fetch` crash on 2026-07-08 (fixed the same day) meant the trends
  table sat completely empty for 4 days afterward, because the process kept
  redeploying/restarting more often than the 8h interval and never landed a
  cron tick while alive at the right minute. Fix: every process boot ALSO
  sends `trendFetch` (only if `trends.fetched_at` is null or >7h stale — avoids
  re-spending on Apify/embeddings across a burst of same-session redeploys)
  and `trendMatch` unconditionally (its handler enforces the daily band per
  user and bails before any spend once the ceiling is hit, so an extra
  boot-time attempt only tops up toward the band, never over-sends).
  Verified live: wiping `fetched_at` into the past and re-running
  `registerWorkers` produces fresh rows within the boot sequence, no cron
  wait needed.
- **Consistency verdicts** are `catch_it` / `intentional_evolution` /
  `no_conflict`; catches under `CONSISTENCY_CONFIDENCE_THRESHOLD` are reported
  clear, and an intentional evolution comes back as a non-warning `note` on the
  result (surfaced by `runCheck` as "clear to post, one read worth knowing").
  `CONSISTENCY_CONFIDENCE_THRESHOLD` does double duty: it's both the single-shot
  v1 escalation trigger (low first-pass confidence → run the agent) and the
  agent's own catch-suppression filter (a low-confidence `catch_it` is reported
  clear). Both agent entries fall back to the single-shot result on error — the
  agent is an upgrade, never a hard dependency.
- **`get_engagement_heuristics`** returns computed facts, not model opinions
  (`engagement/heuristics.ts`, pure + unit-tested): thread reply count,
  minutes since post, reply-share-of-engagement, early-window flag — live
  counts via `pullTweetsByIds`, fetched at most once per loop, degrading to 0s.
- **twitterapi.io client additions** (`capture/imports/twitterapi-io.ts`):
  `searchTweets` (advanced_search; cursor pagination capped by
  `TWITTERAPI_SEARCH_PAGE_CAP`; operators are `min_faves:`/`min_retweets:`/
  `min_replies:` and `since_time:`/`until_time:` unix seconds — NOT the
  `since:YYYY-MM-DD` form) and `pullTweetsByIds` (`/twitter/tweets`). The
  by-ids endpoint's response nesting has NOT been verified live yet (both
  observed shapes are handled) — verify before leaning on it in prod.
- **Voice split holds inside loops:** the trend-take `reply` is Yoinky talking
  (casualized); its `embedded_draft` and the reply agent's `draft` are feed
  content — `enforceStyle` only, never `casualize()`.

---

## 3d. Post classification: rhetorical mode, sincerity, motive, campaigns (2026-07-11)

Content extraction tells you what a post is about; this tells you what kind
of post it is and why it exists — a distinct pass, folded into the same
`extract-memories` LLM call (v2) rather than a second round-trip, since
`llm/gateway.ts` has no real tier routing to trade off. Classified at
**capture** granularity (not per-memory): positions, `PerfPost`, and
campaigns are all naturally capture-level concepts, and a correction only
ever needs to touch one row.

- **Three dimensions on `captures`** (migration `0017`, all NULL-tolerant —
  old captures behave exactly as before): `rhetorical_mode` (reuses the
  onboarding tone taxonomy, `ALL_TONE_KEYS`) + `format_flags`;
  `sincerity_register` (`sincere | ironic | self_deprecating | absurdist |
  ambiguous`) + `sincerity_confidence`; `motive` (`authority_building |
  relationship_building | audience_growth | lead_generation |
  personal_processing | community_participation | campaign_installment`) +
  `motive_confidence`. `memory/classification.ts` owns the taxonomy consts
  and `isSincereEnough(register, confidence)` — the single gate every
  downstream consumer calls, conservative by default
  (`SINCERITY_CONFIDENCE_THRESHOLD = 0.5`).
- **The core fix — position gating.** `jobs/extract.ts` skips the entire
  positions-extraction loop for a capture when `!isSincereEnough(...)`, so a
  shitpost can never enter the belief store and later trigger a false
  consistency-check contradiction. Verified live: an absurdist post
  containing an explicit first-person "belief" claim correctly produced zero
  new positions.
- **Campaign detection** (build-in-public series) is its own job/queue,
  `jobs/campaign-detect.ts`, fired once per capture (not per-memory — an
  embed-link-style per-memory trigger could race and double-create a
  campaign for one post). Two paths: a structural marker
  (`detectStructuralMarker` — "day N", numbered updates, repeated tags,
  pure/deterministic) fast-attaches to a matching existing campaign; else a
  thematic check compares this capture's embedding against existing
  campaigns and, failing that, the user's own last ~20 captures in a 21-day
  window for a 3+ mutually-close cluster, creating a new `campaigns` row and
  retroactively backfilling `campaign_id`/`campaign_installment_number` onto
  the earlier matches. Threshold `CAMPAIGN_DISTANCE = 0.55`, matching
  `embed-link.ts`'s own calibrated `NEIGHBOR_DISTANCE` (this deploy's
  Qwen/DashScope embeddings run "cool" — on-topic paraphrases sit ~0.5-0.6
  cosine, not ~0.2-0.3). This queue's worker concurrency is pinned to **1**
  (`jobs/workers.ts`) specifically to close the create-race without an
  advisory lock — acceptable since this is a single-instance deploy and
  nothing user-facing waits on it.
- **Downstream filters**, all additive/NULL-tolerant: `strategist/evidence.ts`
  excludes non-sincere/low-confidence captures from idea/claims and the
  inside-out ratio; `voice/profile.ts` filters only the *published*-sample
  query (private chat captures still train voice regardless of register);
  `strategist/performance.ts` adds a sincere-vs-other tone split
  (`sincerityMix`) next to the existing aligned/off-throughline split, with
  non-sincere outliers annotated inline; `diagnosis.v1.ts` tags non-sincere
  posts inline (`[date · source · JOKE/register]`) and forbids citing them as
  genuine positions while still allowing them as voice/personality color.
- **Correction mechanism**, single choke point
  `memory/corrections.ts#recordCorrection`: updates the capture, logs to
  `classification_corrections`, and checks for a repeated-correction pattern
  (`correction_acknowledgments` guards a one-time "noticed I've been reading
  your joke posts too straight" DM). Two surfaces call it: the
  `correct_classification` chat tool (hybridSearch-then-button-picker,
  mirrors the existing `forget` tool) and a `🃏 that was a joke` button
  added unconditionally to every resurfacing card. Verified live: a second
  same-field correction within 30 days correctly fires the one-time
  acknowledgment.
- **Monthly recalibration is correction-only** (deliberately scoped — no live
  research integration): `jobs/workers.ts` schedules
  `classification-recalibrate` on the 1st of the month; for each user with
  recent corrections, `corrections.ts#buildCalibrationNote` derives a short
  per-user note from their correction history, stored in
  `classification_calibration` and threaded into the next `extract-memories`
  call as a fact.
- **Peer ingestion** (`benchmark/peers.ts` + `classify-peer-themes.v1`, v2)
  emits `rhetorical_mode`/`sincerity_register` onto `peer_captures` in the
  same batched call as theme classification — no motive, no confidence, no
  campaigns (peers get no belief graph or voice profile, by existing
  doctrine).

---

## 3e. Native scheduled posting (2026-07-12)

Queue a post now, publish it to X/LinkedIn at a chosen time — built entirely in
this stack (no third-party scheduler; Postiz was AGPL-3.0 and its NestJS/Prisma/
Temporal code wouldn't port anyway, so this is clean-room against the official
platform API docs).

- **The scheduler is the job queue.** `scheduling/service.ts#schedulePost`
  inserts a `scheduled_posts` row and sends a `QUEUES.scheduledPost` job with
  `startAfter = the target Date` (pg-boss takes an absolute Date, so there's no
  polling). `listScheduled` / `cancelScheduled` are the read/cancel API.
  **Cancel is a pure status flip** (`pending → canceled`): the due job
  re-reads status at fire time, so a canceled post is a no-op and we never
  reach into pg-boss to kill the delayed job.
- **`jobs/scheduled-post.ts` claims atomically.** The handler's first write is
  `UPDATE … SET status='publishing' WHERE id=$1 AND status='pending'
  RETURNING …`; only the transition out of `pending` wins, so a cancel that
  raced in — or a duplicate pg-boss delivery — can't double-post. Then it
  publishes and DMs the outcome via `dmChannel(userId)` (permalink on success,
  the real reason on failure).
- **Publishing (`social/publish.ts`) is the one WRITE path.** Everything else
  reads public history by handle (Apify/twitterapi.io, no auth). This posts as
  the user via a stored user-context OAuth token (`connected_accounts.post_*`
  columns, migration 0018), calling `POST /2/tweets` (X) and `POST /v2/ugcPosts`
  (LinkedIn, needs the member URN as author). It **fails closed**: no app creds
  (`publishConfigured`) or no stored token (`resolveWriteAuth`) → the post is
  marked `failed` with a plain-language reason, never a silent drop. Verified
  live end-to-end (schedule → enqueue → atomic-claim → fail-closed → cancel);
  only the actual provider API calls are unverified, pending real credentials.
- **Write-scope OAuth (`routes/oauth.ts`) is credential-gated and NOT yet
  live-tested.** `/oauth/:platform/start` (PKCE for X) → provider consent →
  `/oauth/:platform/callback` exchanges the code and stores the token. PKCE
  verifier + which-user live in an in-memory map keyed by `state` (fine on this
  single-instance deploy; move to Postgres if it ever scales out). `X_CLIENT_ID/
  SECRET` (paid X tier for `tweet.write`) and `LINKEDIN_CLIENT_ID/SECRET`
  (approved `w_member_social` app) are required; without them the routes 503 and
  `/connectposting` tells the user posting isn't set up.
- **Held back from users, deliberately (2026-07-13).** The engine above is
  built, unit-tested, and live-probe-verified end-to-end (schedule → enqueue →
  atomic-claim → fail-closed → cancel) — but the user-facing surface is NOT
  wired in yet: the `/scheduled` command and the `schedule_post` chat tool were
  pulled from `bot.ts` / `chat-tools.ts` / `actions.ts` / `converse.v3.ts` right
  after being built, so nobody can create a scheduled post through the product
  today. This was a deliberate pause (cost: X publishing runs ~$0.015/post on
  X's pay-per-use API, no free tier), not a bug — the code (`runSchedulePost`,
  `runShowScheduled` in `telegram/actions.ts`, the `schedq:cancel:<id>` callback
  in `bot.ts`) is intact and ready to re-wire in a few lines whenever the
  product decision is made. `connectposting` stays live independent of this —
  granting write access is harmless and now doubles as what the OAuth-first
  onboarding connect (§3f) grants for free during account connect.

---

## 3f. OAuth-first onboarding connect (2026-07-12)

When the platform app credentials exist, the Stage-7 connect hand-off leads
with **real account authorization** instead of asking for a handle to scrape.
One consent now serves both halves: it verifies the account is really the
user's (identity for the read) *and* stores the write token (posting), so
`/connectposting` is never needed by a user who onboarded this way. All of it
lives in `telegram/connect-auth.ts`; `routes/oauth.ts` hands off to
`afterOAuthConnected` after storing a token.

- **The sequence (product rule).** X is offered first (inline URL button →
  `/oauth/x/start?u=<id>` + a `cauth:skip:<platform>` skip button). Once X
  resolves — connected or skipped — LinkedIn gets its offer. Either may be
  skipped, but skipping **both** with nothing connected is refused: the skip
  ledger resets and the buttons come back, because everything downstream runs
  on the read and there is no read without history. A typed @handle / profile
  URL satisfies the gate too (it produces an account to read) and remains the
  path everywhere, including when no platform app is configured — then the
  flow is exactly the old handle ask. Cursor: `strategist_state.connectFlow =
  { offered[], skipped[] }`.
- **Per-platform credentials are independent — a partial setup degrades
  cleanly, it doesn't half-break.** `authConnectAvailable(platform)` just
  checks that platform's own `_CLIENT_ID`/`_CLIENT_SECRET`. Run X-only (the
  common bring-up order, since LinkedIn needs an approved Company Page +
  product first): X gets the real button; LinkedIn is never offered a button
  that would 503. Instead `nudgeOtherPlatformTyped` (called from both
  `afterOAuthConnected`'s tail and `bot.ts#beginConnect`, so it fires whether
  the first platform connected via OAuth *or* a typed handle) sends one
  plain-text "drop your LinkedIn profile URL" ask, once, honoring an explicit
  skip and never repeating (same `connectFlow.offered`/`skipped` ledger). The
  "X first, LinkedIn gets its turn" hand-off promise from the LLM prompt stays
  true either way — the code decides whether "its turn" is a button or a
  typed ask, the model doesn't need to know which.
- **What auth actually buys per platform (the compliance reality — don't
  "fix" this).**
  - **X:** scopes stay least-privilege (`tweet.read tweet.write users.read
    offline.access`). After the callback we make exactly one user-token read,
    `GET /2/users/me` (works on every tier), to get the **verified** handle +
    profile metadata (bio, followers — stamped into `connected_accounts.meta`
    with `verified_via_oauth: true`), then kick the normal history ingest
    against that verified handle. Full timeline reads via the official API
    need a paid tier and are a follow-up; the ingest pull itself still runs
    through twitterapi.io/Apify — but now only ever against an account the
    user has demonstrably proven they own.
  - **LinkedIn:** there is **no open scope that reads a member's posts**
    (`r_member_social` / Community Management API is partner-approval-gated —
    never request it without that approval). So LinkedIn auth = verified
    identity + posting rights (`w_member_social openid profile`), and the
    read still needs the profile URL, which the bot asks for right after the
    callback (`awaitingConnect` is set, the pasted URL flows through the
    existing `parseConnectTarget` → scrape path).
- **Failure honesty.** X identity fetch fails (rate limit / tier hiccup) →
  token is kept (posting works) and the bot falls back to asking for the
  handle. Telegram rejects non-HTTPS/localhost URL buttons → the offer
  re-sends as plain-text links (`sendOffer` fallback), so a dev instance
  doesn't go silent at the hand-off. OAuth follow-through runs detached from
  the callback HTTP response — a Telegram hiccup can never turn a stored
  token into an error page.
- **Entry points.** `maybeSendConnectAuthOffer` fires one-shot after the
  profiling turn that lands in `connect_transition` (mirrors
  `maybeSendToneMenu`), and force-fires (ignoring prior offers/skips) on
  `/start` resume at the hand-off and no-arg `/connect`. The
  `strategist-session.v2` prompt gets an `authConnect` flag so the hand-off
  copy points at the button ("tap it, approve") instead of dictating a bare
  handle; the deterministic fallback line in `runProfilingTurn` matches.
- **Like the rest of the OAuth surface, this is credential-gated and NOT
  live-tested** against the real providers (needs `X_CLIENT_ID/SECRET`,
  `LINKEDIN_CLIENT_ID/SECRET`). The scrape ingest path is unchanged and
  remains fully exercised.

---

## 3g. Product analytics (PostHog, server-side) (2026-07-12)

`src/analytics/posthog.ts` — `posthog-node`, not the browser SDK: Yoinky is
Telegram-native with no web frontend, so there is no client snippet and no
autocapture. Every event is captured explicitly in backend code.

- **`track(distinctId, event, props)` / `identify(distinctId, props)` /
  `shutdownAnalytics()`.** `distinctId` is always the internal `users.id`
  (stable for a user's whole life, unlike the Telegram id). Lazy singleton
  gated on `POSTHOG_API_KEY`: no key → client never constructed, every call a
  silent no-op (same graceful-degradation contract as every other optional
  integration). Every call is wrapped and swallows its own errors — a metrics
  outage must never break a product action.
- **Events, at their choke points** (metadata only — NEVER raw post text or
  captured thoughts; those don't belong in an analytics store): `user_signed_up`
  + `identify` (`lib/auth.ts`, the new-user INSERT branch); `message_received`
  (`telegram/bot.ts` inbound middleware — kind text/voice/command only);
  `capture_created` (`capture/service.ts`, telegram-authored sources only, so
  bulk connect imports don't drown the activation signal); `account_connected`
  (`strategist/connect.ts`); `draft_generated` (`telegram/actions.ts`);
  `onboarding_completed` + `identify` (`strategist/plan.ts#confirmPlan`, the
  activation moment); `subscription_activated` (`billing/dodo.ts`, only the
  transition INTO active). That's the full funnel: signup → engage → capture →
  connect → activate → monetize.
- **Flush:** `posthog-node` batches (flushAt 20 / flushInterval 10s) and
  `index.ts` calls `shutdownAnalytics()` on SIGTERM/SIGINT so events buffered
  right before a redeploy aren't lost. `/health` reports
  `analytics: true|false`.
- **Erasure on wipe (2026-07-13):** `deletePerson(userId)` calls PostHog's async
  `persons/bulk_delete/` (person + all their events), so `clear_everything` /
  `resetUserData` also clears analytics, not just our own tables. Best-effort and
  config-gated on `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_PROJECT_ID` (a project
  write key can't delete) — a no-op without them, and it can never fail the wipe
  (own errors swallowed, called after the DB transaction).
- **Verified** end-to-end against a local capture server: events reach the wire
  gzip-batched to `/batch/` with the right names, `distinct_id`, and
  metadata-only props; no-key path sends zero requests and never throws.

---

## 3h. Daily viral tweet case study (2026-07-13)

A **single-tweet spotlight**: once a day, one tweet in the user's niche that hit
a high-impression band (100k–9.99M views), with a computed "why it worked"
breakdown and an angle they could take. Distinct from the macro-moment agent
(§3c, aggregate discourse volume) and from `src/benchmark/` (peer-relative). Same
doctrine: **code selects the tweet, the model only explains and suggests.**

- **View-count field — VERIFIED, but no search operator.** twitterapi.io's
  `advanced_search` returns `viewCount` populated (confirmed live 2026-07-13:
  12k–82k on real results, alongside `bookmarkCount`, `quoteCount`,
  `author.followers`, `isBlueVerified`, `extendedEntities` for media). But there
  is **no `min_views` query operator** (only `min_faves`/`min_retweets`/
  `min_replies`). So the band is enforced as a documented fallback: search with a
  `min_faves` proxy floor (`VIRAL_MIN_FAVES_PROXY`, default 600), then post-filter
  the returned set by the real `viewCount` against `[VIRAL_VIEW_MIN,
  VIRAL_VIEW_MAX]`. `toXTweet` now carries the view/format fields (it used to drop
  them).
- **Deterministic gate** (`trends/viral-scoring.ts#selectViralCandidate`):
  niche-seeded search (reuses `trend-fetch.ts#interestThemes` — no second seed
  pipeline) → view-count BAND filter → dedup (tweet already sent, or author within
  `VIRAL_AUTHOR_COOLDOWN_DAYS`) → niche relevance gate (batch-embed survivors,
  per-candidate `embedding <=> positions` vs `NICHE_THRESHOLD` — same pgvector
  pattern as §3c) → deterministic rank → exactly one. Rank = relevance 0.5 +
  breakout 0.3 + reach 0.2, all normalized; the model never picks.
- **Computed facts** (`trends/viral-heuristics.ts`, pure + unit-tested, same
  doctrine as `engagement/heuristics.ts`): breakout ratio (views ÷ followers —
  the single best "escaped its reach" signal), engagement rates per 1k views
  (incl. bookmarks = "saved to act on later"), amplification share, velocity
  (views/hour), format signals (media, length bucket, opener classification:
  question / number / bold_claim / plain). The agent NARRATES these; it never
  invents "hooks and algorithm" folklore.
- **Bounded agent** (`prompts/viral-case-study.v1` + `trends/viral-tools.ts`):
  tools `get_voice_profile` / `get_content_pillars` / `search_memory` (same three
  as reply-drafting), cap `VIRAL_MAX_TOOL_CALLS` (3). Output: a breakdown citing
  the numbers + one angle grounded in the user's own voice/pillars/memory.
- **Delivery + budget** (`jobs/viral-benchmark.ts`): surfacing type
  `viral_benchmark` (migration 0019), distinct **📈** framing (not the ⚡ trend
  take, not the 🔥/💤/🗑 resurfacing card). **Its own once-a-day budget** — NOT in
  `PROACTIVE_TYPES`, so it doesn't compete with resurfacing/trend_take for the
  shared cadence slot (this is a different kind of value: an external reference,
  not personal memory or discourse-riding); only quiet hours still apply. **The
  reaction decision: YES** — 👍/👎 buttons (`vbfb:` callback) recorded on the
  `viral_benchmarks` ledger, the tuning surface for relevance over time.
- **Dedup ledger** `viral_benchmarks` (migration 0019): one row per sent tweet
  (UNIQUE on `user_id,tweet_id`), written only on a real send, so a failed
  delivery never blocks tomorrow's retry; it's both the dedup source and the
  daily gate. Scheduled `0 6 * * *` (11:30 IST).

---

## 3i. The web app (`packages/web`) (2026-07-17)

Yoinky is now **web-first**; Telegram is the add-on that keeps every feature and
carries the proactive reach-outs. The web app is a Next.js 16 / React 19 app.

**Integration model — in-process, not a second API.** `packages/web` imports
domain functions from **`@yoink/backend/web`** (the barrel at
`packages/backend/src/web.ts`) and calls them directly inside Next route
handlers and server components, sharing the same Postgres pool. There is no
separate HTTP API tier to keep in sync. The `@yoink/backend` `exports` map points
that subpath at **compiled `dist/web.js`** for runtime (types resolve from
`src/web.ts`) — Turbopack won't rewrite the backend's `.js`→`.ts` import
specifiers, so the web depends on a built backend. `packages/web` runs
`pnpm --filter @yoink/backend build` on `predev`/`prebuild`; editing backend
code during web dev needs a rebuild.

**What the barrel exposes** (keep this the only web surface): auth + identity
(`findUserByClerkId`, `findOrCreateUserByClerkId`, `createTelegramLinkToken`,
plus the legacy `findOrCreateUserByEmail`/`findOrCreateUserByXId`), trial + billing
(`trialInfo`, `startTrial`, `setIntendedPlan`, `createCheckout`, `entitlementsFor`,
`isPaidOrExempt`), the
web-flavored chat brain (`runWebChatTurn` in `src/web/chat.ts`, which wraps the
same `converseWithUser`/`deliverTurnOutput` the bot uses but swaps in a
*collecting* `Channel` — `src/web/channel.ts` — so a turn's messages come back
as an array), the structured onboarding form (`submitProfileForm`,
`skipProfileFields`, `profileCompletionFields` in `src/web/onboarding-form.ts` —
see below), plus read models (`getStage`, `getState`, `getProfile`,
`PROFILE_FIELDS`, `GOAL_OPTIONS`, `TONE_TAXONOMY`, `currentDiagnosis`, `getPlan`,
`activePositions`, `loadChatHistory`, `listTrendInspiration`,
`listViralInspiration`).

**Auth — Clerk (since 2026-07-23).** Identity is now **Clerk** (`@clerk/nextjs`
v7 / Core 3). The old custom Google/X/magic-link sign-in routes and the
`yoink_session` cookie are **removed**; social logins (Google, X) are configured
as connections in the Clerk dashboard for app `app_3GuEglSCyTcG11r4RQTo89Ve9O3`.
Wiring:
- `src/proxy.ts` exports `clerkMiddleware`; `createRouteMatcher(["/app(.*)"])` +
  `await auth.protect()` gate the app (the matcher also runs on `/(api|trpc)` and
  `/__clerk`). Unauthed hits redirect to `NEXT_PUBLIC_CLERK_SIGN_IN_URL`.
- `<ClerkProvider signInUrl signUpUrl afterSignOutUrl>` wraps the tree **inside
  `<body>`** (Core 3 / cache-components rule) in `src/app/layout.tsx`.
- Catch-all `src/app/sign-in/[[...sign-in]]` and `sign-up/[[...sign-up]]` render
  Clerk's `<SignIn>` / `<SignUp>`. Sign-up reads `?plan=` and forwards it to
  `/app?plan=…`. `<UserButton>` sits in the topbar (shows email + sign out on
  click) and `<SignOutButton redirectUrl="/sign-in">` is on the Settings page, so
  the old sidebar profile row (avatar/email/logout) was removed as redundant.
  `/` redirects to `/app` or `/sign-in`.
- **The bridge that kept the blast radius tiny:** `getSessionUser()`
  (`src/lib/session.ts`) still returns `User | null`, so every server component /
  route that used it is unchanged. Internally it now does `await auth()` →
  `findUserByClerkId(userId)` (fast path), and on first sight fetches
  `currentUser()` for the email and calls `findOrCreateUserByClerkId`, which maps
  Clerk → our `users` row by **`clerk_user_id`** (migration `0025`; carries over a
  pre-Clerk row with the same email) and **starts the 7-day trial** on a genuine
  new signup.
- **The X posting-connect is separate and unchanged** — `/api/auth/x/*` (PKCE,
  `tweet.write`) is now **connect-only**: it requires a Clerk session and attaches
  the posting token via `finalizeXConnect` (identity is Clerk's job).

**Trial = Dodo subscription-with-trial (auto-charge at day 7), card collected
INSIDE the app.** Sign-up takes no card: `forceRedirectUrl` = `/app?plan=…`, and
`getSessionUser` → `startTrial` mints a local `status='trialing'` + `trial_ends_at`
row on first sign-in, so the user has instant full access. Card capture is a
separate, later step, done from:
- the **`<TrialPill>`** ("Add card") — a subtle pill in the top **nav bar**
  (`components/topbar.tsx`; replaced the old full-width `<TrialBanner>` strip) — or
  **Settings → Plan & billing** →
  `GET /api/billing/start-trial` → `createCheckout(..., { trialDays })` posts to
  Dodo `/checkouts` with `subscription_data.trial_period_days`. Critically,
  `trialDays` = the user's **remaining** local trial days (`trialInfo().daysLeft`),
  so adding a card on day 5 still charges on day 7 — no free-period extension. The
  customer isn't charged during the trial; Dodo **auto-charges** when it ends,
  converting to a normal paid subscription. Dodo webhooks (`POST /webhooks/dodo` →
  `handleDodoEvent`, keyed by `metadata.user_id`) drive the row from there
  (`subscription.active` on trial start → `renewed` on the day-7 charge → `on_hold`/
  `failed`/`cancelled` otherwise); the `ON CONFLICT (user_id)` upsert transitions the
  same local row to the Dodo-backed subscription.
- **Abandonment fallback.** No card / Dodo unconfigured → the 7 days still run on the
  local row, then the wall when it lapses (day count cleared to 0, no auto-charge).
- **No second free trial.** The post-trial upgrade paths — `<TrialPill>` (expired)
  + Settings plan cards → `GET /api/billing/checkout`, and the Telegram `bill:*`
  buttons — call `createCheckout` **without** `trialDays`, so a lapsed user is charged
  immediately.

**Self-serve management (Settings, `/app/settings`).** Two surfaces, both reachable
without leaving the app: **Account** — `<ManageAccountButton>` opens Clerk's
`openUserProfile()` modal (email, password, connected social logins, active sessions,
delete account). **Plan & billing** — status line from `billingOverview(userId)` (the
trial/plan state + whether a Dodo subscription exists), then a **`<PlanPicker>`**
(Growth vs Scale cards, current one badged): before a card is on file each card
starts the right checkout with `?plan=growth|scale`; once a Dodo subscription
exists, plan changes route through the Dodo **customer portal**
(`GET /api/billing/portal` → `createCustomerPortal`, self-serve change/cancel +
update card) so we never mint a duplicate subscription. `<TrialPill>` reads from
`trialInfo`; a card-on-file (active) subscription shows no pill. Gating bites only when
`PAYWALL_ENABLED=true`; landing `?plan=` is recorded on `subscriptions.intended_plan`
(`setIntendedPlan`). See §3b's paywall + `entitlementsFor`.

**Plan tiers are real (Growth vs Scale), enforced on both surfaces.** `Entitlements`
carries numeric caps (`null` = unlimited) + `autoAgent`; `entitlementsForPlan()` (pure,
unit-tested) maps `paid→GROWTH` (30 scheduled/mo · 25 buyer intents/mo · 1 viral/day ·
3 resurfaces/wk · no auto-agent), `scale`/`founding`/`trialing`→`SCALE` (all unlimited +
auto-agent + 5 resurfaces/wk). Caps live in the **shared domain layer** so web +
Telegram inherit one gate: `schedulePost` (`monthlyScheduledCount`, returns
`capReached`), `buyer/scan.ts`, `automations/run.ts` + `saveAutomationFromWeb` (AUTO is
Scale-only), `jobs/viral-benchmark.ts`; `withinCap`/`remainingFor` handle the `null`
case everywhere. The **web paywall gap is closed**: `lib/entitlements.requirePaid`
(mirrors Telegram `isPaidOrExempt`) guards the chat / buyer-scan / automations /
schedule routes → **402** `upgrade_required` (free/expired) or **429** `cap_reached`
(plan limit); `<UpgradeCTA>` links to `/api/billing/checkout?plan=scale`. Not built:
"consistency on every post" (auto) — a separate Scale feature; manual `/check` stays on
both paid tiers.

**Env.** The web runs backend code in-process, so it needs the backend's env
(`DATABASE_URL`, `OPENROUTER_API_KEY`, embeddings keys, …). `packages/web/.env.local`
is a **symlink to `packages/backend/.env`** — one source of truth. Clerk keys
(`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
`NEXT_PUBLIC_CLERK_SIGN_IN_URL`/`SIGN_UP_URL`) live there too and are **required**
for the web app to boot. Dev port is **3002** (backend stays 3001).

**Screens** (`src/app/app/*`, real `/app` segment — not a route group). `/app`
is a redirect to `/app/agent` (chat lives there now, see below — there is no
more standalone chat page). Sidebar groups: **Agent** — `/app/compose` (X-only
draft composer → `/api/draft` → `runWebDraft`→`runDraft`, respects the
paywall/allowance and the voice-profile gate; lists persisted drafts), `/app/automations`
("Auto Agent"). **Grow** — `/app/growth` (see §3m), `/app/inspiration`,
`/app/buyers-radar` (UI-only preview, see below), `/app/analytics`. **Account** —
`/app/scheduled`, `/app/settings` (account info, editable stated profile, connect X,
Telegram connect button, appearance toggle — see below). `/app/onboarding` is the
gamified popup wizard (see below); `/app/diagnosis`, `/app/plan`, `/app/beliefs`
still exist as standalone routes (now largely fused into `/app/growth`) but aren't
linked in the sidebar. `/sign-in` + `/sign-up` are public (Clerk); `/` redirects.

**Design.** Ported from the WeaveOS reference (Geist, warm off-white canvas,
hairline `0.5px` strokes, `20px` radii, sidebar + workspace). The reference's
only accent was glossy black; per the brief it's recolored to a single **pink**
token — `--accent` / `--accent-2` in `globals.css` (swap those two to rebrand).
A dark theme was added (the original was light-only); the toggle lives in
**Settings** now (`components/theme-toggle.tsx`, extracted from the sidebar),
stamps `data-theme` on `<html>`, persists to `localStorage`.

**LinkedIn is web-only removed (2026-07-20).** Compose is X-only in the web app
— `/api/draft` hardcodes `platform: "x"`. This does **not** touch the Telegram
bot or backend LinkedIn support (`connect.ts`, `apify-profile.ts`,
`drafting/repurpose.ts`, `social/publish.ts` all still fully support it) — a
user who connected LinkedIn via Telegram still has that `connected_accounts`
row; the web's account list just filters to `platform === 'x'`.

**Connect X is OAuth, not a typed handle (2026-07-20, `web/oauth-connect.ts`).**
Settings' "Connect X" is a plain `<a href>` to the **backend's own**
`/oauth/x/start?u=<userId>&redirect=<returnPath>` — the exact same PKCE flow
the Telegram bot's connect button uses (`buildAuthUrl` in `routes/oauth.ts`),
just reached via a web link instead of a Telegram inline button.
`buildWebConnectUrl(userId, "x", "/app/settings")` builds that URL (null if
`X_CLIENT_ID`/`SECRET` aren't configured — checked via the existing
`publishConfigured`). For X, OAuth is strictly better than the old typed-handle
path: after the callback verifies identity (`GET /2/users/me`),
`afterOAuthConnected` (`telegram/connect-auth.ts`) automatically calls the same
`startConnect` history-read kickoff the typed-handle path used — one authorize
click does what used to take a click + typing a handle.

New env: **`WEB_APP_URL`** (backend config, defaults `http://localhost:3002`) —
an allowlisted return origin for the OAuth callback. `/oauth/:platform/start`
now accepts an optional `redirect` query param; `safeReturnTo()` only ever
honors it when it starts with `config.WEB_APP_URL` exactly (open-redirect
guard, since this is a browser redirect target). When present, `/callback`
redirects the browser to `${redirect}?connected=<platform>` (or
`?connect_error=1` on a token-exchange failure) instead of the bot-flavored
static `DONE_HTML` page — the Telegram flow (which never passes `redirect`)
is completely unaffected. **Must be set to `https://app.meetyoinky.com` on the
Railway backend's env** (not Vercel — this is backend config) for the
production return-redirect to work; unset it and the callback just falls back
to the static page harmlessly.

**A cross-process bug caught before shipping.** The first implementation had
the web app call `buildAuthUrl` **in-process** (skipping the `/start` hop
entirely, reasoning "it's already in the same Node process as everything
else"). That's wrong here specifically: the PKCE `pending` state in
`routes/oauth.ts` is a plain in-memory `Map` (documented single-instance by
design), and `/start` (which writes an entry) and `/callback` (which reads it)
must run in the **same OS process** for that entry to exist. The web app
(Vercel) and the backend (Railway) are separate deployments — calling
`buildAuthUrl` from the web would populate a `pending` Map only the web
process's memory holds; the backend's `/callback`, running in its own
process, would `pending.get(state)` → `undefined` on every single attempt,
silently failing as "that link expired." The fix is `buildWebConnectUrl`
returning a URL **string** pointing at the backend's own route (mirroring
`connect-auth.ts`'s `authUrl` helper) rather than ever importing/calling
`buildAuthUrl` from web code — both legs of the PKCE handshake now always run
on the backend, wherever that happens to be deployed. Worth remembering for
any future feature that touches this in-memory `pending` map (or any other
module-level mutable state in `routes/`): **in-process import ≠ same process**
when the web and backend are different deployments — only reach across that
boundary through actual HTTP, never a shared in-memory data structure.
`/api/connect` and `runWebConnect` (the old typed-handle path) were
dead-code-removed once this replaced them.

**Telegram connect button (Settings) + sidebar launcher.** Reuses the existing
deep-link primitive: `POST /api/telegram/link` calls
`createTelegramLinkToken(userId)` and returns `${TELEGRAM_BOT_URL}?start=${token}`;
the caller opens it in a new tab so the bot's `/start` consumes the token and
attaches `telegram_id` to this user row. Two entry points share this flow — the
Settings "Go to Telegram" button (`components/telegram-connect.tsx`) and a
bottom-anchored **Telegram Bot** item in the sidebar (`components/sidebar.tsx`).
Both go through the tokenized link (never a plain `t.me` link), so opening from
either place links the Clerk account before the auth-gated bot can turn an
unlinked visitor away.

**Structured onboarding — a gamified popup, not a chat (2026-07-20,
`web/onboarding-form.ts`).** The web's onboarding intake is a **separate,
form-based write path** from the Telegram bot's LLM-driven conversational
intake (`session-machine.ts`) — no LLM round trip, no ambiguity. A wizard
(`components/onboarding-wizard.tsx`, rendered in a non-dismissible `Modal`)
walks 3 screens clubbing the 7 `PROFILE_FIELDS`: (1) niche + audience, (2) goal
(dropdown, `GOAL_OPTIONS`) + tone (chip multi-select, `TONE_TAXONOMY`) +
inspirations, (3) content pillars + camera comfort (dropdown). A segmented
progress bar (one segment per field) plus step dots gamifies completion.
- `submitProfileForm(userId, fields)` writes each field via `upsertProfileField`
  (or `confirmPillars` for `content_pillars`, matching the session-machine's own
  special case), then finalizes + transitions to `connect_transition` once
  every field is captured — mirrors the tail of `applyProfileActions`, minus
  the LLM.
- `skipProfileFields(userId, fields)` is "skip this section" (pass the current
  screen's fields) or "skip onboarding entirely" (pass all `PROFILE_FIELDS`).
  **It reads actual `brand_profiles` values via `profileCompletionFields`
  first and only touches fields still empty** — unlike the Telegram-side
  `skipAllIntake` (session-machine.ts), which keys off the conversational
  session cursor (`strategist_state.profile.captured`), not the DB row. Since
  the web writes fields directly (bypassing that cursor entirely), reusing
  `skipAllIntake` here would have blindly overwritten already-answered fields
  with blanks — this is why the web has its own skip function.
- Both are exposed at `/api/profile` (`POST`): `{ skipFields: [...] }` for a
  skip, any other flat `{ field: value }` body for a save — the same route
  also serves the Settings profile editor (`components/profile-editor.tsx`),
  so onboarding and later edits share one write path.
- **Two real bugs found and fixed while building this** (both live in
  `strategist/profile.ts`, so they also improve the Telegram path):
  1. `normalize()` returned the literal `""` for a skipped scalar field instead
     of SQL `NULL`. Several `brand_profiles` columns (`primary_goal`,
     `camera_comfort`, `formality_gradient`, …) have a CHECK constraint on a
     fixed enum that rejects `""` — Telegram's `skipAllIntake` silently
     swallows this (`.catch(() => {})`), so the field just quietly never got
     recorded; the web's version let it propagate as a 500. Fixed at the
     source: `return scalar || null` — every downstream read already treats
     `""` and `null` as equally falsy, so this is behavior-preserving.
  2. `profileCompletionFields` originally required a *truthy* value, so a
     legitimately **skipped** field (real value `NULL`, tracked in
     `unresolved[]`) could never count as "done" — completion would never
     reach 7/7. Fixed to count a field as done if it has a value **or** is in
     the `unresolved` ledger, matching the Telegram intake's own definition of
     "captured."
- The old conversational web onboarding (`initWebOnboarding`,
  `runWebOnboardingTurn`, `skipOnboardingStep`, `skipOnboardingAll` in
  `web/chat.ts`, and `/api/onboarding`) was dead-code-removed once this
  replaced it — Telegram's own onboarding is untouched.

**Inspiration (`/app/inspiration`, `web/inspiration.ts`).** Read-only Trends and
Virals tabs over what the proactive jobs already deliver to Telegram — no new
delivery mechanism. `listTrendInspiration` reads `surfacings` where
`type = 'trend_take'` (joined to `trends` for topic/summary); `listViralInspiration`
reads `type = 'viral_benchmark'` (joined to `viral_benchmarks` for the 👍/👎
reaction). Both are typically empty until a user has been connected + diagnosed
long enough for `jobs/trend-match.ts` / `jobs/viral-benchmark.ts` to have fired.

**Buyers Radar (`/app/buyers-radar`) — UI only, no backend.** A preview screen
for a planned "find people publicly asking for your service on X" feature: a
disabled search bar, disabled filter chips, and a blurred mock result list under
a "Not live yet" overlay card. Ship this by adding a real matching pipeline
behind it later — there is currently zero server-side capability here.

**Agent mode (`/app/agent`, `web/agent.ts`).** Opt-in auto loop stored as
`users.settings.agent_mode`. `runAgentCycle(user)`: `topPendingUnlock` (topic
from the user's own backlog) → `generateDraft` (their voice) → `schedulePost` at
now+20h (lands in the queue, cancellable before it fires — not an instant post).
`markUnlockDeveloped` prevents reuse; `agent_last_run` gates cadence. Daily
`agentTick` cron (`jobs/workers.ts`, `QUEUES.agentTick`) runs a cycle for each
opted-in user that's due; the web also exposes a "Run one cycle now" button
(`/api/agent`). "Best posts it learns from" reuses analytics top posts.

**Analytics (`/app/analytics`, `web/analytics.ts`).** Fast path
(`getAnalytics`) reads the per-post engagement already on `captures.metadata`
(no API call): impressions/likes/replies/RT/quotes/bookmarks, median engagement
rate, an engagement-weighted hour×day best-time heatmap (in the user's tz), top
posts, follower snapshot. `getReplyAnalytics` is on-demand (`/api/analytics/replies`)
— a live `pullXTimelineWithMetrics` pull (rate-limited) that keeps replies and
computes reply-level impressions + engagement rate. Honesty: profile clicks,
per-post follower attribution, and revenue/RPM are reported as unavailable (not
exposed by any scrape/public API), never faked.

**Beyond-native cuts (tie X metrics to our own data, all from stored data — no
model, no extra API):**
- **Yoinky's impact** (`impact`) — posts shipped through Yoinky's scheduler
  (`scheduled_posts.external_url`, matched back to `captures` by tweet id) vs the
  rest: assisted-vs-baseline median engagement-rate **lift** + impressions earned.
  This is the differentiated headline: *"posts you shipped through Yoinky run +X%."*
- **Format lab** (`formats`) — the same posts sliced by deterministic shape
  (question / link / short / long / thread-or-list), each with median eng-rate and
  **lift vs your own median**. X shows numbers per post, never per *shape*.
- **Momentum** (`weekly`) — posts/impressions per week over the last 8 weeks.
- **Auto Agent scorecard** (`agent`) — operational counts from `automation_runs`
  (drafts written, shipped/queued, awaiting you, avg edits/draft). Shown even
  without X metrics since it's our own data.

**Scrape cap.** Every pull of a user's own tweets is hard-clamped to
`MAX_OWN_TWEETS = 100` (`capture/imports/twitterapi-io.ts`), enforced in both
provider entry points and `pullXProfile`; connect ingest is `INGEST_MAX_POSTS = 100`.

**Deferred (reachable via chat today, no dedicated screen yet):** OAuth-button
connect (the web uses the typed-handle/URL path; X/LinkedIn write-OAuth buttons
still live only in the bot), repurpose, mentions inbox, peers. Proactive delivery
still goes out over Telegram, not in-app.

**Hosting — Vercel (`app.meetyoinky.com`).** The web app runs on Vercel (project
`yoinky-web`), separate from the Telegram backend on Railway (`bot.meetyoinky.com`).
Both share the **same Neon Postgres** (`DATABASE_URL`), so a user session/profile
is identical across web and bot. The web's env vars are mirrored onto the Vercel
project (production/preview/development) — set them there, not just in
`packages/backend/.env` (which only feeds local dev and the Railway bot).

The Vercel project's **Root Directory is set to `packages/web`** (Project
Settings, not a CLI flag), with build config pinned in `packages/web/vercel.json`:

```json
{ "framework": "nextjs", "buildCommand": "pnpm build", "installCommand": "pnpm install --frozen-lockfile" }
```

`pnpm build` (the package's own script) runs `pnpm --filter @yoink/backend
build && next build`, so the backend compiles to `dist/` before Next builds —
same as local dev. **Always deploy from the repo root** (`vercel deploy --prod`),
not from inside `packages/web` — the monorepo needs the whole workspace
uploaded (root `pnpm-lock.yaml` + `@yoink/backend`) for `pnpm install` to
resolve the `workspace:*` dependency; deploying from the sub-package only
uploads that folder and the install fails. There is no root `vercel.json` —
only the one in `packages/web`. Google OAuth derives its redirect from the
request origin, so the authorized redirect URI in Google Cloud must include
`https://app.meetyoinky.com/api/auth/google/callback`.

---

## 3j. Buyer Radar (2026-07-22)

Finds people on X expressing purchase intent that maps to what the user sells,
scores that intent **deterministically**, gates it **semantically** against the
user's domain, then hands over a reply drafted in the user's voice for approval.
It is the engagement/trend machinery specialised for buying intent. It **never
auto-sends** (approval-only, a doctrine + ToS/spam guard) and code — not the
model — decides who is a buyer.

**ICP, distinct from the brand profile.** `brand_profiles` is "who I am / who
reads me"; the buyer is "who is in-market for my thing". `icp_profiles`
(migration `0022`, one row/user, `buyer/icp.ts`) stores `product_oneliner`,
`buyer_description`, `pain_signals[]`, `competitor_terms[]`, `exclusions[]`, and
an `icp_embedding` (the niche-gate vector, recomputed on every save). Captured
just-in-time via a minimal web intake (3-4 fields, pre-filled from
`brand_profiles`), editable anytime.

**The pipeline (`buyer/scan.ts` → `scanForUser`).**
1. **Budget first.** `monthlySurfacedCount` vs `BUYER_MONTHLY_SIGNAL_CAP` is
   checked BEFORE any paid call — a user at their cap never triggers a search.
2. **Discovery (`buyer/discovery.ts`).** The ICP is distilled into intent
   queries by `buyer-queries.v1` (LLM) with a deterministic fallback composing
   `pain × product × competitor` across four buckets (explicit_ask,
   competitor_dissatisfaction, pain, trigger_event). Queries run through
   `searchTweets` (advanced_search, `since_time` recency, `-filter:replies`,
   page cap), deduped against `buyer_signals` (tweet id + author cooldown), the
   user's own tweets dropped. If a pass finds nothing at all, the strongest three
   queries retry once over `BUYER_LOOKBACK_HOURS × BUYER_WIDEN_FACTOR` — an empty
   radar is worse than an old candidate that still has to clear both gates.

   **THE query invariant: never AND a run of bare words.** X requires every
   unquoted word to appear in the same tweet, so
   `("looking for" OR "recommend") AI ghostwriter that turns founders` matches
   nobody, ever. The category must be an OR-group (`categoryGroup` → e.g.
   `("landing page" OR copywriting OR landing)`), and a pain phrasing stands
   alone as a quoted phrase rather than having the category AND-ed onto it.
   `tooNarrow` enforces this on LLM-distilled queries before they cost a paid
   search; `discovery.test.ts` guards the fallback. This was the bug that made
   the radar return zero prospects for every user (fixed 2026-07-23): measured
   live, the bare-phrase form returned 0 at every lookback window while the
   OR-group form returned a full page inside 72h. The funnel on one real ICP went
   from `0 → 0 → 0` to `91 candidates → 51 intent → 18 niche`.
3. **Deterministic intent gate (`buyer/scoring.ts#intentScore`).** Pure,
   unit-tested. Components: marker strength (a curated lexicon + the user's
   `pain_signals`), query provenance, question presence, competitor mention,
   steep recency decay, a follower **reachability band** (NOT monotonic — a
   mid-size account beats an egg and a megaphone), a **crowding penalty** (the
   inverse of buzz: many existing replies = a lost race), and an **exclusion
   hard-kill** (any `exclusions` hit → score 0). Compared to `INTENT_THRESHOLD`.
4. **Semantic niche gate (`buyer/niche-gate.ts`).** Candidate tweet embedded and
   cosine-compared to `icp_embedding`; rejects `dist >= BUYER_NICHE_THRESHOLD`.
   Only candidates clearing BOTH gates reach the agent. Fail-closed if the ICP
   has no vector (reported as `stages.hasIcpVector` so the UI can say so rather
   than showing a mystery-empty radar). The ICP vector is fetched ONCE and the
   distance computed in-process — pgvector's `<=>` per candidate was a DB
   round-trip per tweet for what is arithmetic. `0.55` is measured, not
   conservative-by-default: on live data it passed ~⅓ of intent-clearing
   candidates and was what killed the off-domain crypto/event noise.
5. **Composition agent (`buyer/radar-agent.ts` + `buyer-outreach.v1`).** Bounded
   `runToolLoop` (`MAX_BUYER_TOOL_CALLS`), tools in `buyer/tools.ts` (no imports):
   `get_icp`, `get_voice_profile`, `get_positions`, `get_content_pillars`,
   `search_memory` (the moat — lead with the user's own prior take, not a pitch),
   `get_thread_context` (degradable enrichment). Output: `fires`, `why` (Yoinky's
   casual chatter, `casualize`d), `draft_reply` (the public reply,
   `POST_WRITING_RULES` + `enforceStyle`, never casualized). `fires:false` is a
   suppression escape hatch (sarcasm/rhetorical/offering-not-seeking) — recorded
   as `rejected`, costs nothing, does NOT burn the budget. Single-shot fallback
   on loop error (same posture as `consistency/check.ts`).

**Persistence + verdicts.** `buyer_signals` doubles as the dedup ledger and the
tuning surface: `verdict` ∈ `surfaced|replied|skipped|not_a_fit|rejected`,
`components`/`agent_steps` stored inspectable. A fired signal consumes monthly
budget; a decline does not. The **author cooldown only counts authors actually
surfaced** — a `rejected` row is a model decline the user never saw, and blocking
that author for three weeks shrank the candidate pool with every scan. A
composition that *errors* (provider down/out of credit) is not persisted at all,
so the candidate stays eligible next scan; it also no longer aborts the run, which
used to throw away every candidate already paid for.

**`ScanResult.stages` — why an empty radar is now legible.** `candidates →
intentPassed → nichePassed → composed / composeFailed` plus `hasIcpVector`,
logged on every scan and turned into one plain sentence by `emptyReason`
(`web/buyers-radar.ts`). Without it, "0 signals" is indistinguishable from "the
pipeline is broken" — which is exactly how a dead query set stayed invisible. The
causes need different things from the user (widen the category / sharpen the
buyer / nothing, it was a quiet week), so the UI says which one it was.

**Delivery is the web app (v1, pull-only).** `web/buyers-radar.ts` (read model
`listBuyerSignals`, `buyerRadarStatus`, ICP get/save, `scanBuyerSignals`,
`setBuyerSignalVerdict`) → routes `/api/buyers-radar/{scan,icp,verdict}` →
`components/buyers-radar.tsx` (ICP intake, "Scan now", per-signal reply +
open/copy/skip/not-a-fit). A scan is genuinely slow (paced X searches →
embeddings → up to eight bounded composition loops, a minute or two), so
`ScanningRadar` replaces the empty state with a centred radar sweep whose
captions track the real pipeline stages at roughly their real timings — the wait
reads as work rather than a hang. CSS-only motion, `prefers-reduced-motion`
respected. The proactive recurring path (`jobs/buyer-radar.ts`,
queue `buyer.radar`, surfacing type `buyer_signal`) ships **DARK**
(`BUYER_RADAR_PROACTIVE=false`) — enable per rollout after observing search-budget
behavior in prod (twitterapi.io has hit `402 Credits` before, and buyer search is
per-user O(users), not a shared pool like trends/viral).

**Recalibration (`buyer/calibration.ts`, migration `0023`).** Verdicts feed a
per-user override of the two gates, re-derived deterministically (mirrors
memory/corrections.ts, no LLM): `not_a_fit` (the domain match was wrong) tightens
the niche gate, `skipped` raises the intent bar, `replied` relaxes both back
toward the config defaults so a user whose radar is landing gets more, not fewer,
candidates. `buildCalibration` is pure/bounded (±0.03/verdict, clamped).
`not_a_fit`/`skipped` recalibrate inline on the verdict write (responsive); a
monthly sweep (`buyer.recalibrate`) is the backstop. `scanForUser` reads
`effectiveThresholds(userId)` (falls back to config) for both gates.

**Cost guards:** monthly signal cap (pre-search), per-query page cap, bounded
query count, per-scan composition cap, author cooldown, fail-closed without
`TWITTERAPI_IO_KEY`. **Follow-up (not built):** Telegram delivery parity for the
proactive path.

---

## 3k. Content moderation + web polish (2026-07-22)

**Moderation gate (`moderation/filter.ts`).** Deterministic (doctrine: code
decides), no LLM: a word-boundary-matched lexicon of explicit sexual + abusive
slur terms over a lightly normalized copy of the text. `moderateText` returns
`{ok, category}`; `assertClean` throws `ModerationError`. Conservative by design
(unambiguous explicit/abusive only, not mild profanity, and boundaries dodge the
Scunthorpe problem). Enforced at every user-text choke point: `converseWithUser`
(Telegram + web chat + voice transcript, inline pushback), `runDraft` (draft
topic), `saveBuyerIcp` (ICP fields), `submitProfileForm` (profile fields), and
`createWebScheduledPost` (scheduled content). `ModerationError` → 400 at the web
boundary. One consistent casual-voice pushback message; offending input is never
persisted, embedded, or fed to a model.

**Crisper voice.** `CASUAL_VOICE` + `CHAT_STYLE_RULES` (prompts/style.ts) now
carry a hard brevity rule (default one to two lines, ~350 chars, lead-then-stop).
Every Yoinky-voice prompt embeds these, so it applies to proactive + journey chatter uniformly.

**Scheduled calendar.** `/app/scheduled` now defaults to a month calendar
(`components/scheduled-calendar.tsx`) reading `listScheduled`, placing pending
posts as day chips and nudging "add a post" on empty future days. A new
`web/scheduled.ts#createWebScheduledPost` (content-gated, `ensureBoss` + the
existing `schedulePost`) behind `POST /api/schedule` lets a web user write and
queue a post for a chosen day — the first manual web scheduling path (previously
Telegram/agent-only).

**Seeded Inspiration.** At the tail of `runDiagnosis` (first moment the niche
exists) an `inspiration.seed` job (`jobs/inspiration-seed.ts`) runs the existing
`trendMatchForUser` and `viralBenchmarkForUser` in a new **seed mode**: both take
a `seed` opt that persists the surfacing with `channel = 'web'` and skips the
Telegram send-and-delete tail (a web-only user has no DM to deliver to, and that
tail would otherwise roll back the insert). This pre-populates the web Trends &
Virals tabs with real, on-niche examples. Viral seeding gates on
`TWITTERAPI_IO_KEY` (paid pool) and derives its themes from the user's own
niche/pillars; trend seeding depends on the fleet `trends` table and no-ops if empty.

---

## 3l. Automations (multi-automation "auto agent") (2026-07-23)

Generalizes the single global autopilot (`users.settings.agent_mode` + one
`runAgentCycle`, both retired) into several independent, named automations. Each
has a source, cadence, and delivery mode; when due it runs a deterministically
selected item through the existing draft path and delivers one of two ways.
Doctrine holds: **code decides whether/which** (existing gates), the LLM only
composes. Migration `0024` (`automations`, `automation_runs`); the old
`agent.tick` schedule is unscheduled and every `agent_mode` user is migrated to
one `unlock_backlog` auto automation.

**Sources (`automations/sources/`, a selector contract, no LLM).** `trend_ride`
reuses `selectEligibleTrends` (extracted from `trendMatchForUser` so the proactive
`⚡` nudge and the automation share ONE niche→buzz→rank selector; a pure read, no
moment creation), deduped against the automation's own prior runs. `unlock_backlog`
uses `topPendingUnlock` + `markUnlockDeveloped` (the old autopilot's source).
`custom` (added `0026`) is the govork-style "define it freely" path: no external
search, the user's own **`brief`** text IS the seed handed to drafting. A third/
fourth source is one selector + one registry entry; any `per_user_paid` type must
add its own budget gate first.

**Run pipeline (`automations/run.ts`).** Cap check BEFORE any paid/model call
(per-automation `monthly_cap` + global `AUTOMATION_USER_DAILY_CAP`) → deterministic
select → moderate the seed (`assertClean`) → compose via `generateDraft` (feed
voice, metered, voice+pillars+reach) → persist an `automation_runs` row → deliver.
The seed leads with the user's nearest position so `generateDraft`'s memory
retrieval hits (it declines on empty). A `brief` on a **preset** source is
appended as "Extra guidance from me"; on a `custom` source it is the seed itself. Every gating transition is an atomic claim
(`store.claimRun`: `UPDATE … WHERE id=$1 AND status=$expected RETURNING`), so a
duplicate tick / double tap / redelivered job can't double-draft/DM/post.

**Cron (`automations/tick.ts`, `automation.tick`).** Fires 3×/day; `isDue` gates
per-day (once), weekly-day, and an optional hour; quiet hours defer to a later
tick. Safe to over-fire.

**Approval mode.** Draft body is DM'd verbatim via `dmChannel` with a casual
framing line (only the label is casualized — voice split) + `auto:ok|edit|no:<runId>`
buttons. Callbacks in `bot.ts` call channel-agnostic actions in
`automations/approval.ts` (`approveRun`/`rejectRun`/`applyEdit`), which the web
Approvals inbox reuses. Approve → `schedulePost` (short delay, cancellable) →
`scheduled`. Edit binds the next Telegram turn (via `strategist_state.pendingAutoEdit`)
as an instruction to `reviseDraft` (a new revise-by-instruction composer; none
existed), re-presents the card, capped at `AUTOMATION_MAX_EDITS`.

**Auto mode (DARK until `AUTOMATIONS_AUTO_ENABLED`).** Never instant: schedules
`AUTOMATION_AUTO_DELAY_MIN` out (cancellable from the queue). A warmup ramp routes
the first `AUTOMATION_AUTO_WARMUP` posts of a new auto automation through approval
first. Outcome DMs come from the existing `jobs/scheduled-post.ts`. All gates still
run.

**Web (`/app/automations`, sidebar label "Auto Agent").** `web/automations.ts`
read model → `/api/automations/{list,save,toggle,run,approvals,verdict}` → a lean
`components/automations.tsx`: automation cards (name · source · cadence · mode,
pause toggle, "run now", pending badge), a **brief-first, chat-styled config
modal**, and an Approvals inbox mirroring the Telegram cards. The modal leads with
a free-text brief (the `custom` default) plus mode cards for the two presets and
example-prompt chips; the structured options (delivery, cadence, monthly cap, name)
sit below. Both the name and the brief are moderated on save (`assertClean`); a
`custom` automation with an empty brief is rejected.

---

## 3m. Growth — gamified board (Diagnosis + Plan fused) (2026-07-24)

`/app/growth` (sidebar "Growth", top of the Grow group) fuses the two previously
unlinked strategist surfaces — Diagnosis (who you are) and Plan (what to do) — into
one board designed to actually move a user to post. `web/growth.ts#getGrowthState`
is a pure read model; `components/growth.tsx` renders it.

**Everything is computed from real stored data — no invented XP.** One `Promise.all`
gathers `currentDiagnosis`, `getPlan`, `getProfile`/`isProfileComplete`, the X
`connected_accounts` row (handle + `meta.followers`), a single counts query
(`captures` where `source='x_import'` for posts shipped + last-4-weeks; `unlock_items`
developed/pending; `automation_runs` drafts; `scheduled_posts` published; `automations`
count), and the last 600 `x_import` `captured_at` values for the streak.

**Game layer = behavioural levers over that data:**
- **XP + level** — XP only from things that happened (connect 50, profile 50,
  diagnosis 100, +40/developed idea, +15/agent draft, +4/post, +25/best-streak-week);
  a 7-rung `LEVELS` ladder (Ghost→Landmark) gives level, title, and the XP-to-next bar.
- **Brand Score /100** — four 25-pt pillars from measurable signal: Foundation
  (connect/profile/diagnosis), Consistency (weekly streak, 5wk = full), Depth (ideas
  developed), Momentum (posts last 4wk, ~2/wk = full). *Goal-gradient.*
- **Weekly posting streak** — consecutive weeks with ≥1 post; a not-yet-posted
  current week is grace (counts from last week, flagged "at risk"), never a scare-drop
  to 0. *Loss aversion.*
- **Quests** — an ordered next-best-action list (setup → habit → concrete plan-backlog
  ideas), each with XP, done state, and a CTA deep-link; completed ones collapse.
  *Zeigarnik / endowed progress.*
- **Milestones** — followers / posts / streak / ideas, each auto-picking the nearest
  unreached threshold with a progress bar.
- **Identity** — headline, throughline, owned positions, and the "unsaid" territory
  from the diagnosis; locked behind the setup quests until a diagnosis exists.

Additive only — no new tables, no migration. The standalone `/app/diagnosis` and
`/app/plan` routes still exist but Growth is the surfaced home for both.

---

## 3n. Agent SDK runtime (2026-07-24, IN PROGRESS — Phase 0/1)

Migrating the bounded agent loops (§3c) + eventually the chat brain (§3a) off the
bespoke `llm/tool-loop.ts` runner onto the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`), with the SDK's Anthropic-Messages traffic
routed through a **LiteLLM proxy → OpenRouter → grok-4.5** (any provider/key
later). Spec + canonical guide: `docs/Claude-Agent-SDK-Canonical-Guide.md`.

**Status: Phase 1 — adapter BUILT and validated 7/7 (2026-07-25). Five of six
loops are wired and ready to flip; every flag still defaults to `legacy`.**

The adapter lives in `src/agent-runtime/`:

| File | Role |
|---|---|
| `run-agent-loop.ts` | `runAgentLoop(feature, req)` — a drop-in for `runToolLoop(req)` that dispatches legacy vs SDK per flag |
| `mcp-tools.ts` | Derives SDK `tool()` defs from a feature's existing `z.discriminatedUnion("name", …)` — no per-feature tool rewrite |
| `json-schema.ts` | zod-v3 → JSON Schema for the SDK's `outputFormat` (zod 3 has no `toJSONSchema`; `zod/v4` cannot read v3 schemas) |
| `capacity.ts` | The `AGENT_MAX_CONCURRENCY` semaphore + cgroup memory admission control |

All five `runToolLoop` callsites now call `runAgentLoop("<feature>", …)`:
`consistency/check.ts`, `jobs/viral-benchmark.ts`, `jobs/trend-match.ts`,
`engagement/reply-agent.ts`, `buyer/radar-agent.ts`.

**`AGENT_RUNTIME_CHAT` IS now wired** (`agent-runtime/chat-turn.ts`, dispatched
from `telegram/conversation.ts`) — but **leave it on `legacy`**, for a measured
reason, not caution.

Chat could not reuse `runAgentLoop`: the five bounded loops are pure (tools
return text, nothing reaches the user until the final object), whereas each chat
tool call has a SIDE EFFECT mid-turn — `executeTool` says a short beat ("on it,
checking that first"), runs the tool, and persists both, so a 3-tool turn appears
in history as its fragments. Hence a separate entry point.

**The beat does not survive the SDK runtime.** Three attempts, each ruling
something out:
1. Read the beat from the completed `assistant` message → empty.
2. Wait for that message via an epoch counter → still empty, **and it deadlocks**:
   the tool handler blocks the very iterator it is waiting on, burning the full
   timeout per call. Do not reintroduce a wait.
3. `includePartialMessages` + an explicit "narrate before each tool" instruction
   → partial streaming demonstrably works (`toolBlocks=3` observed) but the text
   buffer is still empty (`toolCalls=2 withBeat=0`).

So the beat is never *generated*, not lost in transit. The likely cause is
`outputFormat: json_schema` — enforcing structured output leaves no room for
free-text narration between tool calls. The untried remedy is to drop
`outputFormat` for chat and recover the final object with a loose JSON parse,
trading output reliability for narration; that is a real trade and deserves its
own change. **Flipping chat today gives a functionally correct turn that is
SILENT until the final reply, where legacy narrates each step.** Everything else
about the chat path validates (E1: real converse prompt, tools called, valid
result), so it is ready the moment that trade is made.

**Phase 1 validation — 7/7, `ADAPTER OK`** (`scripts/validate-agent-runtime.ts`,
run inside Railway against the live private proxy, using the REAL
consistency-check.v2 prompt with stubbed executors):

| # | Test | Result |
|---|---|---|
| A1 | legacy runner baseline | PASS — `no_conflict` conf=0.88, 2 tool calls |
| A2 | **SDK runner, schema-valid output** | **PASS** — `runtime=sdk`, `no_conflict` conf=0.90, 3 tool calls |
| A3 | **protocol override worked** | **PASS** — 3 real tool calls; 0 would mean the model kept emitting the JSON envelope |
| A4 | SDK and legacy agree | PASS — both `no_conflict` |
| B | subprocess memory | PASS — limit 7629 MB, idle 243 MB, **peak delta +163 MB**, 7223 MB still free |
| C | **model fallback engages** | **PASS** — `modelsUsed=[yoinky-agent-fallback]`, returned `"failover"` |
| D | anti-loop ledger | PASS — 3 executor calls, 3 distinct, 0 duplicates |
| E1 | chat turn over the real converse.v3 prompt | PASS — 2 tools called, valid `{reply, capture, offer_angles}` |
| E2 | mid-turn beats | **withBeat=0 — the known limitation above; chat stays `legacy`** |

Two findings from building it, both now encoded:

1. **`maxTurns` must not be `maxToolCalls + 1`.** That is the obvious mapping and
   it is wrong: the model spends a turn per tool call and needs at least one more
   to compose, so a loop that uses its full budget dies with "Reached maximum
   number of turns" instead of answering (observed on the first validation run).
   The tool budget is now enforced in the `PreToolUse` hook — a *deny* that tells
   the model to answer now, exactly mirroring the legacy runner's `forceFinal` —
   and `maxTurns` is only a runaway backstop at `maxToolCalls + 3`.
2. **Scoped virtual keys make a bogus model name untestable for fallback.** The
   key is scoped to `[yoinky-agent, yoinky-agent-fallback]`, so an unknown name
   401/403s at the key check before the SDK's fallback logic runs. Testing
   fallback needs a *routable but upstream-broken* alias, hence
   `yoinky-agent-broken` in `litellm-config.yaml` (called with the master key).

**Rollout.** `AGENT_RUNTIME_CONSISTENCY=sdk` is **LIVE in production** as of
2026-07-25 (the first flip; backend healthy after restart). Flip the rest one at
a time — `VIRAL`, `TREND_TAKE`, `REPLY`, `BUYER` — watching for
`agent-runtime FALLBACK` in the logs between each:
```
railway variable set AGENT_RUNTIME_VIRAL=sdk --service backend
```
`AGENT_SDK_FALLBACK_TO_LEGACY` (default true) re-runs a failed SDK loop on the
legacy runner and logs loudly. That is a RUNTIME fallback (same model, other
runner) — deliberately distinct from the model-level auto-fallback this section
refuses to make silent.

---

**Phase 0 record (2026-07-25) — infra live.**
Shipped so far: the SDK dep, the config flags (`AGENT_RUNTIME_*` per feature,
default `legacy`; `LITELLM_*`; `AGENT_MODEL`/`AGENT_FALLBACK_MODEL`;
`AGENT_MAX_CONCURRENCY`; `AGENT_MAX_BUDGET_USD`), `litellm-config.yaml`, the
verification spike `packages/backend/scripts/spike-agent-sdk.ts`, and the
deployed proxy. **Nothing routes through the SDK yet** — every feature is
`legacy`, so this is inert in prod. The adapter (`src/agent-runtime/*`) is the
next thing to build.

**Deployed infrastructure** (see DEPLOY.md for the runbook):

| Piece | Identifier |
|---|---|
| Proxy | Railway service `litellm`, image `ghcr.io/berriai/litellm:v1.93.0`, built from `Dockerfile.litellm` |
| Reachability | `http://litellm.railway.internal:4000` — **private network only, no public domain** |
| Key store | Neon project `yoinky-litellm` (`autumn-credit-25191795`), `aws-eu-central-1`, PG17 — deliberately NOT `yoinkybot-prod` |
| Backend wiring | `LITELLM_BASE_URL` + `LITELLM_API_KEY` (virtual key scoped to `yoinky-agent`, `yoinky-agent-fallback`) |

Two gotchas that cost real time and are baked into the files now:
- `main-v1.93.0-stable` **does not exist** on ghcr.io (404). The `main-vX-stable`
  tag scheme stopped around 1.66; the correct pin is `v1.93.0`.
- Railway has **no file-mount primitive**, so `litellm-config.yaml` is baked into
  a thin derived image (`Dockerfile.litellm`) rather than mounted, and the proxy
  must bind `::` (not `0.0.0.0`) or it is unreachable over the private network.

**Phase 0 is a HARD GATE.** Deploy the LiteLLM service, then run the spike against
it; it proves (or disproves) that grok-4.5 *through LiteLLM's Anthropic→provider
translation* handles a multi-step in-process MCP tool loop, parallel tool use,
`outputFormat` structured output, `PreToolUse` deny, and `maxTurns`/`maxBudgetUsd`
termination — and reports which auth env var LiteLLM accepts + token/latency
numbers. If the multi-tool loop or parallel-tool test fails, the SDK is not a
viable backend for grok-4.5-via-LiteLLM and the migration stops here. **Fill in
the verified findings below once the spike has run.**

**Phase 0 spike results — 8/8 PASS, `GATE OK` (2026-07-25, run against the live
private proxy):**

| # | Test | Result |
|---|---|---|
| 1 | basic query | PASS — `subtype=success`, returned `"pong"` |
| 2 | **multi-step tool loop (THE gate)** | **PASS** — `search=1 profile=1 steps=2`; grok-4.5 chains tool calls correctly through LiteLLM's translation |
| 3 | **parallel tool use** | **PASS** — `subtype=success steps=2`, no crash |
| 4 | structured output (`outputFormat`) | PASS — valid `structured_output` object, so the fallback plan is not needed |
| 5 | `PreToolUse` deny | PASS — hook fired and the deny was honored |
| 6 | `maxTurns` / `maxBudgetUsd` | PASS — **both caps terminate by THROWING**, not by returning a result subtype |
| 7 | auth var | PASS — LiteLLM accepts **both** `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` |
| 8/9 | usage + latency | PASS — first token ~1.8–2.1s, full 2-tool loop ~6.3–7.0s |

Three findings the adapter must encode:

1. **Caps throw; they do not return.** `maxTurns`/`maxBudgetUsd` surface as a
   thrown `Error` ("Reached maximum number of turns (1)"), *not* as a `result`
   message with `subtype=error_max_turns`/`error_max_budget_usd`. An adapter that
   only inspects `result.subtype` will treat a capped run as an unhandled crash.
   Wrap every `query()` drain in try/catch and classify the throw.
2. **`PreToolUse` matchers need the FULL namespaced tool name.** In-process MCP
   tools are `mcp__<server>__<tool>`; a bare `"get_profile"` matcher silently
   never fires. This is exactly the anti-loop ledger's mechanism, so getting it
   wrong would have failed open. (The first spike run reported test 5 as FAIL for
   this reason — a bug in the spike, not the SDK.)
3. **The SDK's `total_cost_usd` is wrong for grok-4.5 — confirmed, not assumed.**
   For the test-8/9 query the SDK reported `costUSD=0.011293` on
   `inputTokens=226, outputTokens=363, cacheReadInputTokens=2176`. At grok-4.5's
   actual OpenRouter rates ($2/M in, $6/M out, $0.30/M cached read) that run cost
   `0.0033` — the SDK over-reports by **~3.4×** because it prices the unknown
   model `yoinky-agent` off an Anthropic-shaped default (note it also self-reports
   `provider: "firstParty"`). **Never meter from the SDK.** `litellm-config.yaml`
   now carries a `model_info` cost map per model, so LiteLLM's `LiteLLM_SpendLogs`
   is the accurate ledger.

_Caveat on the cross-check:_ the direct `LiteLLM_SpendLogs` read was not performed
— this network blocks outbound 5432 (see the networking note below), so the cost
comparison above is arithmetic against OpenRouter's published rates rather than a
row-level diff. Worth a one-time confirmation from a less restricted network.

**Networking constraint discovered while deploying.** The dev machine's network
blocks outbound **22** (`railway ssh`), **2226** (`railway sandbox exec`) and
**5432** (direct Postgres); only 80/443 pass. Since the proxy is private-only,
that leaves no interactive way in. The documented `railway run --service backend …`
form in the original plan **cannot work regardless of network** — `railway run`
executes on your laptop with Railway's env vars injected, and `*.railway.internal`
is private DNS that does not resolve off-platform. The escape hatch, now checked
in, is to deploy the spike **as a short-lived Railway service**
(`Dockerfile.spike` + `scripts/mint-litellm-key.ts`) and read results from
`railway logs`, then delete the service. That path works from any network and
never exposes the proxy publicly.

**Hosting:** SDK mode is **Railway-only** — it spawns a Claude Code subprocess
needing a real filesystem, which a Vercel serverless function is not (same
`in-process import ≠ same process` lesson as §3i). Buyer Radar "Scan now" has
been moved off the Vercel request path accordingly: `POST /api/buyers-radar/scan`
now enqueues `buyer.scan-now` (pg-boss) and returns a `jobId`, and the client
polls `GET …/scan?jobId=…`. The worker returns the `ScanResponse` as the job's
output, so the user still gets the same funnel counts and `reason` sentence. Two
incidental fixes came with it: `workers.ts`'s `logged()` now RETURNS the handler's
value (it was discarding it, which would have silently dropped every job output),
and the queue gets a 30-minute expiry because a scan fans out into several
composition loops that may queue behind the concurrency cap.

**NO RAILWAY UPGRADE IS NEEDED — the earlier "~1 GiB per subprocess, the plan
likely needs an upgrade" note was wrong, and measurement is what disproved it.**
The container limit is **7629 MB / 8 vCPU**, the backend idles at **~156-243 MB**,
and one SDK subprocess peaks at **+152-163 MB** — not ~1 GiB. At the default
concurrency of 4 that is ~1 GB of a 7.6 GB box, and there is room for several
times more. What was actually missing was not headroom but a *bound*:
`AGENT_MAX_CONCURRENCY` was a config flag nothing enforced. `capacity.ts` now
enforces it with a FIFO queue plus a cgroup-based memory check (`os.freemem()` is
useless here — inside a container it reports the host's memory), and a loop that
cannot get a slot within `AGENT_ACQUIRE_TIMEOUT_MS` runs on the legacy runner
rather than queueing unboundedly.

**Settled by Phase 0:** multi-turn tool-use fidelity and structured output through
LiteLLM's translation both work; LiteLLM accepts either auth env var; the SDK's
`total_cost_usd` is confirmed wrong for grok-4.5 (~3.4× over) — meter from
LiteLLM's spend log or our own `PRICE` map.

**Still unverified:** whether LiteLLM serves `/v1/messages/count_tokens` for an
OpenRouter-backed model (the spike never called it); Railway concurrency headroom
under real load; prompt-caching economics against a non-Anthropic upstream (the
spike did see non-zero `cacheReadInputTokens`, so caching is at least active);
whether the `yoinky-agent-fallback` route actually engages on a primary failure —
the spike exercised the fallback *config* but never forced grok to error, so
**force one failure before relying on it**. Also note the SDK peer-wants `zod@^4`
but the repo is on `zod@3`; the SDK's `tool()` types accept `ZodRawShape | zod/v4`
(both), so v3 raw shapes work — the warning is cosmetic.

**Neon free-tier hygiene (why `litellm-config.yaml` looks the way it does).** The
key store is a free Neon project: autosuspend after 5 min idle (not disableable)
and 100 CU-hours/project/month at a 0.25 CU floor. LiteLLM's `reset_budget` job
polls the DB every 597–605s — a *shorter* period than the suspend window — so
left on it would pin the compute awake ~24/7 (0.25 CU × 730h ≈ 182 CU-hours) and
exhaust the allowance in ~2.5 weeks, taking the agent runtime down with it.
`disable_reset_budget: true` fixes that; it only resets `budget_duration` rolling
budgets, which we do not use. Every other recurring job was checked against
v1.93.0 source and is a genuine no-op when idle (`update_spend` guards on
`len(...) > 0`, `_update_daily_spend` loops `while daily_spend_transactions:`,
`_monitor_spend_logs_queue` guards on `queue_size > 0`, and
`add_deployment`/`get_credentials` only run under `store_model_in_db`, which is
off). Cold start is kept off the request path by `user_api_key_cache_ttl: 3600`
plus `allow_requests_on_db_unavailable: true`, which serves a request under a
synthetic **non-admin** auth if the DB connection errors mid-wake — it catches
connection errors only (a bad key still 401s) and cannot escalate to proxy-admin,
and the "VPC only" caveat in LiteLLM's docs is satisfied by this service having no
public domain.

---

## 4. Data model

Schema is a linear migration chain in `src/db/migrations/` (`0001`…`0027`),
applied on boot and via `pnpm db:migrate` (`src/db/migrate.ts`). pgvector is
required for embedding columns. (`0026` widens `automations.source_type` to allow
`custom` and adds `automations.brief`; `0027` widens `subscriptions.plan` to allow
`scale`.)

Design invariants:
- **Identity** — `users` can be keyed by `telegram_id`, `email`, `x_user_id`, or
  (since `0025`) **`clerk_user_id`** (Clerk is the web identity provider). All are
  additive, nullable, unique.
- **Trial** — a new signup gets a `subscriptions` row with `status='trialing'` +
  `trial_ends_at = now()+TRIAL_DAYS` (`0025` also adds `intended_plan`). The trial
  is a paid-tier grant resolved at read in `entitlementsFor`/`trialInfo`; `'trialing'`
  is never written to `plan` (whose CHECK is free/paid/**scale**/founding since
  `0027`). Once past `trial_ends_at` the plan falls to free — no sweep, computed on
  read. **Scale** is a distinct billable product (`DODO_PRODUCT_SCALE`) with the
  same paid entitlements today; Settings → Plan & billing offers the explicit
  move onto it.
- **Captures are immutable**; memories are derived and re-derivable from captures.
- **Forget is hard deletion**, not a tombstone.
- `brand_profiles` is the stated profile (one row/user, `0013`); it is user-stated
  input, distinct from `brand_diagnoses` (derived analysis). Wiping the account
  (`resetUserData`) clears it with everything else.
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
- `X_CLIENT_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET` — the user-context OAuth
  apps. They power both the OAuth-first onboarding connect (§3f) and scheduled
  *posting* (§3e), distinct from the read-ingestion keys above. Unset →
  onboarding falls back to the typed-handle ask, scheduling works but
  publishing fails closed. X posting needs a paid X tier.
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
  `NEXT_PUBLIC_CLERK_SIGN_IN_URL`/`SIGN_UP_URL` — **required** for the web app
  (Clerk auth). Social logins are configured in the Clerk dashboard, not here.
- `DODO_*`, `PAYWALL_ENABLED` (must be `true` for the trial to actually gate once
  it lapses), `TRIAL_DAYS` (default 7).
- `POSTHOG_API_KEY` / `POSTHOG_HOST` — server-side product analytics (§3g).
  Optional; unset = no-op.

Never commit real secrets. Secrets in git history stay there forever even after
deletion — set them in the deploy dashboard only.

---

## 6. Ops

- **Deploy:** see [DEPLOY.md](../DEPLOY.md). **Railway (Hobby plan) + Neon**
  (external, pgvector) as of 2026-07-12 — moved off Render's free plan because
  its idle spin-down was silently killing `pg-boss`'s in-process cron (see §3c's
  trend-fetch note). The database never moved; only compute did. Single
  instance only, either way — pg-boss's cron and the Telegram webhook both
  assume exactly one running replica.
- **Pre-deploy gate:** `pnpm verify` (typecheck + full unit suite). Don't ship red.
- **Migrations** run automatically on boot; also `pnpm db:migrate`.
- **Prod vs dev bot:** with `PUBLIC_URL=https://…` the bot uses webhooks; without
  it, long-polling. No flag to flip.
- **Alerts:** job failures/crashes DM `ADMIN_TELEGRAM_ID` via the bot (throttled).
  Failed live conversation turns (profiling/session/converse) also DM the admin
  with the underlying error, hourly-throttled per kind — a dead LLM route pages
  instead of hiding behind fallback lines.
- **Health check:** `GET /health` reports `{ok, llm, analytics, trends:
  {provider, buzz_gate, last_fetch}}` — `llm` is `OPENROUTER_API_KEY` presence
  (`false` = the bot can only send canned fallbacks, the "asks the same
  question forever" symptom; boot also logs a loud error and DMs the admin),
  `analytics` is `POSTHOG_API_KEY` presence, and the `trends` block reports
  whether the trend pipeline's keys are present and when it last actually
  fetched — the fastest way to confirm background jobs are alive post-deploy,
  not just the HTTP server. See DEPLOY.md troubleshooting.
- **Cost & abuse:** `usage_events` is the source of truth for per-user spend; the
  daily call cap (`LLM_DAILY_CALL_CAP`) bounds interactive spam.
- **Keep-alive:** removed 2026-07-17. `.github/workflows/keepalive.yml` pinged
  `/health` every 10 minutes solely to fight Render free-tier spin-down;
  Railway Hobby is always-on, and Render itself is now decommissioned (see
  DEPLOY.md), so the workflow was deleted rather than left dead.

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
