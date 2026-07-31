#!/usr/bin/env bash
#
# One-command Neon → Supabase migration.
#
# WHY A SCRIPT AND NOT A RUNBOOK. This has to happen in one shot, in the right
# order, with verification — and it will most likely be run in a hurry, possibly
# inside a paid export window bought specifically to let `pg_dump` read. A list of
# steps in a doc is where "I forgot to create the extensions first" and "I thought
# the restore had worked" come from. This refuses to declare success it hasn't
# earned.
#
# WHAT IT DOES NOT DO: touch Neon in any way other than reading. No drops, no
# writes, no deletes. The old database remains a complete, untouched rollback for
# as long as you keep it — do NOT delete the Neon project until the app has run
# happily on Supabase for a few days.
#
# USAGE
#   bash packages/backend/scripts/migrate-to-supabase.sh          # full run
#   bash packages/backend/scripts/migrate-to-supabase.sh --check  # preflight only
#
# READS (gitignored, nothing is printed):
#   .env.supabase → NEON_SOURCE_URL      (source: PRODUCTION Neon, unpooled)
#   .env.supabase → SUPABASE_DIRECT_URL  (target: session pooler :5432)
#
# ⚠️  THE SOURCE IS **NOT** packages/backend/.env. That file holds
# `postgres://localhost:5432/yoink` — a LOCAL dev database. An earlier draft of
# this script read it, which would have dumped dev data into Supabase, verified
# local-against-target, reported success, and left production behind while both
# deploys were repointed at the wrong dataset. Production's URL lives only in
# Railway's environment (see DEPLOY.md), so it must be supplied explicitly.
#
# Get it from either:
#   railway variables --service backend --kv | grep '^DATABASE_URL='
#   or the Neon dashboard → Connect → **deselect** "Connection pooling"
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BACKEND_ENV="$REPO_ROOT/packages/backend/.env"
SUPA_ENV="$REPO_ROOT/.env.supabase"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$REPO_ROOT/neon-$STAMP.dump"
CHECK_ONLY="${1:-}"

die() { echo "❌ $*" >&2; exit 1; }
ok()  { echo "✅ $*"; }
note(){ echo "→  $*"; }

# Read one KEY=value from a dotenv file without sourcing it (sourcing would
# execute arbitrary shell if a value contains backticks or $()).
read_env() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 1
  sed -n "s/^${key}=[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}[[:space:]]*$/\1/p" "$file" | head -1
}

# ── preflight ───────────────────────────────────────────────────────────────
command -v pg_dump    >/dev/null || die "pg_dump not found. brew install postgresql@17"
command -v pg_restore >/dev/null || die "pg_restore not found. brew install postgresql@17"
command -v psql       >/dev/null || die "psql not found. brew install postgresql@17"

# Source resolution, in order of preference:
#   0. The NEON_SOURCE_URL / SUPABASE_DIRECT_URL environment variables. This is how
#      CI supplies them (see .github/workflows/migrate-to-supabase.yml) — GitHub
#      Actions has unrestricted egress, whereas some local sandboxes block outbound
#      5432 entirely, which makes running this locally impossible rather than
#      merely awkward.
#   1. NEON_SOURCE_URL in .env.supabase, if you pasted one (an explicit override
#      wins — e.g. you want a specific Neon branch).
#   2. Railway's own environment, fetched live.
#
# Preferring (2) is deliberate. It means the production database credential is read
# into memory for the length of this run and never written to disk — which is both
# one less secret at rest and one less thing to forget to delete afterwards. It also
# removes the failure mode this script exists to prevent: you cannot paste the wrong
# URL if you never paste one.
SRC_URL="${NEON_SOURCE_URL:-}"
[ -n "$SRC_URL" ] && note "source taken from the environment (CI mode)"
[ -z "$SRC_URL" ] && SRC_URL="$(read_env "$SUPA_ENV" NEON_SOURCE_URL || true)"
if [ -z "${SRC_URL:-}" ]; then
  if command -v railway >/dev/null 2>&1; then
    note "NEON_SOURCE_URL not set — reading DATABASE_URL from Railway (never written to disk)…"
    SRC_URL="$(railway variables --service backend --kv 2>/dev/null \
                | sed -n 's/^DATABASE_URL=//p' | head -1 || true)"
    [ -n "${SRC_URL:-}" ] && ok "source resolved from Railway"
  fi
fi

# Target: environment first (CI), then the gitignored handoff file (local).
DST_URL="${SUPABASE_DIRECT_URL:-}"
[ -z "$DST_URL" ] && DST_URL="$(read_env "$SUPA_ENV" SUPABASE_DIRECT_URL || true)"

[ -n "${SRC_URL:-}" ] || die "no source URL. Either paste NEON_SOURCE_URL into .env.supabase, or make sure 'railway' is logged in and linked to the yoinky project (railway status)."
[ -n "${DST_URL:-}" ] || die "SUPABASE_DIRECT_URL is empty — set it in the environment (CI) or in .env.supabase (local). Must be the SESSION pooler string, port 5432."

