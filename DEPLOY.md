# Deploying Yoinky (Railway + Neon)

**Current production, verified 2026-07-12:**

| | |
|---|---|
| Compute | Railway, project `yoinky`, service `backend`, **Hobby plan** (Railway's free trial cannot run an always-on process or attach a custom domain — see "Why not Render / why Hobby" below) |
| Database | **Neon** (`ep-cool-poetry-....us-east-1.aws.neon.tech`) — managed Postgres with pgvector, external to Railway. Unchanged across the whole Render→Railway move; nothing about the DB migrated |
| Domain | `bot.meetyoinky.com` → Railway, via CNAME + a Railway-issued TXT ownership record (see step 4) |
| Prior host | Render (`yoinkybot`, free plan) — **suspended, not deleted**, kept as an instant DNS-flip rollback |

One service, one external database. Railway has no VPC/security-group concept —
every service gets a private network address automatically, and a public HTTPS
URL is one command/click away.

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
is to copy them from wherever they're currently live (Render, or your local
`.env`), value-for-value, rather than retyping from memory:

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
- **Keep-alive workflow:** `.github/workflows/keepalive.yml` pings `/health`
  every 10 minutes — it existed specifically to fight Render free-tier
  spin-down. On Railway Hobby (always-on, no spin-down) it's no longer load-
  bearing; harmless to leave running, safe to delete if you want one less
  moving part.
- **Rollback:** Render is suspended, not deleted. To roll back: resume it from
  the Render dashboard (service → the Resume action), then point the `bot`
  CNAME back at Render's `.onrender.com` target. No app or DB changes needed
  either direction — the cutover is DNS-only because both hosts point at the
  same Neon database.
