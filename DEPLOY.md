# Deploying Yoinky (Railway)

Two services in one Railway project: the bot (built from the repo's
`Dockerfile` — already validated locally, builds clean and passes migrations)
and a Postgres with pgvector (a plain Docker image service, not Railway's
built-in Postgres plugin, which doesn't ship the `vector` extension).

Railway has no VPC/firewall/"security group" concept to configure — every
service just gets a private network address automatically, and you opt a
service into a public HTTPS URL with one click. This is the whole reason it's
a better fit than a raw VM (Alibaba ECS, EC2, a Droplet) for this project.

## 1. Create the project

1. Go to [railway.app](https://railway.app), sign up (GitHub login is easiest).
2. **New Project → Deploy from GitHub repo** — push this repo to GitHub first
   if it isn't already, then pick it. Railway detects the `Dockerfile`
   automatically and builds from it. Name this service **backend**.

## 2. Add the database

1. In the same project: **+ New → Empty Service**. Name it **db**.
2. In its settings, set the **Docker Image** to `pgvector/pgvector:pg16`
   (Settings → Source → Deploy from Docker Image — not "connect a repo").
3. **Variables** tab on the `db` service, add:
   ```
   POSTGRES_DB=yoink
   POSTGRES_USER=yoink
   POSTGRES_PASSWORD=<a strong random password — generate your own, e.g. `openssl rand -base64 24`>
   ```
   Never commit the real value to this repo — set it directly in Railway's
   dashboard only.
4. **Volumes** tab → add a volume, mount path `/var/lib/postgresql/data`
   (without this, the database resets on every redeploy).

## 3. Configure the backend service

Open the **backend** service → **Variables** tab → **Raw Editor**, and paste
the block below in one shot, then replace every `<...>` placeholder with the
real value (pull the API keys from your local `packages/backend/.env` — a
ready-to-paste version with your actual values was shared in chat, never
committed to this repo on purpose: secrets in git history stay there forever,
even if the repo is later made public or an .env is deleted in a later commit):

```bash
NODE_ENV=production
PORT=3001
PUBLIC_URL=https://bot.meetyoinky.com
CHECKOUT_RETURN_URL=https://t.me/yoinkyybot

DATABASE_URL=postgres://yoink:<the POSTGRES_PASSWORD you set on db>@${{db.RAILWAY_PRIVATE_DOMAIN}}:5432/yoink

TELEGRAM_BOT_TOKEN=<from @BotFather / your local .env>
TELEGRAM_WEBHOOK_SECRET=<any random string — generate your own, e.g. `openssl rand -hex 32`>
ADMIN_TELEGRAM_ID=<your own Telegram numeric user id — get it from @userinfobot>

GROQ_API_KEY=<from console.groq.com / your local .env>
GROQ_STT_MODEL=whisper-large-v3-turbo

OPENROUTER_API_KEY=<from openrouter.ai / your local .env>   # REQUIRED — the only LLM route

QWEN_API_KEY=<from DashScope / your local .env>             # embeddings only
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIMS=1536

TREND_PROVIDER=apify
APIFY_TOKEN=<from apify.com / your local .env>
TWITTERAPI_IO_KEY=<from twitterapi.io / your local .env>

DODO_ENV=test_mode
```

`${{db.RAILWAY_PRIVATE_DOMAIN}}` is Railway's own variable-reference syntax —
it resolves to the `db` service's private network address automatically, so
you never hardcode an IP. Paste it exactly like that.

**Switching models:** every LLM call goes to one model (`z-ai/glm-5.2` via
OpenRouter). To change it, set `MODEL_CHAT=<openrouter/model-id>` and redeploy —
no code change. There is no tier routing or provider fallback to configure.

## 4. Point your domain at it (Namecheap)

1. In the **backend** service → **Settings → Networking → Public Networking**,
   click **Custom Domain**, enter `bot.meetyoinky.com`, and Railway will show
   you a CNAME target like `backend-production-xxxx.up.railway.app`.
2. In Namecheap: **Domain List → meetyoinky.com → Manage → Advanced DNS**,
   add a record:
   - Type: `CNAME Record`
   - Host: `bot`
   - Value: the `....up.railway.app` target Railway gave you
   - TTL: Automatic
3. Wait a few minutes for DNS to propagate, then Railway issues an HTTPS
   certificate automatically. `https://bot.meetyoinky.com` should resolve.

(Using a subdomain rather than the bare `meetyoinky.com` on purpose — keeps
the root domain free for a future landing page, and subdomains are a simple
CNAME instead of the trickier apex-record dance most registrars need.)

## 5. Deploy

Once the domain resolves, redeploy the backend service (Railway does this
automatically on every push to your connected branch, or click **Deploy**
manually). Watch the logs: all 11 migrations apply, then `telegram webhook
set` — the app switches from dev long-polling to a real webhook automatically
the moment `PUBLIC_URL` starts with `https://`, no flag needed.

## Before every deploy

```bash
pnpm verify   # typecheck + full unit suite — the gate
```

## Notes

- **Single instance only.** Don't scale the backend service beyond 1 replica —
  pg-boss's cron schedules and the Telegram webhook both assume exactly one
  running process.
- **Backups:** Railway's Postgres plugin has automatic backups; a plain Docker
  Postgres service (what we're using, for pgvector) does not. Set a periodic
  `pg_dump` if this holds real user data you can't lose — a small cron
  service in the same project running `pg_dump` to Railway's volume or an S3-
  compatible bucket works.
- **Alternatives, if Railway stops fitting:** Fly.io (`fly launch` from the
  same Dockerfile, cheaper at small scale, slightly more CLI-driven) and
  Render (similar dashboard-first experience, managed Postgres there does
  support pgvector on their newer plans) are both solid — same non-negotiable
  either way: single instance, custom domain, `DATABASE_URL` pointing at a
  Postgres with the `vector` extension.
