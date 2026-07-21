# Deploying Yoinky (Railway backend + Vercel web + Neon)

**Current production:**

| | |
|---|---|
| Backend compute | Railway, project `yoinky`, service `backend`, **Hobby plan** — runs the Fastify server, the Telegram bot, and **all pg-boss job workers + cron**. This is the always-on piece. |
| Web compute | **Vercel** — `packages/web` (Next.js) at `app.meetyoinky.com`. Serverless: UI + API routes only. It calls backend domain functions in-process and enqueues jobs, but does **not** run workers/cron/bot — those stay on Railway. See "Web app (Vercel)" below. |
| Database | **Neon** (`ep-cool-poetry-....us-east-1.aws.neon.tech`) — managed Postgres with pgvector. **Shared by both** Railway and Vercel; point Vercel's `DATABASE_URL` at this same instance. |
| Domains | `bot.meetyoinky.com` → Railway (webhook + health); `app.meetyoinky.com` → Vercel (web app) |
| Prior host | Render (`yoinkybot`) — **decommissioned 2026-07-17** |

The backend and web are two deploys over one database. Jobs enqueued from the
web (e.g. connecting an account) are processed by Railway's workers; results land
in Postgres (which the web reads) and go out as Telegram DMs.

## 1. Create the project + service

```bash
railway login
railway init --name yoinky            # creates + links the project
railway add --service backend --repo <you>/<repo> --branch main
```

`railway add --repo` connects the service to GitHub for auto-deploy on push —
**this requires Railway's GitHub App to have access to the repo** (grant it at
github.com/apps, or via Railway's dashboard the first time; the CLI can create
the service without this, but won't be able to build from `main` until access
is granted). Without GitHub access, deploy manually instead:

```bash
railway up --service backend          # builds + uploads the local Dockerfile build
```

Railway auto-detects the repo's `Dockerfile` either way — no build config needed.

## 2. Database: use the existing Neon instance — do NOT create a new one

Earlier drafts of this doc had you provision a self-hosted `pgvector/pgvector`
Postgres service inside the Railway project. **That was never actually done.**
Production has used **Neon** (external, managed, pgvector-enabled) since before
this Railway move, and the safest migration path — the one actually taken — is
to change compute only and leave the database exactly where it is:

- `DATABASE_URL` is just copied over as-is from wherever it's currently set (see
  step 3). It already points at Neon and already has the `vector` extension.
- Do **not** add a Railway Postgres/`db` service unless you deliberately decide
  to migrate off Neon later — that's a real data migration (`pg_dump`/restore),
  not a config change, and has its own separate risk profile.

## 3. Configure the backend service — copy the full env, don't retype it

The fastest, least error-prone way to populate ~25 env vars on a fresh service
is to copy them from wherever they're currently live (your local `.env`),
value-for-value, rather than retyping from memory:

```bash
# One var at a time, piped through stdin so the value never lands in shell
# history or a command line:
echo -n "$VALUE" | railway variables set KEY --stdin --skip-deploys --service backend
```

Full required set (values are secrets — pull from wherever they're currently
live, never hardcode them here or commit them):

```
NODE_ENV=production
PORT=3001
PUBLIC_URL=https://bot.meetyoinky.com
CHECKOUT_RETURN_URL=https://t.me/<your_bot>
# The web app's own origin — an allowlisted return target for the OAuth
# connect flow's `redirect` param (routes/oauth.ts), so Settings' "Connect X"
# bounces back to app.meetyoinky.com instead of the bot-flavored static page.
# Backend config, NOT set on Vercel. Omitting it just falls back harmlessly.
WEB_APP_URL=https://app.meetyoinky.com

DATABASE_URL=<the existing Neon connection string — copy verbatim, don't touch>

TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_WEBHOOK_SECRET=<random string>
ADMIN_TELEGRAM_ID=<your Telegram numeric id>

GROQ_API_KEY=<console.groq.com>
GROQ_STT_MODEL=whisper-large-v3-turbo

OPENROUTER_API_KEY=<openrouter.ai>            # REQUIRED — the only LLM route

QWEN_API_KEY=<DashScope>                      # embeddings
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIMS=1536

TREND_PROVIDER=apify
APIFY_TOKEN=<apify.com>
TWITTERAPI_IO_KEY=<twitterapi.io — keep credits topped up, see note below>

X_CLIENT_ID / X_CLIENT_SECRET               # OAuth-first connect + posting (§3f/§3e)
LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET

POSTHOG_API_KEY=<phc_… project key>          # optional — unset = analytics no-op
POSTHOG_HOST=https://us.i.posthog.com        # or eu.i.posthog.com

DODO_ENV=test_mode                            # or live_mode
DODO_API_KEY / DODO_WEBHOOK_SECRET / DODO_PRODUCT_PAID / DODO_PRODUCT_FOUNDING
```

