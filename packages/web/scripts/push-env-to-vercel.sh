#!/usr/bin/env bash
#
# Push the web app's runtime env from packages/backend/.env to the linked Vercel
# project (Production). Run it yourself from the repo root after `vercel link` —
# your secrets flow straight from your machine to Vercel.
#
#   bash packages/web/scripts/push-env-to-vercel.sh
#
# NOTE: DATABASE_URL is intentionally skipped — the local .env points at
# localhost; production must use your Neon URL (see the end of this script).

set -euo pipefail

ENV_FILE="packages/backend/.env"
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE — run from the repo root"; exit 1; }

# The keys the web app actually needs at runtime (DATABASE_URL handled separately).
KEYS=(
  OPENROUTER_API_KEY
  MODEL_CHAT
  QWEN_API_KEY
  OPENAI_API_KEY
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  TWITTERAPI_IO_KEY
  APIFY_TOKEN
  RESEND_API_KEY
  MAIL_FROM
)

for k in "${KEYS[@]}"; do
  v="$(grep -E "^${k}=" "$ENV_FILE" | head -1 | sed -E "s/^${k}=//")" || true
  if [ -z "${v:-}" ]; then echo "skip  $k (empty/unset)"; continue; fi
  vercel env rm "$k" production -y >/dev/null 2>&1 || true
  if printf '%s' "$v" | vercel env add "$k" production >/dev/null 2>&1; then
    echo "set   $k"
  else
    echo "FAIL  $k"
  fi
done

cat <<'EOF'

Almost there. Two manual steps this script deliberately does NOT do:

1) DATABASE_URL — set it to your NEON production URL (not localhost):
     vercel env add DATABASE_URL production
   (paste the same connection string the Railway backend uses)

2) Redeploy so the functions pick up the new env:
     vercel deploy --prod
EOF
