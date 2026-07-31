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

> ## ⚠️ PUSHING TO `main` DOES NOT DEPLOY THE BACKEND
>
> As of **2026-07-31** the `backend` service reports `source.repo` as
> `parry22/yoinkybot` — i.e. it *looks* connected — but a push to `main` does **not**
> produce a deployment. Only the Vercel apps (web + landing) auto-deploy.
>
> This is not a theoretical footgun. It cost ~15 hours: six `AGENT_RUNTIME_*` env
> vars were set to `legacy` and a commit was pushed, and both sat inert while the
> live container kept running the previous build. It was only caught by noticing the
> retry counter — `database unavailable (attempt 881)` at 60s intervals ≈ 14.8h,
> which matched the *previous* deployment's timestamp rather than the push.
>
> **Every backend change needs an explicit deploy:**
>
> ```bash
> railway up --service backend --detach
> ```
>
> Two corollaries that are easy to miss:
> - **Env var changes need a deploy too.** `railway variables --set` with
>   `--skip-deploys` (or on a service that doesn't auto-deploy) leaves the running
>   container on its old environment.
> - **Migrations run on boot**, so an un-deployed backend also means un-applied
>   migrations — while a freshly-deployed *web* app may already be querying columns
>   that don't exist yet. Deploy the backend first when a change spans both.
>
> To diagnose whether what's running is what you pushed, compare the deployment's
> `createdAt` against your commit time:
>
> ```bash
> railway status --json | python3 -c "import json,sys; d=json.load(sys.stdin); print([ (s['node']['serviceName'], (s['node'].get('latestDeployment') or {}).get('createdAt')) for e in d['environments']['edges'] for s in e['node']['serviceInstances']['edges'] ])"
> ```

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

---

# LiteLLM proxy (Agent SDK runtime — docs/INTERNAL §3n)

Only needed for the Claude Agent SDK migration. Until it's deployed and the
Phase-0 spike passes, every `AGENT_RUNTIME_*` flag stays `legacy` and the app
ignores all of this.

## What it is
A **separate Railway service** (its own container, same `yoinky` project) that
serves the Anthropic Messages API (`/v1/messages` + `/v1/messages/count_tokens`)
and translates to **OpenRouter → grok-4.5**. The backend's SDK subprocess points
`ANTHROPIC_BASE_URL` at it over Railway's **private network** — never expose it
publicly. Config lives in `litellm-config.yaml` (repo root).

## Provisioned resources
| Thing | Identifier |
|---|---|
| Railway service | `litellm` (`6860e21a-ce7e-439b-bedd-1438fda3cb98`), project `yoinky` |
| Private URL | `http://litellm.railway.internal:4000` — **no public domain, by design** |
| Image | `ghcr.io/berriai/litellm:v1.93.0`, built by `Dockerfile.litellm` |
| Key store | Neon project `yoinky-litellm` (`autumn-credit-25191795`), `aws-eu-central-1`, PG17 |

## Deploy
1. Image: `ghcr.io/berriai/litellm:v1.93.0`. **Pin a clean version above 1.82.8** —
   PyPI `1.82.7`/`1.82.8` shipped credential-stealing malware (BerriAI/litellm#24518).
   Do not float `latest` or `main-stable`. Note `main-v1.93.0-stable` **does not
   exist** (404 on ghcr.io); the `main-vX-stable` tag scheme stopped around 1.66.
2. Region: any (OpenRouter handles provider routing, so grok-4.5's xAI EU-console
   restriction doesn't apply here).
3. **Config is baked in, not mounted.** Railway has no file-mount primitive —
   volumes are empty persistent disks — so `Dockerfile.litellm` is a thin
   `FROM ghcr.io/berriai/litellm:v1.93.0` + `COPY litellm-config.yaml`. Select it
   on the service with `RAILWAY_DOCKERFILE_PATH=Dockerfile.litellm` and deploy
   from the repo root with `railway up --service litellm`.
4. **Bind `::`, not `0.0.0.0`.** Railway private networking is IPv6 in legacy
   environments; `::` binds both stacks. `Dockerfile.litellm`'s `CMD` passes
   `--host ::`. Confirm the boot log says `Uvicorn running on http://[::]:4000`.
5. **Postgres is mandatory.** Virtual keys are DB-backed — there is no static
   virtual-key block in `config.yaml`. `DATABASE_URL` points at a *separate free
   Neon project*, deliberately **not** `yoinkybot-prod`, so LiteLLM's ~30 prisma
   tables and its startup `migrate deploy` never touch the app database. Use the
   **direct** (non-pooler) endpoint — prisma migrations can't run through Neon's
   transaction-mode pooler. See §3n for the free-tier settings this forces.
6. Service env (NOT on the backend): `LITELLM_MASTER_KEY` (admin), `OPENROUTER_API_KEY`
   (upstream — the same key the backend uses), `DATABASE_URL`, `PORT=4000`,
   `RAILWAY_DOCKERFILE_PATH`. If you ever add an Anthropic-direct fallback, name
   that key something other than `ANTHROPIC_API_KEY` so a stray real key can't
   silently bypass the proxy and bill the public Anthropic API.
7. Mint a **virtual key** scoped to `yoinky-agent` + `yoinky-agent-fallback`; put
   it on the **backend** as `LITELLM_API_KEY` (backend never gets the master key).
   The proxy has no public domain, so mint it from *inside* the container:
   ```
   railway ssh --service litellm -- \
     curl -s localhost:4000/key/generate -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
       -H 'content-type: application/json' \
       -d '{"models":["yoinky-agent","yoinky-agent-fallback"],"key_alias":"yoinky-backend"}'
   ```
8. Set the backend's `LITELLM_BASE_URL` to `http://litellm.railway.internal:4000`.

## Verify (Phase 0 — the gate)
**The spike must run INSIDE Railway.** `railway run` executes the command on your
laptop with Railway's env vars injected — `*.railway.internal` is private DNS and
does not resolve off-platform, so a `railway run --service backend …` form fails
on DNS no matter what.

**If your network allows outbound port 22:**
```
railway ssh --service backend -- pnpm --filter @yoink/backend exec tsx scripts/spike-agent-sdk.ts
```
(Requires the deployed backend image to contain the spike — redeploy the backend
first if its image predates the Phase 0/1 commit.)

**If it doesn't** — some networks block 22 (`railway ssh`), 2226
(`railway sandbox exec`) and 5432 alike — deploy the spike **as a throwaway
service**, which works from anywhere and still never exposes the proxy:
```
railway add --service phase0-spike
railway variable set RAILWAY_DOCKERFILE_PATH=Dockerfile.spike --service phase0-spike --skip-deploys
railway variable set LITELLM_BASE_URL=http://litellm.railway.internal:4000 --service phase0-spike --skip-deploys
printf '%s' "$MASTER_KEY"  | railway variable set LITELLM_MASTER_KEY --stdin --service phase0-spike --skip-deploys
printf '%s' "$VIRTUAL_KEY" | railway variable set LITELLM_API_KEY    --stdin --service phase0-spike --skip-deploys
railway up --service phase0-spike --detach
railway logs --service phase0-spike            # ← results land here
railway service delete --service phase0-spike --yes   # ← ALWAYS clean up
```
`Dockerfile.spike` mirrors the backend image and runs `scripts/mint-litellm-key.ts`
(which mints the scoped virtual key from a value you supply, so the secret is
never echoed into deploy logs) followed by the spike.

It must print `GATE OK`. **Force a grok failure (temporarily break the primary
model id) once to confirm the fallback engages — Phase 0 did not test this.**
Paste the spike's results into INTERNAL §3n before building the adapter.

## Rollback
Flip the relevant `AGENT_RUNTIME_*` back to `legacy` on the backend (no deploy of
the proxy needed). If the proxy is down, that flag flip IS the mitigation — there
is no automatic runtime fallback by design (a silent degrade to a different model
is exactly the failure class to avoid). The proxy can be torn down entirely with
all flags on `legacy`.
