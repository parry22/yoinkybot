# Yoinky - Build Phases

Build order mirrors the PRD (§6). Each phase leaves the repo compiling, unit-tested, and runnable.
One deviation from PRD v1.0: **DodoPayments replaces Razorpay + Stripe** as the single payment
provider (merchant of record, covers India + international in one integration).

## Phase 1 — Capture + memory core (headless)
- Fastify monolith, Postgres + pgvector, pg-boss job queue.
- Telegram bot (grammY, webhook): voice → Sarvam STT (Whisper fallback), text capture, /forget, /search.
- Browser-extension capture endpoint (token-authed, text + URL + title only).
- X archive (`tweets.js`) and LinkedIn export (`Shares.csv`) import on signup.
- Extraction pipeline: capture → cheap LLM splits into memories, classifies kind, extracts positions.
- Embedding + auto-linking (pgvector neighbors → LLM link classification: extends/contradicts/echoes/answers).
- Hybrid vector + full-text search with LLM-synthesized, memory-cited answers.
- Forget = hard delete of memory + links (and positions sourced solely from it).
- Gate: retrieval is coherent, not just functional.

## Phase 2 — Proactive engine (Telegram-only)
- Deterministic candidate scoring: novelty × link-density × recency ÷ prior surface count. No LLM in selection.
- Frontier-LLM composition with explicit "why this, now" reasoning.
- Delivery via Telegram with 🔥/💤/🗑 inline reactions → `surfacings` table → feeds future scoring.
- Quiet hours + per-week cadence from user settings; free-tier frequency cap.
- Gate: resurfacing feels surprising and useful.

## Phase 3 — Web dashboard
- Next.js app: memory map (k-means clusters + cheap-LLM labels), search, surfacing history
  (editable reactions), settings, extension token management, Telegram linking.
- Gate: users explore the map unprompted.

## Phase 4 — Voice + consistency + drafting
- Voice profile: built from memories + imports; declines below ~50 memories; versioned; viewable traits.
- Pre-publish consistency check: draft → embed → match `positions` → frontier LLM meaning-level comparison
  → exact prior statement + date + source → resolve as "intentional evolution" or "catch it".
- Memory-grounded drafting: retrieval is mandatory; every draft cites its source memories.
- Gate: a catch or draft gets genuinely used.

## Phase 5 — Macro-moment matching (paid)
- Daily job: interest fingerprint from recent memory themes → live discourse search → high-threshold
  semantic gate against positions. Fires rarely; weak matches never fire.
- Distinct delivery treatment from regular resurfacing.

## Phase 6 - Billing (DodoPayments)
- Public plans: Open Source (free, self-hosted BYOK), Growth, and Scale.
- Hosted checkout exists only for Growth and Scale. The older Founding label is retained for existing cohort compatibility.
- Dodo checkout sessions + Standard-Webhooks-verified webhook → `subscriptions` table → entitlements.
- Per-user usage metering (tokens, model, cost) via the LLM gateway from day one.

## Phase 7 - Company Narrative Engine
- Additive organizations, personal/company workspaces, members, role checks and distinct expert voices.
- Permissioned transcript sources produce reviewable, source-linked knowledge objects. Claims never auto-approve.
- Versioned narrative systems, audiences, editorial territories and claim registry.
- Grounded briefs produce checked assets and channel-native derivatives with capture-to-publication lineage.
- Distribution steps are deterministic tasks. Existing X and LinkedIn publishers remain the only native execution paths.
- Tracked CTA events validate opaque action tokens, entity ownership, timestamps and deduplication keys.
- Manual lead, opportunity and revenue records are labelled influenced, never causally attributed.
- Workspace analytics expose production health, knowledge activation, territory performance, source utilisation and stored editorial reviews.
- Database: additive migrations `0043` through `0053` (studio asset formats), including same-workspace foreign keys, audit logs, encrypted tracked-action tokens and performance snapshots.
- Web shell (2026-08-07): knowledge-first light UI — Inbox triage, Knowledge brain stage + library, Studio generation, Assets calendar, Integrations hub, workspace Settings. DM Sans typography, warm tinted surfaces, custom `MenuSelect` controls, mobile drawer at ≤1000px.
- Security gate: real Postgres tests prove cross-workspace reads and writes fail, viewers cannot edit, contributors cannot approve high-risk claims, confidential/never-use material stays out of generation, and Telegram respects delivery permissions.
- Lineage gate: a founder transcript completes capture -> knowledge -> brief -> asset -> publication -> conversion with every relationship traceable to one workspace.
- Compatibility gate: personal drafts, X and LinkedIn scheduling, Auto Agent interviews, Telegram capture, creator analytics and Growth/Scale billing retain their characterized contracts.
- Product gate: existing creator flows still work; the founder-transcript slice completes through narrative, assets, distribution, conversion and editorial learning.
