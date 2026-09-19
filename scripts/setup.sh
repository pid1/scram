#!/usr/bin/env bash
# Create the D1 database, apply migrations and set the secrets scram needs.
# Idempotent: safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."

DB_NAME="scram"
WRANGLER="npx --yes wrangler@4"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

say "1/4  Database"
if grep -qE '^database_id = ""' wrangler.toml; then
  note "Creating D1 database '$DB_NAME'..."
  OUT="$($WRANGLER d1 create "$DB_NAME" 2>&1 || true)"
  ID="$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  if [ -z "$ID" ]; then
    # Already exists, or creation failed. Try to read it back from the list.
    ID="$($WRANGLER d1 list --json 2>/dev/null \
      | grep -B2 "\"name\": \"$DB_NAME\"" \
      | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
  fi
  if [ -z "$ID" ]; then
    printf '\n  Could not determine the database id. Output was:\n%s\n' "$OUT" >&2
    exit 1
  fi
  # BSD and GNU sed disagree about -i; write through a temp file instead.
  sed "s|^database_id = \"\"|database_id = \"$ID\"|" wrangler.toml > wrangler.toml.tmp
  mv wrangler.toml.tmp wrangler.toml
  note "database_id = $ID"
else
  note "wrangler.toml already has a database_id; leaving it alone."
fi

say "2/4  Migrations"
$WRANGLER d1 migrations apply "$DB_NAME" --remote

say "3/4  Secrets"
if [ -z "${CF_API_TOKEN:-}" ]; then
  cat <<'TXT'
  scram needs a Cloudflare API token. Create one at
  https://dash.cloudflare.com/profile/api-tokens with these permissions:

    Account · Account Analytics       · Read
    Account · Workers Scripts         · Edit
    Account · Workers R2 Storage      · Read
    Account · D1                      · Read
    Zone    · Workers Routes          · Edit   (All zones)
    Zone    · Zone                    · Read   (All zones)

  This token can disable every Worker in the account. Treat it accordingly.
TXT
  printf '\n  Paste the token (input hidden): '
  read -rs CF_API_TOKEN
  printf '\n'
fi
printf '%s' "$CF_API_TOKEN" | $WRANGLER secret put CF_API_TOKEN

ADMIN_TOKEN="${ADMIN_TOKEN:-$(openssl rand -base64 32)}"
printf '%s' "$ADMIN_TOKEN" | $WRANGLER secret put ADMIN_TOKEN

if [ -n "${NOTIFY_WEBHOOK:-}" ]; then
  printf '%s' "$NOTIFY_WEBHOOK" | $WRANGLER secret put NOTIFY_WEBHOOK
else
  note "NOTIFY_WEBHOOK not set; skipping. Set it later with:"
  note "  npx wrangler secret put NOTIFY_WEBHOOK"
fi

say "4/4  Done"
cat <<TXT
  Admin token (you need this to open the status page):

    $ADMIN_TOKEN

  Write it down. It is not recoverable from here.

  Next:
    npm run deploy
    Open the Worker URL and paste the admin token.

  scram deploys with ARMED = "0": it will watch, estimate and record, but
  will not disable anything. Let it run a few days, confirm the numbers on
  the status page match the Billable Usage dashboard, then set ARMED = "1"
  in wrangler.toml and redeploy.
TXT
