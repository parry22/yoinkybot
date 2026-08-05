# Deploying Yoinky

This guide covers the free Open Source edition. You run the infrastructure and bring your own provider keys.

## Recommended topology

Yoinky has two deployable applications and one shared database:

| Component | Requirement | Common choices |
| --- | --- | --- |
| Backend | Always-on Node.js 20 process | Railway, Fly.io, Render paid, VPS |
| Web | Next.js 16 | Vercel, Railway, Docker, VPS |
| Database | PostgreSQL 16 with pgvector | Supabase, Neon, Railway PostgreSQL, self-hosted pgvector |

The backend runs Fastify, the Telegram bot, database migrations, pg-boss workers, and cron schedules. Keep it running continuously and use one replica with the current scheduler design.

## 1. Prepare PostgreSQL

Create a PostgreSQL database with the `vector` extension. Keep two connection requirements in mind:

- the always-on backend and pg-boss work best with a direct or session-pooled connection
- serverless web functions should use a transaction-pooled connection with a small application pool

Set `DATABASE_URL` on both applications. They must point to the same database.

For a local or single-server Docker database:

```bash
export POSTGRES_PASSWORD=choose-a-strong-password
docker compose up -d db
```

The backend applies every pending migration on startup. You can also apply them manually:

```bash
pnpm db:migrate
```

## 2. Configure the backend

Deploy the repository root with `Dockerfile`, or run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @yoink/backend exec tsx src/index.ts
```

Start from `.env.example`. The minimum useful production configuration is:

```dotenv
NODE_ENV=production
PORT=3001
PUBLIC_URL=https://bot.example.com
WEB_APP_URL=https://app.example.com
DATABASE_URL=postgresql://...

SELF_HOSTED=true
PAYWALL_ENABLED=false

LLM_TRANSPORT=openrouter
OPENROUTER_API_KEY=...
MODEL_CHAT=x-ai/grok-4.5
```

Add `APIFY_TOKEN` for X and LinkedIn research, OAuth app credentials for publishing, and Telegram variables if you want the bot. The complete provider list is in [README.md](README.md) and `.env.example`.

If `PUBLIC_URL` uses HTTPS and Telegram is configured, the backend registers its webhook automatically. With a local HTTP URL, it uses Telegram long polling.

## 3. Configure the web app

Deploy `packages/web` as a Next.js application. It needs the same server-side environment as the backend because web routes import shared domain code and access the same database.

Required web authentication variables:

```dotenv
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
```

For Vercel, set the project root to `packages/web`. For a Node host, build and start with:

```bash
pnpm --filter @yoink/web build
pnpm --filter @yoink/web start
```

## 4. Configure OAuth applications

Use your real HTTPS origins in provider dashboards:

```text
https://bot.example.com/oauth/x/callback
https://bot.example.com/oauth/linkedin/callback
https://app.example.com/api/auth/x/callback
https://app.example.com/api/auth/linkedin/callback
```

Then set:

```dotenv
X_CLIENT_ID=...
X_CLIENT_SECRET=...
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
LINKEDIN_API_VERSION=202604
```

Provider approval, scopes, and API pricing are controlled by X and LinkedIn. Check their current dashboards before launch.

## 5. Verify the deployment

Before deploying:

```bash
pnpm verify
pnpm build
```

After deploying:

```bash
curl https://bot.example.com/health
```

A healthy response reports `ok: true`. It also reports whether the selected LLM transport, analytics, and research providers are configured without exposing any secret values.

Test these flows with a non-admin account:

1. Sign up and connect X.
2. Create a draft from Compose.
3. Schedule a post with media.
4. Connect LinkedIn and repurpose an X post.
5. Connect Telegram and approve a scheduled draft.
6. Restart the backend and confirm workers and the Telegram webhook recover.

## Backups and updates

- Back up PostgreSQL with `pg_dump` or your provider's point-in-time recovery.
- Keep database backups outside the application host.
- Run `pnpm verify` and `pnpm build` before upgrading.
- Deploy the backend first when a release contains a database migration, then deploy the web app.
- Never edit an already-applied migration. Add a new forward migration.
- Never commit `.env` files, database dumps, OAuth tokens, or API keys.

The included `.github/workflows/backup.yml` can create nightly encrypted-platform artifacts when `DATABASE_BACKUP_URL` is configured as a GitHub Actions secret.

## Hosted Growth and Scale

The managed Yoinky service uses the same codebase with `SELF_HOSTED=false`, `PAYWALL_ENABLED=true`, and DodoPayments product IDs for Growth and Scale. Open Source installations should leave all Dodo variables empty.