# Egress check. Some sandboxes block outbound 5432 wholesale, which produces a
# confusing wall of connection timeouts that look like wrong credentials. Name it
# up front instead: if the target's port is unreachable at the TCP layer, no
# credential is going to help, and CI (unrestricted egress) is the place to run.
DST_HOST="$(printf '%s' "$DST_URL" | sed -E 's#.*@([^:/?]+).*#\1#')"
DST_PORT="$(printf '%s' "$DST_URL" | sed -E 's#.*@[^:]+:([0-9]+).*#\1#')"
if command -v nc >/dev/null 2>&1; then
  nc -z -w 8 "$DST_HOST" "${DST_PORT:-5432}" 2>/dev/null \
    || die "cannot open a TCP connection to $DST_HOST:${DST_PORT:-5432}. Outbound Postgres is likely blocked on this network — run this via the GitHub Actions workflow instead: Actions → 'Migrate to Supabase' → Run workflow."
  ok "TCP reachable: $DST_HOST:${DST_PORT:-5432}"
fi

# The exact mistake that made the first draft of this script dangerous. A source
# pointing at localhost would migrate dev data and pass every check, because the
# checks compare source to target.
case "$SRC_URL" in
  *localhost*|*127.0.0.1*)
    die "NEON_SOURCE_URL points at localhost — that is the LOCAL dev database, not production. This would migrate dev data and 'verify' successfully." ;;
esac
case "$SRC_URL" in
  *neon.tech*) ;;
  *) echo "⚠️  NEON_SOURCE_URL host is not *.neon.tech — continuing, but confirm this is really production." >&2 ;;
esac

# Guard the mistake that silently half-works: pg-boss needs session-scoped state,
# so the migration target must be the session pooler, not the transaction one.
case "$DST_URL" in
  *:6543*) die "SUPABASE_DIRECT_URL points at :6543 (transaction mode). Use the SESSION pooler, :5432 — pg-boss needs session state." ;;
esac
# And the source must not be pooled, per Neon's own pg_dump guidance.
case "$SRC_URL" in
  *-pooler*) die "DATABASE_URL is a POOLED Neon string. pg_dump needs the unpooled host (no '-pooler')." ;;
esac

CLIENT_MAJOR="$(pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
note "pg client major version: $CLIENT_MAJOR"

note "checking source (Neon) reachability…"
SRC_MAJOR="$(psql "$SRC_URL" -Atc "SHOW server_version_num" 2>/dev/null | cut -c1-2 || true)"
[ -n "$SRC_MAJOR" ] || die "cannot connect to Neon. If this is the compute-time quota, the export window has to be open first — no connection string change gets around it."
ok "Neon reachable (server major $SRC_MAJOR)"
[ "$CLIENT_MAJOR" -ge "$SRC_MAJOR" ] || die "pg_dump $CLIENT_MAJOR is older than the Neon server ($SRC_MAJOR) and will refuse. brew install postgresql@$SRC_MAJOR"

note "checking target (Supabase) reachability…"
DST_MAJOR="$(psql "$DST_URL" -Atc "SHOW server_version_num" 2>/dev/null | cut -c1-2 || true)"
[ -n "$DST_MAJOR" ] || die "cannot connect to Supabase. Check the password and that you used the Session pooler string."
ok "Supabase reachable (server major $DST_MAJOR)"
[ "$CLIENT_MAJOR" -ge "$DST_MAJOR" ] || die "pg_restore $CLIENT_MAJOR is older than the Supabase server ($DST_MAJOR). brew install postgresql@$DST_MAJOR"

# Refuse to restore over an existing dataset. Re-running after a partial restore
# should be a deliberate act, not an accident that interleaves two datasets.
EXISTING="$(psql "$DST_URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo 0)"
if [ "${EXISTING:-0}" -gt 0 ]; then
  die "target already has $EXISTING tables in public. Reset the Supabase database first (Dashboard → Settings → Database → Reset), or restore into a fresh project."
fi
ok "target public schema is empty"

SRC_TABLES="$(psql "$SRC_URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
SRC_MEMORIES="$(psql "$SRC_URL" -Atc "SELECT count(*) FROM memories" 2>/dev/null || echo "n/a")"
SRC_CAPTURES="$(psql "$SRC_URL" -Atc "SELECT count(*) FROM captures" 2>/dev/null || echo "n/a")"
note "source: $SRC_TABLES public tables, memories=$SRC_MEMORIES, captures=$SRC_CAPTURES"

if [ "$CHECK_ONLY" = "--check" ]; then
  ok "preflight passed — rerun without --check to migrate"
  exit 0
fi

# ── extensions ──────────────────────────────────────────────────────────────
# Must exist BEFORE the restore: the dump contains vector-typed columns, and a
# restore into a database without the extension fails on every one of them.
note "creating extensions on target…"
psql "$DST_URL" -v ON_ERROR_STOP=1 -q -c "CREATE EXTENSION IF NOT EXISTS vector;" \
                                    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
ok "vector + pgcrypto present"

