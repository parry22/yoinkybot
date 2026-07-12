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
| Telegram bot | `src/telegram/` | grammY bot, command handlers, conversation state. Commands (deliberately lean): `start, help, connect, draft, repurpose, connectposting, peers, settings, upgrade`. `connectposting` (grant write access) was added 2026-07-12 with scheduling — see §3e. The scheduling engine is built and tested, but its user-facing surface (`/scheduled`, the `schedule_post` chat tool) is deliberately not wired in yet — see §3e. Everything else (check, search/ask, status, diagnosis refresh, voice, forget, plan, positions, clearing your account) is done in plain language via the agentic chat layer (see §3a). |
| Strategist flow | `src/strategist/` | The a16z Personal Brand Strategist onboarding. Profile-first arc: profiling (Stages 1-6, 7 fields) → connect → gap analysis → three-month plan → proactive. `session-machine.ts` is the state machine; `state.ts` persists it; `profile.ts` owns the stated profile; `gap.ts` computes the stated-vs-actual gap. See §3b. |
| Capture pipeline | `src/capture/` | Immutable capture of user input + imports (X via twitterapi.io→Apify, LinkedIn via Apify). Captures are never mutated. |
| Memory core | `src/memory/` | Extraction → embed → link → search (RRF hybrid). `positions.ts` (stated positions), `confidence.ts`, `forget.ts` (hard delete), `classification.ts` (rhetorical mode/sincerity/motive taxonomy + gating helper), `corrections.ts` (user-correction mechanism + monthly recalibration). See §3d. |
| Voice | `src/voice/` | Voice profile from a user's own corpus; used to ground drafting. |
| Consistency | `src/consistency/` | Pre-publish check: does a draft contradict a stated position? Embed → match positions → LLM meaning-level compare. Ambiguous matches (top-2 within `CONSISTENCY_AMBIGUITY_DELTA`) escalate to a bounded agent (see §3c). |
| Drafting | `src/drafting/` | `angle-draft.ts` (3 ways to tell a story), `draft.ts`, `repurpose.ts` (transform, not regenerate). |
| Trends | `src/trends/` | Provider registry with ordered fallback (`TREND_PROVIDER`: apify → brave → tavily). Actor ids in config are verified against live runs — see provider files for field shapes. Discovery seeds are LLM-distilled (`prompts/trend-themes.v1.ts`, from `jobs/trend-fetch.ts#interestThemes`) into short professional search terms — raw cluster labels proved to be personal-life noise that made the pipeline miss an entire AI news cycle (2026-07-12). `scoring.ts` (deterministic buzzScore) + `providers/twitterapi.ts` (advanced_search volume verification) gate the macro-moment agent (§3c). |
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
is kept alive for the whole turn (`withTyping`, 4.5s heartbeat).

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
  `embedded_draft` field of `trend-take.v1`) use
  `CHAT_STYLE_RULES`/`POST_WRITING_RULES` but **must never** get `CASUAL_VOICE`,
  and `casualize()`/`enforceStyle` is never run over their output as a
  lowercasing pass. `sendTelegram` (single-message) is deliberately NOT
  casualized because it carries this content; only `sendTelegramSequence` is.
  When a chat wrapper embeds content (e.g. `"✍️ here you go:\n\n{draft}"`), only
  the label is casual — the draft body keeps its own capitalization.

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

As of 2026-07-11 onboarding is **profile-first**. It draws out a stated brand
profile *before* reading history, so the diagnosis lands as a measured
stated-vs-actual gap rather than a cold read. The whole arc runs on the same
deterministic-reducer + paced-LLM engine as before.