**`TWITTERAPI_IO_KEY` note:** this is a prepaid-credit API — advanced_search
calls fail closed with a `402 Credits is not enough` once the balance hits
zero (this happened in production; the buzz-verification gate degrades to the
angle-offer flow when it does, it doesn't crash anything, but trend take
quality drops). Check balance any time with:
```bash
curl -H "X-API-Key: $TWITTERAPI_IO_KEY" https://api.twitterapi.io/oapi/my/info
```

## 4. Point your domain at it (Namecheap)

```bash
railway domain bot.meetyoinky.com --service backend --port 3001
```

This prints **two** DNS records — both are required (unlike a plain CNAME-only
setup, Railway also verifies domain ownership via a TXT record before it
issues the HTTPS cert):

```
CNAME   bot                    <something>.up.railway.app
TXT     _railway-verify.bot    railway-verify=<token>
```

In Namecheap: **Domain List → meetyoinky.com → Manage → Advanced DNS**, add/update
both records exactly as printed, TTL Automatic. In practice this has propagated
in well under 72 hours (minutes, on Namecheap with Automatic TTL) — Railway's UI
shows `Verified: yes` and `Certificate status: VALID` once it's done. Check with:

```bash
railway domain status <domain-id>     # from the `railway domain` output above
curl https://bot.meetyoinky.com/health
```

**This DNS change is the actual cutover** — the moment it propagates, live
Telegram traffic moves to whatever `bot` currently points at. It's a single
CNAME value, so it's instantly reversible by pointing it back.

## 5. Deploy

`railway up` (or a GitHub push, once the App has repo access) builds and
deploys. Watch `railway logs --service backend`: migrations apply (a no-op if
the DB already has them, which it will if you kept the existing Neon instance),
then `yoinky backend on :3001`, then `telegram webhook set`.

## Before every deploy

```bash
pnpm verify   # typecheck + full unit suite — the gate
```

## Troubleshooting: the bot replies but sounds like a robot

Same diagnosis regardless of host — the LLM route is down, almost always a
missing `OPENROUTER_API_KEY`:

```bash
curl https://bot.meetyoinky.com/health
# {"ok":true,"llm":true,"analytics":true,"trends":{...}}   → all wired
# {"ok":true,"llm":false,...}                               → set OPENROUTER_API_KEY, redeploy
```

`trends.provider` / `trends.buzz_gate` / `trends.last_fetch` report whether the
trend pipeline's keys are present and when it last actually fetched — useful
after any deploy or host move to confirm the background jobs are alive, not
just the HTTP server.

## Why not Render / why Hobby, not the free trial

Production ran on Render's free plan first. Render free (and every other
request-triggered "free tier" PaaS, broadly) spins the process down after ~15
minutes idle — fine for a stateless API, fatal here because `pg-boss`'s cron
scheduler runs *inside* this same process: a spin-down means missed cron
windows are gone forever, not delayed (`jobs/workers.ts#nudgeStaleTrendJobs`
papers over this with a boot-time catch-up, but the cleanest fix is not
spinning down at all).

Railway's free **trial** (not a permanent free tier — Railway removed that in
2024) hits two separate walls for an always-on prod bot: it can't attach a
custom domain, and the trial credit itself runs out. **Hobby (~$5/mo) removes
both limits** — this is the plan actually in use.

## Notes

- **Single instance only**, unchanged. pg-boss's cron schedules and the
  Telegram webhook both assume exactly one running replica — do not scale the
  service beyond 1.
- **Backups:** Neon is a managed service — check its dashboard for your plan's
  point-in-time-recovery / backup retention window rather than assuming a
  specific policy here.
- **Keep-alive workflow:** removed 2026-07-17 (`.github/workflows/keepalive.yml`
  pinged `/health` every 10 minutes solely to fight Render free-tier
  spin-down). Railway Hobby is always-on, so it had been dead weight since the
  move and is gone now that Render itself is decommissioned.
- **Render:** decommissioned 2026-07-17 — it was kept suspended (not deleted)
  as an instant DNS-flip rollback while Railway proved itself; that period is
  over, so the standby service was torn down. Rolling back now would mean
  recreating the Render service from scratch, not just resuming it.

---