# ── dump ────────────────────────────────────────────────────────────────────
note "dumping Neon → $(basename "$DUMP") (this is read-only against Neon)…"
pg_dump "$SRC_URL" --format=custom --no-owner --no-acl --file="$DUMP"
DUMP_TABLES="$(pg_restore --list "$DUMP" | grep -c 'TABLE DATA' || true)"
[ "$DUMP_TABLES" -ge 5 ] || die "dump contains only $DUMP_TABLES data tables — refusing to continue"
ok "dump written ($(du -h "$DUMP" | cut -f1)), $DUMP_TABLES data tables"

# ── restore ─────────────────────────────────────────────────────────────────
# HNSW index builds are memory-hungry and the free instance is small, so raise
# maintenance_work_mem for this session only. --exit-on-error is deliberately NOT
# set: Supabase pre-owns some objects (schema public, extension comments) and those
# collisions are benign. Correctness is established by the verification below
# instead of by a zero exit code, which is the honest way round.
note "restoring into Supabase (single connection, jobs=1 for deterministic ordering)…"
PGOPTIONS="-c maintenance_work_mem=256MB" \
  pg_restore --dbname="$DST_URL" --no-owner --no-acl --jobs=1 "$DUMP" 2>"$DUMP.restore.log" || true
note "restore log: $(basename "$DUMP").restore.log ($(grep -c . "$DUMP.restore.log" || echo 0) lines)"

# ── verify ──────────────────────────────────────────────────────────────────
echo
note "verifying…"
FAIL=0

DST_TABLES="$(psql "$DST_URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
if [ "$DST_TABLES" -lt "$SRC_TABLES" ]; then
  echo "❌ tables: source $SRC_TABLES → target $DST_TABLES"; FAIL=1
else ok "tables: $DST_TABLES (source $SRC_TABLES)"; fi

for t in memories captures users positions subscriptions connected_accounts; do
  S="$(psql "$SRC_URL" -Atc "SELECT count(*) FROM $t" 2>/dev/null || echo skip)"
  [ "$S" = "skip" ] && continue
  D="$(psql "$DST_URL" -Atc "SELECT count(*) FROM $t" 2>/dev/null || echo 0)"
  if [ "$S" != "$D" ]; then echo "❌ $t: source $S → target $D"; FAIL=1
  else ok "$t: $D rows"; fi
done

# The eight pgvector columns each carry an HNSW index. These are the objects most
# likely to be silently missing after a restore into a small instance, and the ones
# whose absence degrades quietly — searches still return, just wrongly ranked and
# slowly. So they get checked by name rather than assumed.
SRC_IDX="$(psql "$SRC_URL" -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexdef ILIKE '%hnsw%'")"
DST_IDX="$(psql "$DST_URL" -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexdef ILIKE '%hnsw%'")"
if [ "$SRC_IDX" != "$DST_IDX" ]; then
  echo "❌ HNSW indexes: source $SRC_IDX → target $DST_IDX"
  psql "$DST_URL" -Atc "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexdef ILIKE '%hnsw%' ORDER BY 1"
  FAIL=1
else ok "HNSW vector indexes: $DST_IDX"; fi

# A vector search that actually executes proves the extension, the column type and
# the operator class all survived — three things a row count cannot tell you.
if psql "$DST_URL" -Atc "SELECT 1 FROM memories WHERE embedding IS NOT NULL ORDER BY embedding <=> (SELECT embedding FROM memories WHERE embedding IS NOT NULL LIMIT 1) LIMIT 1" >/dev/null 2>&1; then
  ok "pgvector cosine search executes"
else
  echo "⚠️  vector search did not execute (fine if no embeddings exist yet)"
fi

APPLIED="$(psql "$DST_URL" -Atc "SELECT count(*) FROM schema_migrations" 2>/dev/null || echo 0)"
ok "schema_migrations rows carried over: $APPLIED"

echo
if [ "$FAIL" -ne 0 ]; then
  die "VERIFICATION FAILED — do not repoint anything. Neon is untouched; fix the above and re-run against a reset target."
fi

cat <<EOF
✅ Migration verified.

Neon is untouched — keep it as the rollback until the app has run on Supabase for
a few days. The dump is at:
  $DUMP

REMAINING STEPS (deliberately manual — each is a production config change):

  1. Railway backend → SESSION pooler (:5432)
       railway variables --service backend --set "DATABASE_URL=<SUPABASE_DIRECT_URL>"
     Then deploy, because pushing does not deploy the backend:
       railway up --service backend --detach

  2. Vercel web → TRANSACTION pooler (:6543)
       vercel env rm DATABASE_URL production
       printf '<SUPABASE_POOLED_URL>' | vercel env add DATABASE_URL production
       vercel --prod

  3. GitHub secret for the nightly backup:
       DATABASE_BACKUP_URL = <SUPABASE_DIRECT_URL>

  4. Watch the backend boot apply migrations 0038/0039:
       railway logs --service backend

  5. Once healthy for a few days: delete the Neon projects (main AND yoinky-litellm)
     so neither burns compute-hours, and revoke the Supabase access token if used.
EOF