**The arc.** `profiling` (Stages 1-6 intake) → `connect_transition` (Stage 7,
OAuth-first when the platform apps are configured — see §3f) →
connect + ingest + diagnosis → `gap_analysis` (Stage 10) → `plan_build` (Stage 11,
the three-month plan) → `active`. Phases live in `state.ts#SessionPhase`;
`isProfilingPhase`/`isOnboardingPhase` gate routing. Durable milestones on
`users.strategist_stage`: `new → profiling → profile_set → connected → diagnosed
→ plan_active` (the CHECK was widened in `0013`; old values kept).

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
| Macro-moment (`jobs/trend-match.ts` → `trend-take.v1`) | daily send gate → monthly cap → niche gate (pgvector vs positions, `NICHE_THRESHOLD`, *before* any paid twitterapi.io call) → buzz gate (`trends/providers/twitterapi.ts` two-pass advanced_search → `trends/scoring.ts#buzzScore` > `BUZZ_THRESHOLD`; distinct authors weigh more than raw tweet count) → position gate (macro-match.v1, unchanged) | `get_top_tweets` (cached verified pool, no new spend), `search_memory`, `get_voice_profile`, `get_goals_and_pillars`, `get_positions` | 4 |
| Consistency (`consistency/check.ts` → `consistency-check.v2`) | two escalation signals, both code-decided: top-2 position matches within `CONSISTENCY_AMBIGUITY_DELTA` (from embeddings, before any model call), OR the single-shot v1 pass returns `confidence < CONSISTENCY_CONFIDENCE_THRESHOLD` (a shaky first read is escalated, not acted on). The confident, clean-match common case stays single-shot v1 | `search_more_positions`, `get_position_context`, `search_memory` | 3 |
| Reply drafting (`engagement/reply-agent.ts` → `reply-draft.v2`) | reply-worthiness scoring + learned threshold (`engagement/scoring.ts`) — untouched, decides *whether* to draft at all | `search_memory`, `get_voice_profile`, `get_content_pillars`, `get_thread_context`, `get_engagement_heuristics` | 3 |

Notes worth knowing:
- **Macro-moment delivery** is distinct: surfacing type `trend_take` (migration
  0016, in `PROACTIVE_TYPES` so it shares the unified budget + quiet hours), a
  `⚡`-framed DM with no 🔥/💤/🗑 resurfacing card. The agent may return
  `fires: false` — a skipped moment costs nothing, a forced one costs trust; a
  declined trend doesn't burn the day (only a *sent* take does), but the trend
  itself is dedup'd via its moment row. `trendMatch` is scheduled 3×/day; the
  handler enforces at-most-one send. Without `TWITTERAPI_IO_KEY` the buzz gate
  can't run and the pipeline degrades to the old niche+position → angle-offer
  flow.
- **Trend non-deliveries are recorded, and don't burn the month** (2026-07-12):
  agent declined / cadence held / send dropped → the moment gets
  `verdict='rejected'` + `verdict_reason`, so "why did nothing fire this week?"
  is answerable from SQL, and the 4-per-month cap counts only non-rejected
  moments — four invisible declines used to silently starve trend delivery for
  30 days. `NICHE_THRESHOLD` default is 0.6 (calibrated live: on-niche trends
  sit 0.40-0.55 from the nearest position, junk 0.61+; at the old 0.7 the junk
  passed and ate the top-3 volume-verification slots). `/health` reports trend
  readiness (`trends.provider`, `trends.buzz_gate`, `trends.last_fetch`).
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
  and `trendMatch` unconditionally (its handler already caps at one send/day
  per user, so an extra boot-time attempt is a no-op, never a duplicate).
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
  right before a Render redeploy aren't lost. `/health` reports
  `analytics: true|false`.
- **Verified** end-to-end against a local capture server: events reach the wire
  gzip-batched to `/batch/` with the right names, `distinct_id`, and
  metadata-only props; no-key path sends zero requests and never throws.

---

## 4. Data model

Schema is a linear migration chain in `src/db/migrations/` (`0001`…`0018`),
applied on boot and via `pnpm db:migrate` (`src/db/migrate.ts`). pgvector is
required for embedding columns.

Design invariants:
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
- `DODO_*`, `PAYWALL_ENABLED`.
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
- **Keep-alive:** `.github/workflows/keepalive.yml` pings `/health` every 10
  minutes. This existed specifically to fight Render free-tier spin-down; on
  Railway Hobby (always-on) it's no longer load-bearing — harmless to leave,
  safe to delete if you want one less moving part.

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
