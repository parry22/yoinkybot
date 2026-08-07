# Yoinky

Yoinky is an open source Company Narrative Engine. It turns founder insight, customer evidence and company activity into structured intellectual property, a governed narrative, grounded content briefs and traceable X and LinkedIn assets. The original personal creator product remains available inside an automatically created personal workspace.

[Hosted app](https://app.meetyoinky.com) | [Website](https://meetyoinky.com) | [Roadmap](docs/PHASES.md) | [Deployment guide](DEPLOY.md)

## Plans

| Plan | Price | Who runs it | API and infrastructure costs |
| --- | ---: | --- | --- |
| Open Source | Free | You | You bring your own keys, database, and hosting |
| Growth | $15/month | Yoinky | Included within Growth limits |
| Scale | $49/month | Yoinky | Included within Scale limits |

There is no Lifetime plan. The free option is the complete open source codebase under the MIT License. Self-hosters control their data and provider accounts, and pay providers directly for whatever they use.

## What is included

- Knowledge-first web shell (light mode): Inbox → Knowledge → Studio → Assets → Integrations → Settings
- Personal and company workspaces with deterministic role-based access
- Founder and expert profiles with separate voices
- Transcript intake with source-linked insights, claims, proof, stories and customer language
- Human review queues, permission inheritance and claim governance
- Versioned narrative systems and editorial territories
- Grounded LinkedIn briefs, founder-voice assets, evidence checks and full lineage
- Studio generation across X, LinkedIn, newsletter, blog, carousel, video scripts, email, slides and more
- Channel-native atomisation into X, LinkedIn and text artifacts without flattening provenance
- Deterministic distribution plans, tracked CTAs and workspace-verified conversion events
- Knowledge, territory and source-utilisation analytics with immutable editorial reviews
- Workspace administration for members, roles, experts, Telegram permissions, export and safe deletion
- Voice-matched drafting for X and LinkedIn
- X-to-LinkedIn repurposing, including supported media
- Compose, scheduling, and Auto Agent workflows
- Memory, beliefs, positions, diagnosis, and content planning
- Buyer Radar and trend research
- X and LinkedIn publishing through official OAuth apps
- Telegram workspace switching, explicit company capture, permission-gated approvals, notifications and proactive prompts
- PostgreSQL with pgvector for retrieval and memory
- Optional analytics, billing, feedback, and speech-to-text integrations
- Responsive mobile shell with hamburger nav drawer (≤1000px)

## The company narrative loop

```text
Company activity
→ Knowledge capture
→ Structured knowledge
→ Narrative architecture
→ Content briefs
→ Content production
→ Distribution
→ Conversion
→ Measurement
→ Better narrative decisions
```

Code controls workspace access, permissions, confidentiality, approval state and publication. Models extract, interpret and draft, but they cannot approve a claim or override a workspace boundary.

## Architecture

Yoinky is a pnpm monorepo with two applications over one PostgreSQL database:

- `packages/web`: Next.js web app on port 3002
- `packages/backend`: Fastify API, Telegram bot, OAuth callbacks, pg-boss workers, and scheduled jobs on port 3001

The backend applies database migrations at startup. Run one backend replica unless you move scheduling and worker coordination out of the process.

When the marketing site shares this database, keep its CMS pool small. The
included landing configuration caps Payload at two connections so the app,
workers and CMS do not exhaust a low-tier Postgres session limit.

## Self-host in development

### Prerequisites

- Node.js 20 or newer
- pnpm 10
- Docker, for the included pgvector PostgreSQL service
- A Clerk application for web sign-in
- An OpenRouter key, or an xAI key when using direct xAI transport

### 1. Clone and install

```bash
git clone https://github.com/parry22/yoinkybot.git
cd yoinkybot
corepack enable
pnpm install
```

### 2. Start PostgreSQL

Choose a local password, then start only the database service:

```bash
export POSTGRES_PASSWORD=change-me
docker compose up -d db
```

### 3. Create your private environment files

```bash
cp .env.example packages/backend/.env
ln -s ../backend/.env packages/web/.env.local
```

On Windows, copy the same file to `packages/web/.env.local` instead of creating a symbolic link.

At minimum, edit these values:

```dotenv
DATABASE_URL=postgres://yoink:change-me@localhost:5432/yoink
PUBLIC_URL=http://localhost:3001
WEB_APP_URL=http://localhost:3002
SELF_HOSTED=true
PAYWALL_ENABLED=false

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_your_key
CLERK_SECRET_KEY=sk_test_your_key

LLM_TRANSPORT=openrouter
OPENROUTER_API_KEY=your_openrouter_key
MODEL_CHAT=x-ai/grok-4.3
```

OpenRouter is the easiest BYOK route because one key can run Grok, OpenAI, Claude, and other compatible models by changing `MODEL_CHAT`. To use xAI directly, set `LLM_TRANSPORT=xai`, `XAI_API_KEY`, and `XAI_MODEL`.

### 4. Run migrations and start both apps

```bash
pnpm db:migrate
pnpm dev:all
```

Open [http://localhost:3002](http://localhost:3002). The backend health check is at [http://localhost:3001/health](http://localhost:3001/health).

## Add integrations

The core app can boot without every integration. Add only the capabilities you need.

| Capability | Environment variables |
| --- | --- |
| AI through OpenRouter | `OPENROUTER_API_KEY`, `MODEL_CHAT`, optionally `MODEL_CHEAP` |
| AI through xAI | `LLM_TRANSPORT=xai`, `XAI_API_KEY`, `XAI_MODEL` |
| Embeddings | `OPENAI_API_KEY`, or `QWEN_API_KEY` and `QWEN_EMBEDDING_MODEL` |
| X and LinkedIn research | `APIFY_TOKEN` and the actor variables from `.env.example` |
| Optional richer X research | `TWITTERAPI_IO_KEY` |
| X publishing | `X_CLIENT_ID`, `X_CLIENT_SECRET` |
| LinkedIn publishing | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_API_VERSION` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_URL` |
| Speech to text | `GROQ_API_KEY`, `OPENAI_API_KEY`, or `SARVAM_API_KEY` |
| News search fallback | `BRAVE_API_KEY` or `TAVILY_API_KEY` |
| Product analytics | `POSTHOG_API_KEY`, `POSTHOG_HOST` |
| Feedback email | `RESEND_API_KEY`, `FEEDBACK_EMAIL_TO`, `FEEDBACK_EMAIL_FROM` |

All secrets stay in your environment. Never commit `.env`, `.env.local`, or provider credentials.

### OAuth callback URLs

Register these URLs with your provider apps. Replace the origins with your deployed domains in production.

```text
http://localhost:3001/oauth/x/callback
http://localhost:3001/oauth/linkedin/callback
http://localhost:3002/api/auth/x/callback
http://localhost:3002/api/auth/linkedin/callback
```

X publishing requires OAuth scopes for reading users and posts, writing posts, media upload, and offline access. LinkedIn publishing requires OpenID Connect and `w_member_social` access.

## Self-host in production

The reference deployment uses:

- an always-on Node host for the backend and workers
- a Next.js host for the web app
- managed PostgreSQL with pgvector

You can use other providers. The important constraints are:

- keep the backend running continuously so scheduled jobs and Telegram delivery are reliable
- expose the backend and web app through HTTPS
- use a PostgreSQL database with the `vector` extension
- set `SELF_HOSTED=true` and `PAYWALL_ENABLED=false`
- keep all API keys in secret environment variables
- configure backups before storing real user data
- run only one backend replica with the current in-process scheduler design

See [DEPLOY.md](DEPLOY.md) for the production checklist and provider-specific examples.

## Hosted billing

Billing code exists only for the managed service. A self-hosted installation does not need DodoPayments keys and does not need to create plans. Hosted deployments set `SELF_HOSTED=false`, `PAYWALL_ENABLED=true`, and configure the Growth and Scale product IDs.

## Development commands

```bash
pnpm dev:all      # web and backend
pnpm typecheck    # all packages
pnpm test         # backend test suite
pnpm verify       # typecheck and tests
pnpm build        # production builds
pnpm db:migrate   # apply pending database migrations
```

## Security

- Provider secrets belong in environment variables only.
- User tokens and stored credentials are encrypted or kept server-side.
- Publishing uses official OAuth flows and fails closed when permission is missing.
- Review your provider costs and rate limits before enabling unattended automation.
- Rotate any credential that was ever pasted into an issue, chat, commit, or log.

For a vulnerability, do not open a public issue. Use GitHub's private vulnerability reporting for this repository.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), keep changes focused, and run `pnpm verify` plus `pnpm build` before submitting.

## License

Yoinky is available under the [MIT License](LICENSE).
