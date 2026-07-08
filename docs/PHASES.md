# Yoink — Build Phases

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

## Phase 6 — Billing (DodoPayments)
- Tiers: free (capture + capped resurfacing) / paid (everything) / founding (paid price locked, first 500).
- Dodo checkout sessions + Standard-Webhooks-verified webhook → `subscriptions` table → entitlements.
- Per-user usage metering (tokens, model, cost) via the LLM gateway from day one.

## Phase 7 — Agency/team (not built)
- Prepped only: `profile_id` (memory owner) vs `user_id` (access) separation noted in schema comments.
