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

Yoinky is now **web-first, with Telegram as a first-class add-on.** The web app
(`packages/web`, Next.js) is the main workspace — chat, onboarding, and the
diagnosis/plan/beliefs surfaces. **Telegram keeps every feature** and remains the
channel for proactive reach-outs (trend moments, consistency flags, daily reads),
which is where it's most useful. Both share one Postgres and one `users` row.

## Latest updates

<!-- Keep newest-first. Update this whenever a change ships that a reader of the repo should know about. -->
- **2026-07-25 — Post-migration sweep: all six loops now run on the Claude Agent
  SDK, plus three real fixes.** Every `AGENT_RUNTIME_*` flag is `sdk` in
  production. **Chat no longer goes silent:** the model will not narrate between
  tool calls under structured output, so `TOOL_BEATS` gives each chat tool a
  written beat ("checking what you've told me") used whenever the model supplies
  none — with a guard so the same line never repeats twice in a row. The sweep
  also caught a **money bug I had just introduced**: pg-boss v10 ignores
  `singletonKey` on the default `standard` queue policy, so double-clicking
  "Scan now" bought *two* paid Buyer Radar scans — now guarded by an in-flight
  re-attach plus a `short` queue policy. And **dependency advisories went 29 (16
  high) → 1**: `next` had been pinned exact at 16.2.4 and drifted seven patches
  behind → 16.2.11, `fastify` → 5.10.0, with overrides for
  postcss/fast-uri/find-my-way/sharp. The one left (`@hono/node-server`) is
  unreachable here — only the MCP HTTP transport imports it and we use in-process
  MCP servers. See INTERNAL §3n.


- **2026-07-25 — Agent SDK adapter built; 5 loops ready to flip; no Railway
  upgrade needed.** `src/agent-runtime/` adds `runAgentLoop(feature, req)`, a
  drop-in for `runToolLoop(req)` that dispatches legacy-vs-SDK per feature flag.
  Tool porting is **mechanical, not per-feature**: every loop already declares its
  tools as `z.discriminatedUnion("name", …)` next to an executors map, which is
  enough to derive SDK `tool()` definitions automatically — so adding a tool still
  means editing one union and one map. Validated **7/7** against the real
  consistency prompt on the live private proxy: SDK output is schema-valid and
  agrees with legacy, the anti-loop ledger denies repeats, and model fallback
  genuinely engages when the primary breaks. **The "needs a bigger Railway plan"
  assumption was wrong** — measured, a subprocess costs **~163 MB**, not ~1 GiB,
  against a 7.6 GB limit; the missing piece was a bound, so `AGENT_MAX_CONCURRENCY`
  is now actually enforced with cgroup-based admission control. Buyer Radar
  "Scan now" moved off the Vercel request path to a pg-boss job (enqueue → poll),
  since SDK composition spawns a subprocess a serverless function cannot host.
  **`AGENT_RUNTIME_CONSISTENCY=sdk` is now live in production** — the first flip;
  the other four loops are ready and flip one at a time. The chat brain is also
  wired now (`agent-runtime/chat-turn.ts`) but stays on `legacy`: its mid-turn
  "on it, checking that first" beat does not survive the SDK runtime — measured
  across three attempts, the narration is never generated, most likely because
  enforced structured output leaves no room for free text between tool calls.
  Flipping chat today would work but go silent until the final reply. See
  INTERNAL §3n for the full finding and the untried remedy.

- **2026-07-25 — Agent SDK migration: Phase 0 gate PASSED, LiteLLM proxy live.**
  The proxy the Claude Agent SDK routes through is deployed as its own Railway
  service (`ghcr.io/berriai/litellm:v1.93.0`, built from `Dockerfile.litellm`),
  reachable **only** at `http://litellm.railway.internal:4000` — no public domain.
  Its virtual-key store is a **separate free Neon project**, deliberately not the
  app DB. The spike now passes **8/8** against the live path: grok-4.5 through
  LiteLLM's Anthropic→OpenRouter translation handles multi-step in-process MCP
  tool loops, parallel tool use, structured output, `PreToolUse` deny, and both
  cost/turn caps. **Still inert in prod** — every `AGENT_RUNTIME_*` flag remains
  `legacy`; the adapter is the next thing to build. Three findings the adapter
  must encode (caps *throw* rather than return; `PreToolUse` matchers need the
  full `mcp__server__tool` name; the SDK's own `total_cost_usd` over-reports
  grok-4.5 by ~3.4× so metering must come from LiteLLM) are written up in
  INTERNAL §3n. Runbook in DEPLOY.md.

