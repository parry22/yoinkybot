# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Use GitHub's private vulnerability reporting for this repository so credentials, exploit details, and affected user data stay private.

Include the affected component, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Supported version

Security fixes are applied to the latest commit on `main`. Self-hosters should keep their deployment current and rotate any credential that may have been exposed.

## Hosted production controls

- **Paywall fail-fast.** When `SELF_HOSTED=false` and `NODE_ENV=production`, the process throws if `PAYWALL_ENABLED` is not truthy. Self-hosted installs set `SELF_HOSTED=true` and leave the paywall off.
- **OAuth token encryption.** Access/refresh tokens on `connected_accounts` are sealed with AES-256-GCM. Set `OAUTH_TOKEN_ENCRYPTION_KEY` (preferred) or `BYOK_ENCRYPTION_KEY` (32-byte key, base64). Hosted production throws at boot without a valid key; token writers refuse plaintext. Existing plaintext rows require reconnect, not automatic migration.
- **Expired-account policy.** Hosted paywall gates mutating API routes (`requirePaid` → 402). Expired/free users retain read-only access to company knowledge, analytics, and similar views by design until a stricter policy is chosen.
- **Cron auth.** `/api/internal/media-cleanup` requires `Authorization: Bearer <CRON_SECRET>` compared with `crypto.timingSafeEqual`.
- **Private Blob.** Media stored as private Vercel Blob needs `BLOB_READ_WRITE_TOKEN` on the web uploader and on the Railway publisher (`social/media.ts` fetches with Bearer).
- **Conversion webhook.** Public `POST /api/conversions/webhook` verifies an opaque token, a 24-hour timestamp window, workspace ownership of referenced entities, and workspace-scoped dedupe (`UNIQUE (workspace_id, deduplication_key)`). Rate limiting is fail-closed. A browser helper lives at `/conversion-tracker.js`.

## Tenant isolation (RLS deferred)

Workspace boundaries are enforced in application code (`requireWorkspaceRole` and scoped queries) plus database same-workspace foreign keys and CHECK/trigger hardening (`0047`, `0051`, `0056`). **Postgres Row Level Security is intentionally deferred** and must not be assumed. Do not treat the database as a multi-tenant isolation boundary for ad-hoc SQL clients.

## Deploy hygiene

- Apply migrations by deploying the **backend first** (migrations run on boot), then the web app.
- CI (`.github/workflows/ci.yml`) gates typecheck, lint, unit tests, and build on `main`. It does **not** deploy.
- Never commit `.env`, dumps, OAuth tokens, or API keys.
