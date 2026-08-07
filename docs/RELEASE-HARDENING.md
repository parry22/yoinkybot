# Production readiness hardening — live checklist

Companion to the hardening pass on top of `1af96fb`. **Do not treat this as auto-deployed.** Apply env + migrations deliberately, backend first.

## What landed in code (merge-ready)

### 1. Auth / billing / governance
- `requirePaid` on company mutators (knowledge, narrative, briefs/Studio, editorial, distribution, workspaces, workspace-settings, LinkedIn connect, ICP/verdict, automation toggle)
- Growth/Scale numeric caps for workspaces/members/experts/assets/minutes; `CapReachedError` → HTTP 402
- Studio requires **editor**; removed auto-approval of knowledge/claims/briefs/assets
- Hosted production **throws** if `SELF_HOSTED=false` and `PAYWALL_ENABLED=false` (self-hosted unchanged)

### 2. Credentials / OAuth / entry points
- Purpose-bound AES-GCM for OAuth tokens (`sealForPurpose` / `OAUTH_TOKEN_ENCRYPTION_KEY` → falls back to `BYOK_ENCRYPTION_KEY`)
- Hosted production **throws at boot** without a valid encryption key (`assertHostedOAuthEncryption`); `tokenWriteParams` refuses plaintext writes as defense-in-depth
- Existing plaintext OAuth tokens are **not** auto-migrated — users must reconnect after enabling encryption
- Migrations `0054` (encrypted columns + dual-read), `0055` (Telegram link token hashes), `0057` (Postgres OAuth state + connect tickets), `0058` (`web_x` platform for X web OAuth)
- LinkedIn web OAuth start requires Clerk session; CSRF state is single-consume in Postgres (`web_linkedin`)
- X web OAuth uses the same Postgres state pattern (`web_x`)
- Timing-safe `CRON_SECRET` compare
- CSP + security headers in `next.config.ts`
- Rate limits on conversion webhook (fail-closed) and distribution recommend

### 3. Media / data boundaries
- Prefer private Vercel Blob; host allowlist in `allowedMediaFetchUrl` / `fetchMediaBytes`; owned-row DELETE + rate limit
- Migration `0056`: conversion dedupe uniqueness + personal-capture / company-performance isolation
- RLS explicitly deferred (documented)

### 4. Backend correctness
- Telegram capture: `telegram_workspace_id` → `active_workspace_id` → personal
- Transcription claim idempotency
- Inspiration refresh enqueues pg-boss (`inspiration.seed`)
- `/health` → 503 on DB failure or stale queue/workers; reports `workers.depth`, `oldestAgeSec`, `heartbeatAt`; `stopBoss()` on SIGTERM
- Personal + company voice notes with `workspace_id` → `extractTranscriptToKnowledge`; personal also keeps legacy `capture.extract` until parity proven
- Telegram approval callbacks encode workspace id (`cw:ka:{workspaceId}:{itemId}`)
- CTA publication check aligned with `content_assets` join
- Deleting the last company workspace cleans the orphan organization

### 5. Product wiring
- Nav: primary rail + secondary **More** section (Narrative, Briefs, Distribution, Analytics, Compose, Scheduled, Automations, Inspiration, Growth, Buyers Radar)
- Demo Inbox/Knowledge content gated off in production (including brain demo nodes when empty)
- Company `/app` home renders `getWorkspaceHome` next-action dashboard; personal keeps Inbox
- `public/conversion-tracker.js` snippet
- Assets calendar hydrates pending `scheduledFor` from `scheduled_posts`
- Typed `jsonError` helper on company API routes (402/403/400/500)

### 6. Release gate
- ESLint CLI + flat config (Next 16)
- `.github/workflows/ci.yml` (no deploy) — **fails** on `pnpm audit --prod --audit-level=high` (artifact still uploaded)
- Multi-stage Dockerfile → `node dist/index.js` + HEALTHCHECK
- Root `verify` includes lint
- Unit tests: queue/worker health, Telegram callback parsing, transcription claim states, Studio editor gate, media SSRF, OAuth encryption fail-fast

### 7. Expired-account policy
- Hosted paywall gates **mutations** (API routes using `requirePaid` return 402)
- Expired/free users retain **read-only** access to company knowledge, analytics, and similar views until a stricter policy is chosen

## Local verification

```bash
pnpm -r typecheck
pnpm --filter @yoink/backend test
pnpm --filter @yoink/web lint
pnpm verify
# optional DB:
RUN_DB_INTEGRATION=1 pnpm --filter @yoink/backend test
```

## Live checklist (manual — do not auto-deploy from this task)

### Railway (backend) — deploy first
1. Set `PAYWALL_ENABLED=true` on hosted; confirm `SELF_HOSTED=false`
2. Set `BYOK_ENCRYPTION_KEY` (and optional `OAUTH_TOKEN_ENCRYPTION_KEY`) — boot fails without a valid key on hosted prod
3. Set `CRON_SECRET` (same value on Vercel for media-cleanup)
4. Set `BLOB_READ_WRITE_TOKEN` if using private Blob fetches
5. Set Dodo billing env parity with Vercel (`DODO_*` product/price IDs, webhook secret)
6. Deploy backend; confirm migrations `0054`–`0058` applied in logs
7. `curl -i https://bot.meetyoinky.com/health` → 200 + `ok:true` + `workers.ok:true` (503 if DB down or queue stale)

### Vercel (web) — deploy second
1. Mirror encryption / Clerk / DB env; `PAYWALL_ENABLED=true`
2. `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`
3. Confirm CSP does not block Clerk in browser console
4. Smoke: sign-in, Knowledge extract (402 when unpaid), Studio editor gate, LinkedIn + X connect start requires session, company home shows next action

### Provider / ops
1. Re-consent / rotate OAuth if dual-read encryption starts clearing plaintext after writers run; reconnect any legacy plaintext tokens after enabling encryption
2. Confirm Postgres backup — set `DATABASE_BACKUP_URL` secret for `.github/workflows/backup.yml` or use provider PITR
3. Conversion snippet: `<script src="/conversion-tracker.js" data-token="…" data-endpoint="https://app.meetyoinky.com/api/conversions/webhook"></script>`
4. Watch queue via health/logs after inspiration refresh (job should enqueue, not block request)
5. Pre-launch DB integration: `RUN_DB_INTEGRATION=1 pnpm --filter @yoink/backend test` against staging Postgres
6. Docker build smoke: `docker build -t yoink-backend .` then run with env + health check

## Explicitly deferred follow-ups
- Full Postgres RLS rewrite