- **2026-07-24 — Sidebar: Telegram Bot launcher + profile-row cleanup.** Since
  Clerk owns identity, the sidebar's redundant profile row (avatar/email/logout)
  is gone — sign-out already lives in the topbar `<UserButton>` and on Settings.
  In its place, a bottom-anchored **Telegram Bot** item that opens the bot through
  the tokenized deep link (`POST /api/telegram/link` → `?start=<token>`), so it
  both takes the user to Telegram **and** links their Clerk account on first open
  (the auth-gated bot rejects an unlinked visitor, so a plain `t.me` link won't do).
  Frontend-only; the backend link primitive already existed. See INTERNAL §3f.

- **2026-07-24 — Grok 4.5 cost/cache optimization (phases 3–5).** Builds on 1–2;
  all safe-defaulted and correct at a 0% cache hit rate. (3) **Cache affinity wired
  (§3):** the chat turn carries one `cacheKey` (`chat:{hash(userId)}:{turnId}`) across
  all its tool-loop iterations, and `runToolLoop` derives a per-(event,user) key —
  so replayed context lands on a warm server. `converse.v3` now computes `now` ONCE
  per turn (not per iteration), so the front of the user message is byte-identical
  across a turn and only the appended tool notes vary (§2/§6 prefix stability). (4)
  **Loop append-only confirmed (§6):** `toolNotes` are push-only, never rewritten;
  `reasoning_content` retention is **N/A** to our stateless 2-message (system+user)
  gateway — there's no assistant turn replayed, so the cache win comes from stable
  prefix + affinity, not reasoning replay (honest deviation from the spec's
  Chat-Completions assumption). (5) **Native structured outputs plumbed (§5):**
  `LlmRequest.jsonSchema` sends `response_format: json_schema` (constrained decoding)
  when a call opts in; a 400 degrades (drops it) and the JSON recovery **ladder stays
  as fallback**; a `json-ladder-entry` counter (`ladderEntryCounts()`) now logs which
  prompts still need the ladder. **Deferred (deliberately):** the full per-prompt
  L1/L2/L3 re-layering (§2 long tail — incremental, low marginal gain over affinity in
  a 2-message gateway) and per-callsite schema attachment (best prioritized by the new
  counter; skip freeform-`tool` prompts like converse). **Phase 6 (Batch API) not
  started** — the spec gates it on live measurement + an account SLA/discount check.
  See INTERNAL §2.

- **2026-07-24 — Grok 4.5 cost/cache optimization (phases 1–2 of the spec).**
  Foundation for cutting per-call spend without changing what any feature does.
  (1) **Metering now accounts for cached input** (`usage/meter.ts`, migration `0028`):
  `PRICE` is 3-rate `{in, cachedIn, out}`, `cost()` bills the cached fraction at the
  ~4x-cheaper rate, and `usage_events` gains nullable `cached_input_tokens` +
  `reasoning_effort`; `usageSummary` exposes `cache_hit_rate`. Without this, spend was
  systematically overstated. (2) **`LLM_TRANSPORT` switch** in `gateway.ts`: `openrouter`
  (default — zero change) or `xai` (direct `api.x.ai`, for the `x-grok-conv-id`
  cache-affinity header + `cached_tokens` + `reasoning_effort`). Rollback is one env var;
  `XAI_API_KEY` required only when flipped. (3) **`tier` → `reasoning_effort`**
  (`frontier→high`, else `low`) — reasoning tokens bill at the output rate, so it's the
  biggest per-call lever; composition prompts stay `high` pending the §10 A/B. (4)
  **`cacheKey` + `hashForCacheKey`** plumbed through the gateway (per-callsite keys land
  in phase 3). Correct at a 0% cache hit rate. **Verify before flipping to xai:** the
  exact `XAI_MODEL` id, Grok 4.5 regional availability, `cached_tokens` shape (set
  `LLM_DEBUG=1`), and live prices. Phases 3–6 (prefix layering, loop cache-friendliness,
  native structured outputs, Batch API) still pending. See INTERNAL §2.

- **2026-07-24 — Pre-launch fix sweep: Grok 4.5, Buyer Radar unblocked, Inspiration
  for web users, culturally-aware drafts, cleaner UI.** Five fixes from live-prod
  diagnosis: (1) **Model switch** — `MODEL_CHAT` default (and env on both deploys) is
  now `x-ai/grok-4.5` (was `z-ai/glm-5.2`): native X/cultural awareness for drafts,
  trend takes, and buyer outreach; PRICE map updated ($2/M in, $6/M out, verified on
  OpenRouter). (2) **Buyer Radar surfaced ZERO intents, ever** — root-caused by
  replaying the funnel against prod data: discovery found 60 candidates, 41 passed
  intent, and the semantic niche gate rejected 100% (best cosine distance 0.569 vs
  the 0.55 cliff under Qwen embedding geometry). Fix: threshold recalibrated to 0.62
  + a top-K rescue pass (`BUYER_NICHE_CEILING` 0.78, K=3) so the nearest plausible
  candidates still reach the composition agent (which researches + declines off-fit
  ones) instead of an empty radar forever. (3) **Inspiration was Telegram-only** —
  the recurring trend/viral jobs selected `WHERE telegram_id IS NOT NULL`, so
  web-only users never got surfacings (prod: 37 surfacings, all for the two Telegram
  accounts, zero for the web account). Both jobs now include users with a connected
  X and persist for them in seed mode (channel 'web', no DM); plus a stale-guarded
  on-demand fill (`refreshInspirationForWeb`, `POST /api/inspiration/refresh`) that
  the page auto-triggers when empty ("Scanning your niche…"). (4) **Drafts are now
  culturally grounded** — `generateDraft` embeds the request and pulls the nearest
  fresh fleet trends (48h window, one pgvector query) into a new `LIVE ON X RIGHT
  NOW` prompt block (use only if it genuinely sharpens the post). (5) **UI cleanup**
  — internals removed from user-facing copy (post-scan counts, "Not shown - and
  why", vendor names, formula subs); Growth page decluttered (no kind tags, single
  identity column, lighter milestones). See INTERNAL §2 / §3j / §3i.

- **2026-07-24 — Growth vs Scale are now REAL (enforced caps, web + Telegram).**
  Until now every non-free plan shared one `PAID` entitlements bundle — the tiers
  were cosmetic. `Entitlements` (`billing/entitlements.ts`) gains numeric caps
  (`null` = unlimited) + an `autoAgent` flag, split into `GROWTH`, `SCALE`, `FREE`:
  Growth = 30 scheduled posts/mo · 25 buyer intents/mo · 1 viral/day · 3
  resurfaces/wk · **no** hands-off auto-agent; Scale = all of those **unlimited** +
  auto-agent + 5 resurfaces/wk. `entitlementsFor` maps `paid→GROWTH`,
  `scale`/`founding`/`trialing`→`SCALE` (the trial is the full Scale experience);
  paywall-off dev stays uncapped. Caps are enforced in the **shared domain layer**
  so web + Telegram inherit them: `schedulePost` (new `monthlyScheduledCount`),
  `buyer/scan.ts`, `automations/run.ts` + `saveAutomationFromWeb` (AUTO mode is
  Scale-only), `jobs/viral-benchmark.ts`. Also **closed the web paywall gap**: a
  new `lib/entitlements.requirePaid` gates the chat / buyer-scan / automations /
  schedule routes (402 upgrade_required, 429 cap_reached) — previously free/expired
  web users could spend real twitterapi.io + LLM budget. UI: `<UpgradeCTA>` on
  402/429, the AUTO option disabled for Growth, and used/cap shown on Scheduled +
  Buyer Radar (∞ for Scale). No migration (plan values already allowed). NOTE:
  "consistency on every post" (auto) advertised for Scale is a *separate* feature,
  not built here — manual `/check` stays on both paid tiers. See INTERNAL §3i.

- **2026-07-24 — Growth: a gamified board that fuses Diagnosis + Plan.** New sidebar
  page `/app/growth` (top of "Grow") that combines the two previously-unlinked
  strategist surfaces into one board built to actually pull a user back to post,
  using behavioural-economics levers grounded entirely in **real stored data (no fake
  XP)**: an **XP/level** ladder (Ghost→Landmark) and a **Brand Score /100** (Foundation
  · Consistency · Depth · Momentum) for goal-gradient pull; a **weekly posting streak**
  (with a grace week so it never scare-drops) for loss aversion; an ordered **quest**
  list (setup → habit → your actual plan-backlog ideas, each with XP + a deep-link CTA)
  for the Zeigarnik effect; **milestones** (followers / posts / streak / ideas) with
  auto-nearest thresholds; and a locked **identity** panel (headline, throughline,
  owned positions, "unsaid" territory) that unlocks once the diagnosis exists. Pure
  read model `web/growth.ts#getGrowthState` (one Promise.all over captures / unlock_items
  / automation_runs / scheduled_posts) → `components/growth.tsx`. No new tables/migration.
  See INTERNAL §3m.

- **2026-07-24 — Auto Agent free-form briefs, subtler trial pill, Scale plan, richer
  analytics.** Five UI/product changes across `packages/web` (+ small backend):
  (1) **Trial notice moved into the top nav bar** as a subtle `<TrialPill>` ("N days
  left · Add card"), replacing the full-width `<TrialBanner>` strip. (2) **Sidebar
  "Automations" → "Auto Agent"** with a bot icon. (3) **Free-form automation briefs
  (govork-style).** The New-agent modal is now brief-first and chat-styled: a big
  free-text box where you describe the agent in your own words (a new `custom` source
  whose brief IS the drafting seed), plus mode cards for the two presets (trend-ride /
  backlog) and example-prompt chips; a brief on a preset layers on as extra guidance.
  Backend: migration `0026` (widens `source_type` to `custom`, adds `automations.brief`),
  `sources/custom.ts`, brief moderated on save. (4) **Scale plan is now first-class.**
  Settings → Plan & billing shows a Growth-vs-Scale `<PlanPicker>` with an explicit path
  onto Scale; `DODO_PRODUCT_SCALE` (`pdt_0NjfwWTz5IVGf2I07R6Vd`) is a distinct product,
  `?plan=scale` maps to it, migration `0027` widens `subscriptions.plan` to allow
  `scale` (full paid entitlements for now). (5) **Analytics beyond X-premium**, tied to
  our own data: *Yoinky's impact* (posts shipped through Yoinky vs your baseline —
  engagement-rate lift + impressions earned, matched via `scheduled_posts.external_url`),
  a *Format lab* (which shape of post — question / link / short / long / thread — earns
  the most, vs your own median), *posting momentum* (last 8 weeks), and an *Auto Agent
  scorecard* (drafts written / shipped / awaiting / avg edits, from `automation_runs`).
  **Note for you:** set `DODO_PRODUCT_SCALE` on both deploys. See INTERNAL §3l / §3i / §4.

- **2026-07-23 — Clerk auth + a real 7-day free trial.** Identity for the web app
  is now **Clerk** (`@clerk/nextjs` v7). The custom Google/X/email sign-in routes and
  the `yoink_session` cookie are gone; `clerkMiddleware` (in `src/proxy.ts`) protects
  `/app`, `<ClerkProvider>` wraps the tree inside `<body>`, and Clerk's `<SignIn>` /
  `<SignUp>` / `<UserButton>` / `<SignOutButton>` replace the old login UI. Crucially,
  `getSessionUser()` keeps its signature — it just resolves the Clerk session to our
  `users` row via a new `clerk_user_id` (migration `0025`), so the ~30 callers are
  untouched. Configure Google/X as **social logins in the Clerk dashboard** (app
  `app_3GuEglSCyTcG11r4RQTo89Ve9O3`); the separate in-app **"Connect X"** posting flow
  (`/api/auth/x/*`) is unchanged and now connect-only. **Trial = Dodo
  subscription-with-trial (auto-charges at day 7), card collected inside the app.**
  Sign-up takes no card — the user lands straight in `/app` on a local
  `subscriptions.status='trialing'` + `trial_ends_at` row (migration `0025`, minted on
  first sign-in) with full access. Card capture happens later, from the trial banner or
  **Settings → Plan & billing** ("Add payment method"), which opens a Dodo checkout with
  `subscription_data.trial_period_days` = the **remaining** trial days (so adding a card
  on day 5 still charges on day 7, no free-period extension). Dodo then auto-charges when
  the trial ends and the subscription webhook (`POST /webhooks/dodo`) converts the row to
  paid. No card / abandoned checkout → the 7 days still run locally, then the wall
  (day count cleared to 0). The post-trial upgrade path calls checkout **without** a
  trial, so a lapsed user can't mint a second free one. **Self-serve from Settings:**
  "Manage account" opens Clerk's profile (email/password/social logins/sessions/delete);
  "Manage plan" opens the **Dodo customer portal** (`/api/billing/portal`) to
  change/upgrade/cancel + update the card. Enforcement requires `PAYWALL_ENABLED=true`.
  Landing plan CTAs deep-link to `/sign-up?plan=…` (growth/scale), recorded as the
  intended plan. **Note for you:** set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` +
  `CLERK_SECRET_KEY` (and `NEXT_PUBLIC_CLERK_SIGN_IN_URL`/`SIGN_UP_URL`) on Vercel,
  `DODO_API_KEY` + `DODO_PRODUCT_PAID` + `DODO_WEBHOOK_SECRET`, and
  `PAYWALL_ENABLED=true` on both deploys. Configure the Dodo paid product as a recurring
  subscription and enable the customer portal. See INTERNAL §3i / §4 / §5.

- **2026-07-23 — Automations (multi-automation "auto agent").** The single global
  autopilot is replaced by named, independent automations, each with its own source
  (rides trends in your niche, or posts from your backlog), cadence, and delivery
  mode. **Approval mode** DMs you a drafted post over Telegram with approve / edit /
  reject (edit is a real revise-by-instruction loop); a web **Approvals inbox**
  mirrors it. **Auto mode** (ships DARK behind `AUTOMATIONS_AUTO_ENABLED`) schedules
  a cancellable post instead of firing instantly, with a warm-up ramp that routes the
  first few through approval. Doctrine holds: deterministic selectors decide
  whether/which (the `trend_ride` selector is the exact niche→buzz→rank gate the
  proactive nudge uses), the model only drafts. Caps everywhere (per-automation
  monthly + global daily), atomic run claims, moderation on every seed. New Cowork-style
  `/app/automations` surface. Backend `automations/*`, migration `0024`. See INTERNAL §3l.

- **2026-07-22 — Content moderation, crisper voice, calendar scheduling, seeded Inspiration.**
  (1) **Moderation gate** (`moderation/filter.ts`): a deterministic lexicon (explicit/abusive,
  word-boundary matched, no LLM) rejects pornographic or abusive user text with one consistent
  "against platform guidelines" pushback, wired into every user-text choke point, `converseWithUser`
  (Telegram + web chat + voice), draft topics, Buyer Radar ICP, profile form, and scheduled posts.
  (2) **Crisper Yoinky voice**: the shared voice constants (`CASUAL_VOICE`, `CHAT_STYLE_RULES`) now
  enforce short, skimmable messages, which propagates to all proactive + journey chatter.
  (3) **Scheduled = calendar**: `/app/scheduled` defaults to a month calendar (posts as day chips,
  empty days nudge "add a post"); a new `/api/schedule` route + `createWebScheduledPost` lets you
  write and queue a post for a chosen day from the web (previously scheduling was Telegram/agent only).
  (4) **Seeded Inspiration**: after diagnosis (once the niche is known) a one-off `inspiration.seed`
  job pre-populates the Trends & Virals tabs via the existing matchers run in seed mode (channel
  `web`, no Telegram delivery), so a freshly-connected user sees real, on-niche examples instead of
  an empty screen.

- **2026-07-22 — Buyer Radar shipped (real backend, web delivery).** Finds people
  on X expressing purchase intent for what the user sells, scores it
  deterministically, gates it semantically against their domain, and drafts an
  approval-only reply in their voice, ideally anchored to their own prior take
  (`search_memory`, the moat). It **never auto-sends**, and code, not the model,
  decides who is a buyer. New: a distinct ICP profile (`icp_profiles`), a pure
  intent scorer with a follower reachability band and a crowding penalty (the
  inverse of buzz), a pgvector niche gate, and a bounded composition agent
  (`buyer/*`, `buyer-queries.v1` + `buyer-outreach.v1`, migration `0022`).
  Delivery is the web `/app/buyers-radar` page (ICP intake, "Scan now", per-signal
  reply with copy/open/skip/not-a-fit); every scan is budget-gated before any paid
  twitterapi.io call. The proactive recurring path (`jobs/buyer-radar.ts`) ships
  DARK (`BUYER_RADAR_PROACTIVE=false`) — pull-only at launch. See INTERNAL §3j.

- **2026-07-21 — Web auth = Google or X; mandatory Connect-X; Agent split into
  Compose + Automation; X 404 fixed.** (1) **Login** now offers exactly two
  options: Continue with Google or Continue with X. X sign-in is a full web-side
  OAuth flow (`/api/auth/x/*`, PKCE, keyed by a new `users.x_user_id`, migration
  `0021`) that both authenticates and connects X. Email magic-link is retired
  from the login UI. (2) **Mandatory Connect-X gate**: the app layout shows a
  non-dismissible popup until X is connected; right after connecting it shows a
  "reading your account" animation (polls `/api/connect-status`) while the
  history ingest runs. (3) **X OAuth 404 fixed**: X migrated off `twitter.com`,
  so the authorize/token/API hosts moved to `x.com`/`api.x.com` (was 404ing on
  the old consent URL). (4) **Agent is a section, not a page**: sidebar group
  "Agent" → **Compose** (as before) + **Automation** (new full page for the
  autopilot: find topics, draft, schedule on your behalf). `/app` redirects to
  `/app/compose`; the standalone chat page is gone. (5) Settings trimmed: the
  onboarding-status pill and the "Your info" question editor are removed (the
  agent now draws those out conversationally, confirming from your X where it's
  clear, per an updated `converse.v3`); the Telegram button reads **Go to
  Telegram**. (6) **Every em dash purged** from the web app. **Note for you:**
  the web X OAuth needs its callback registered in the X Developer Portal:
  `https://app.meetyoinky.com/api/auth/x/callback` (+ `http://localhost:3002/...`
  for dev), and the consent-screen name comes from that same X app (rename it to
  Yoinky there). Set `WEB_APP_URL` on Vercel + Railway too.
- **2026-07-20 — Telegram is now auth- and subscription-gated; no onboarding
  there.** Big behavioral shift: the bot no longer runs the profile intake or
  auto-creates a user row for anyone who DMs it. Onboarding happens only on the
  web now. New Telegram flow: (1) **auth-gate** — a Telegram chat must be linked
  to a web account (sign in on the web with Google/email → Settings → Connect
  Telegram, which deep-links `/start <token>`). An unlinked visitor gets a short
  "sign in on the web first" message and nothing else — no stray account is
  created. (2) **subscription-gate** — `upgradeWall` now fires on
  `!isPaidOrExempt` for *every* gated command/message (not just the old
  post-diagnosis parking spot); it's a no-op while `PAYWALL_ENABLED=false`
  (testing) and a real gate once the paywall is on. (3) After auth, the bot
  sends **one short capabilities message** (what Telegram is for: drop
  thoughts, draft, proactive nudges) — deeper setup is pointed at the web app.
  The profiling kickoff was removed from `/start` and `handleTextTurn`; the
  wipe-everything flow no longer restarts a Telegram intake. Also fixed a
  latent bug: linking could hit the `UNIQUE(telegram_id)` constraint if a stray
  row already held that id — `consumeTelegramLinkToken` now detaches it first.
  Also: the web "Finish setup" button/banner were removed (onboarding is now the
  gamified popup at `/app/onboarding`, no persistent nag). **Note for you:** the
  X OAuth *consent screen* app name ("...wants to connect") comes from the X
  Developer Portal app registered under `X_CLIENT_ID` — rename that app to
  "Yoinky" there; it isn't set in code.
- **2026-07-20 — Settings: Connect X is now OAuth, not a typed handle.** The
  Settings "Connect X" button links to the backend's existing
  `/oauth/x/start?u=<userId>&redirect=<returnPath>` route — the same PKCE flow
  the Telegram bot's own connect button uses — instead of asking for a typed
  `@handle`. For X, OAuth is strictly better: after verifying identity via
  `GET /2/users/me`, `afterOAuthConnected` automatically kicks the same
  history-read job the typed-handle path used, so one authorize click now does
  what used to take a click + typing a handle. New `WEB_APP_URL` config (an
  allowlisted return origin) lets the OAuth callback redirect the browser back
  to `/app/settings?connected=x` instead of the bot-flavored static page — only
  ever honored when it matches `WEB_APP_URL` exactly (open-redirect guard).
  **Caught a real architectural bug before shipping:** my first pass had the
  web app call `buildAuthUrl` in-process (skipping the `/start` redirect hop
  "for efficiency") — but the PKCE `pending` state in `routes/oauth.ts` is an
  in-memory `Map`, and `/start` (which writes it) and `/callback` (which reads
  it) must run in the *same OS process* for that state to be visible. Since the
  web (Vercel) and backend (Railway) are separate deployments in production,
  that would've populated a `pending` entry only the web process could see,
  and every connect attempt would silently 404/expire on the backend's
  `/callback`. Fixed by making the button a real HTTP link to the backend's own
  `/oauth/x/start` (mirroring the bot's own `authUrl` helper exactly) so both
  legs run on the backend. The typed-handle path (`/api/connect`, `runWebConnect`)
  was dead-code-removed once OAuth replaced it in the UI.
- **2026-07-20 — Web app restructure: Agent absorbs Chat, gamified onboarding
  popup, Inspiration + Buyers Radar, editable profile, X-only.** A batch of UI
  changes: (1) **LinkedIn removed from the web app** (Compose, Connect) — the
  Telegram bot's LinkedIn support is untouched, this is web-only for now.
  (2) **Dark/light toggle moved to Settings** (was in the sidebar); Settings also
  gained a **Connect Telegram** button (deep-links via the existing
  `createTelegramLinkToken` + bot `/start` flow — new `/api/telegram/link`).
  (3) **Chat merged into Agent** — `/app` (the old standalone chat page) now
  redirects to `/app/agent`, which is chat plus an agent-mode status bar and a
  queue/best-posts modal. (4) **Inspiration** (`/app/inspiration`) — Trends and
  Virals tabs reading the `surfacings` ledger the proactive jobs already
  populate (new `listTrendInspiration`/`listViralInspiration`). (5) **Buyers
  Radar** (`/app/buyers-radar`) — UI-only preview (blurred mock results, no
  backend) for a planned "find people publicly asking for your service on X"
  feature. (6) **Settings: editable stated profile** — niche, goal, audience,
  tone, inspirations, content pillars, camera comfort, via a new
  `submitProfileForm`/`/api/profile`. (7) **Onboarding is now a 3-screen
  gamified popup wizard** (dropdowns for goal/tone/camera comfort, a
  segment-per-field progress bar, skip-this-section / skip-onboarding) instead
  of a conversational chat flow — writes `brand_profiles` fields directly
  (`web/onboarding-form.ts`), no LLM round trip. The old conversational web
  onboarding path (`initWebOnboarding`, `runWebOnboardingTurn`, `/api/onboarding`)
  was dead-code-removed; Telegram's onboarding is unaffected.
  **Two real bugs surfaced and fixed while building this:** `strategist/profile.ts`'s
  `normalize()` wrote a literal `""` instead of SQL `NULL` for skipped scalar
  fields, which violates the CHECK constraints on `primary_goal`/`camera_comfort`
  (etc.) — this silently no-op'd on the Telegram skip path (swallowed by a
  `.catch(() => {})`) but 500'd loudly here; fixed at the source (`scalar || null`),
  which fixes both paths. And the completion check only counted fields with a
  truthy value, so a legitimately-*skipped* field (real value `NULL`) could
  never count as "done" — `profileCompletionFields` now also honors the
  `unresolved[]` ledger, matching the Telegram intake's own definition of captured.
- **2026-07-17 — Agent mode, X analytics, 100-tweet cap, tighter messages.**
  Four changes: (1) **Web agent mode** (`/app/agent`) — an opt-in auto loop that
  once a day picks a topic from your unlock backlog, drafts it in your voice, and
  *schedules* it (cancellable in the queue before it fires); a daily
  `agentTick` cron runs a cycle for each opted-in user, plus a "Run one cycle
  now" button. (2) **Web analytics** (`/app/analytics`) — loads instantly from
  stored post metrics: impressions/likes/replies/RT/quotes/**bookmarks**, median
  engagement rate, an **engagement-weighted best-time heatmap**, top posts, and
  **on-demand reply-level performance** (impressions + engagement rate on your
  own replies — the native-analytics blind spot). It's honest about what X
  simply doesn't expose (profile clicks, per-post follower attribution,
  revenue/RPM are listed as unavailable, never faked). (3) **100-tweet scrape
  cap** — every pull of a user's own tweets is hard-clamped to 100
  (`MAX_OWN_TWEETS`). (4) **Shorter Telegram breakdowns** — tightened the shared
  `CASUAL_VOICE` brevity rule plus the progress-report, trend-take, and
  viral-case-study prompts so no message is a wall of text.
- **2026-07-17 — Web app is Vercel-deployable (app.meetyoinky.com).** The web
  ships as its own Vercel deploy over the same Neon DB as the Railway backend
  (Vercel = UI + API + job-enqueue; Railway keeps the bot + pg-boss workers +
  cron). Setup is pinned in `packages/web/vercel.json` (Root Directory
  `packages/web`, `buildCommand: pnpm build`, which compiles the backend `dist`
  first) — full runbook + env/DNS/Google-redirect steps in `DEPLOY.md`. Also
  fixed a latent bug: the web process never called `startBoss()`, so any enqueue
  (connect, schedule) threw "pg-boss not started" — added `ensureBoss()`
  (send-only, lazy) and call it from the web wrappers.
- **2026-07-17 — Render decommissioned.** It was kept suspended (not deleted)
  as an instant DNS-flip rollback after the 2026-07-12 move to Railway; Railway
  has now proven stable, so the standby was torn down and the Render-only
  keep-alive workflow (`.github/workflows/keepalive.yml`) was deleted along
  with it. See `DEPLOY.md`.
- **2026-07-17 — Web app: Google sign-in + Compose + Connect.** Google OAuth is
  live alongside email magic-link (both resolve to one user row). Two more
  screens extend the loop into the web: **Compose** (`/app/compose`) writes a
  post in your voice via the same `runDraft` path (paywall/allowance + voice-
  profile gates respected), and **Connect** (in Settings) starts an X/LinkedIn
  read via the typed-handle path — the ingest+diagnose job is processed by the
  backend worker, so run `pnpm dev` alongside `pnpm dev:web`. All wrappers reuse
  the bot logic through a collecting Channel (`src/web/channel.ts`).
- **2026-07-17 — SaaS web app (foundation + core slice).** Yoinky is going
  web-first: a new `packages/web` Next.js app (16, React 19) is the main
  workspace, with Telegram retained as the add-on for proactive reach-outs. It
  reuses the backend **in-process** — `packages/web` imports domain functions
  from `@yoink/backend/web` (a new barrel export) and shares the same Postgres,
  so there's no second API tier to keep in sync. Auth is **Google OAuth**
  (primary) **and email magic-link** — both resolve to `findOrCreateUserByEmail`
  + a session cookie (reuses the existing `sessions` table; new `login_tokens` in
  migration `0020`; dev logs/returns the magic link when no mailer is set). The
  web reads the backend's env via a `packages/web/.env.local` → `../backend/.env`
  symlink, and runs on **:3002** (backend stays :3001).
  The design is ported from the WeaveOS reference (Geist, warm off-white canvas,
  hairline strokes, 20px radii) with the one requested change — the glossy black
  primary action recolored to a single **pink** accent token (`--accent`) — plus
  a dark theme the original lacked. Shipped screens: chat workspace, onboarding
  intake (with the same skip-step / skip-onboarding buttons as the bot),
  diagnosis, plan/roadmap, beliefs, and settings. Deferred to follow-ups: the
  in-web OAuth connect UI, and dedicated screens for drafting, repurpose,
  mentions, scheduling, trends, viral case study, and peers (all reachable today
  via chat). Note: the backend now builds to `dist` (the web imports compiled
  output; types still resolve from source) — `packages/web` runs
  `pnpm --filter @yoink/backend build` on `predev`/`prebuild`.
- **2026-07-17 — Onboarding is shorter and skippable.** Two changes to the
  intake so it never feels like a wall of text or a forced questionnaire. (1)
  The paced diagnosis and gap-analysis reveals are tighter: 3–4 short messages
  instead of 5–8, a 350-char (was 500) per-message cap, max 3 bullets (was 4),
  and lower LLM token budgets — the reveals land faster without losing the
  evidence. (2) Every intake question now carries a two-button escape hatch:
  **skip this step** (advances past just that question, reusing the same
  deterministic skip path as typing "skip") and **skip onboarding** (marks the
  remaining questions unresolved, finalizes the thinner profile, and jumps
  straight to the connect hand-off — the diagnosis still runs off whatever was
  stated). Buttons show under the `/start` opener, every resumed question, and
  each intake turn; they drop away once you're past the questionnaire. Handled
  by `obskip:step` / `obskip:all` callbacks and `skipAllIntake()`.
- **2026-07-13 — Daily viral case study.** Once a day, Yoinky shows you one
  tweet in your niche that just blew up (100k–10M views) and breaks down *why* it
  worked — from real numbers, not folklore: its breakout ratio (views ÷ the
  author's followers, i.e. how far it escaped their normal reach), engagement and
  bookmark rates, velocity, and format — plus one angle you could take on it in
  your own voice. It's a learn-from-the-best spotlight, distinct from trend
  alerts (what everyone's discussing right now) and peer benchmarking (how you
  compare to specific peers). Selection is fully deterministic — an impression
  band, a recency window, a niche-relevance gate against your positions, and
  dedup (never the same tweet or a repeat-offender author) pick the tweet; the
  model only explains and suggests. 👍/👎 on each one tunes relevance over time.
- **2026-07-13 — GLM's flaky JSON no longer kills jobs.** Every structured LLM
  call routes through one gateway, and GLM 5.2 was intermittently failing them
  ("no JSON found") — silently breaking resurfacing, mention replies, trend
  clustering, and trend composition. Root causes found and fixed, not just
  retried: (1) GLM is a hybrid reasoning model and some OpenRouter providers
  return the whole answer in the `reasoning` field with empty `content` — the
  gateway now reads it; (2) tight token budgets cut JSON off mid-structure —
  truncation is now detected (`finish_reason`) and re-run once with a doubled
  budget; (3) the old "corrective retry" re-asked the question cold and just
  re-rolled the same dice — it now hands the model its *own previous answer*
  and asks it to reformat, which converges; (4) a last-resort salvage closes
  truncated JSON so a cut-off list degrades to its complete items instead of a
  dead job; (5) the extractor now also survives prose *after* the JSON and
  trailing commas. Verified live: the trend-clustering call that failed 2 of 3
  attempts yesterday ran 5/5 clean.
- **2026-07-12 — Trend detection now finds same-day clusters, not stale single
  tweets.** Two problems made trend alerts miss: they were built around one hot
  tweet (whose exact text was then searched for volume — finding only that one
  tweet, so nothing ever cleared the bar), and they weren't time-bounded (a
  5-day-old tweet could resurface). Rebuilt around what a trend actually is:
  pull the last 24h of tweets in your space, cluster them into the topics
  **multiple people are posting about right now**, verify each is genuinely
  high-volume on X, and hand you the specific driving post to engage with —
  gated to the last 36h so it's always current. Proven live: the old approach
  scored a topic at buzz 0.15 (0 authors); the new one scores "Claude Code" at
  0.86 with ~58 authors. Also fixed a twitterapi quirk (its "Top" query returns
  nothing on time-windowed searches) that was zeroing both the volume signal and
  the source-tweet pool.
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
                   DodoPayments billing, the grammY Telegram bot, pg-boss jobs.
                   Exposes domain functions to the web app via `@yoink/backend/web` (src/web.ts).
packages/web       Next.js SaaS web app (web-first workspace). Email magic-link auth, chat,
                   onboarding, diagnosis/plan/beliefs/settings. Imports @yoink/backend in-process,
                   shares the same Postgres. Runs on :3002 (`pnpm dev:web`); backend stays on :3001.
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