# Web app (Vercel) — app.meetyoinky.com

The `packages/web` Next.js app deploys to Vercel as a **separate deploy from the
Railway backend, over the same Neon database.** Vercel is serverless — it serves
the UI and API routes and can enqueue jobs, but it does **not** run the pg-boss
workers, cron, or the Telegram bot. Keep Railway running for those; otherwise
connect/ingest/diagnose, scheduled posts, and trends never get processed.

> **Already provisioned (2026-07-17):** Vercel project `yoinky-web`
> (`parry22s-projects`), Root Directory `packages/web`, framework Next.js,
> deployment protection `all_except_custom_domains` (so `app.meetyoinky.com`
> is public while the raw `*.vercel.app` URLs are SSO-gated). Domain
> `app.meetyoinky.com` is attached + verified. **Remaining to go live:**
> (a) DNS `app` CNAME at Namecheap, (b) env vars incl. the Neon `DATABASE_URL`,
> (c) the Google redirect URI, (d) `vercel deploy --prod` to pick up the env.
> Env helper: `bash packages/web/scripts/push-env-to-vercel.sh`.

## 1. Create the Vercel project

Import the Git repo in Vercel (or `vercel link` from `packages/web`), then set:

- **Root Directory:** `packages/web`  ← the single most important setting.
- **Framework:** Next.js (auto-detected).
- **Build/Install:** pinned by `packages/web/vercel.json` —
  `buildCommand: pnpm build` (which runs `pnpm --filter @yoink/backend build &&
  next build`, so the backend `dist/` the web imports is compiled first) and
  `installCommand: pnpm install --frozen-lockfile` (installs the whole pnpm
  workspace so `@yoink/backend` links).

Why not the old root `vercel.json` `builds` config: it bypassed the package
build script and never compiled the backend `dist`, so `@yoink/backend/web`
(which resolves to `dist/web.js`) was missing. Removed 2026-07-17.

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

The web runs backend code in-process, so it needs the **same env the backend
needs** — the simplest correct move is to copy the Railway backend's env into
Vercel (Production, and Preview if you want preview deploys to work). Minimum:

| Var | Value |
|---|---|
| `DATABASE_URL` | the **Neon** URL — the same instance Railway uses (not a new DB) |
| `OPENROUTER_API_KEY` | required for any chat/draft/diagnosis |
| `QWEN_API_KEY` (or `OPENAI_API_KEY`) | embeddings |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `TWITTERAPI_IO_KEY`, `APIFY_TOKEN` | connect/ingest (X + LinkedIn) |
| `RESEND_API_KEY`, `MAIL_FROM` | optional — magic-link email (unset = link logged, no email) |

`NODE_ENV=production` is set by Vercel automatically (so session cookies are
`Secure`). No `.env.local` symlink is used in prod — that's a local-dev-only
convenience; Vercel injects `process.env` directly.

## 3. Domain + DNS

- Vercel → Project → Domains → add `app.meetyoinky.com`.
- At the DNS provider (Namecheap, same as `bot`), add a **CNAME**:
  `app` → `cname.vercel-dns.com`. Vercel issues the TLS cert automatically.
- The apex/`bot` records are untouched — `bot.meetyoinky.com` stays on Railway.

## 4. Google OAuth redirect URI (required before Google sign-in works in prod)

In Google Cloud Console → the OAuth client → **Authorized redirect URIs**, add:

```
https://app.meetyoinky.com/api/auth/google/callback
```

(and `https://app.meetyoinky.com` under Authorized JavaScript origins). Keep the
`http://localhost:3002/...` entry for local dev. The app derives the redirect
URI from the request origin, so no code/env change is needed — only the Console
whitelist.

## 5. Deploy + verify

Push to the connected branch (or `vercel --prod`). After it's live:

- `https://app.meetyoinky.com/login` renders → email + "Continue with Google".
- Sign in (Google or email) → lands on `/app`.
- Connecting an account from Settings enqueues an ingest job — confirm the
  **Railway** backend logs show it being processed (the web can't process it).

## Notes / limits

- **Function duration:** LLM turns (chat/draft) can run many seconds; routes set
  `maxDuration` (Vercel's default max is 300s across plans, so these are fine).
- **Single-writer assumptions live on Railway, not Vercel** — the web only does
  request/response work + job enqueues, so Vercel's autoscaling is safe. Do not
  move workers/cron to Vercel.
- **Rollback:** Vercel keeps every deployment; promote a previous one from the
  dashboard. DNS stays pointed at Vercel throughout.
