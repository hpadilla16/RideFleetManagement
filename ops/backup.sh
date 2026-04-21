#!/usr/bin/env bash
#
# ops/backup.sh — Automated Postgres backup of the Supabase-hosted production
# database to DigitalOcean Spaces.
#
# The production DB for Ride Fleet is NOT on the droplet; it's on Supabase
# (managed Postgres in AWS us-east-1), accessed via the pgbouncer pooler in
# backend/.env's DATABASE_URL. This script reads DATABASE_URL, rewrites it to
# hit the session-mode port (5432) since pg_dump is incompatible with
# transaction-mode pooling (6543), runs pg_dump via the host's postgresql-client,
# and uploads the resulting custom-format dump to DigitalOcean Spaces.
#
# Usage (on the droplet):
#   /root/RideFleetManagement/ops/backup.sh
#
# Cron entry (edit with `crontab -e` as root):
#   0 2 * * *  /root/RideFleetManagement/ops/backup.sh >> /var/log/ridefleet-backup.log 2>&1
#
# Required on the droplet:
#   - awscli installed (recommended: `snap install aws-cli --classic`) and a
#     profile (default: `digitalocean`) configured with DO Spaces credentials
#     via `aws configure --profile digitalocean`
#   - postgresql-client installed (`apt install -y postgresql-client`) — provides
#     pg_dump compatible with the server version
#   - readable /root/RideFleetManagement/backend/.env with a DATABASE_URL line
#
# See `docs/operations/backup-runbook.md` for setup + restore flow.
#
# Exit codes:
#   0  success
#   1  preflight failed, pg_dump failed, or dump too small
#   2  S3 upload failed
#
# Wave 1, Item 1.1 of the production-readiness plan
# (see docs/operations/production-readiness-plan-2026-04-20.md).

set -euo pipefail

# Ensure `aws` and other common locations are on PATH even when invoked from
# cron (which has a minimal default PATH). `aws` via snap lives in /snap/bin/.
export PATH="/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# -------- Configuration (override via env if needed) --------
: "${BACKUP_DIR:=/var/backups/ridefleet}"
: "${S3_BUCKET:=ridefleet-backup}"
: "${S3_ENDPOINT:=https://nyc3.digitaloceanspaces.com}"
: "${AWS_PROFILE:=digitalocean}"
: "${RETENTION_DAYS:=30}"
: "${REPO_DIR:=/root/RideFleetManagement}"
: "${DATABASE_URL:=}"   # will try to read from ${REPO_DIR}/backend/.env if empty

# -------- Helpers --------
log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }
fail() { log "FAIL: $*"; exit "${2:-1}"; }

# -------- Preflight --------
command -v aws >/dev/null 2>&1 || fail "awscli not installed (snap install aws-cli --classic)" 1

# Resolve the newest pg_dump available. Supabase bumps its server version from
# time to time; using the newest installed pg_dump client keeps us compatible.
# Preference: explicit PG_DUMP env var > /usr/lib/postgresql/<N>/bin/pg_dump for
# the highest N present > plain `pg_dump` on PATH.
if [ -z "${PG_DUMP:-}" ]; then
  PG_DUMP="$(ls -d /usr/lib/postgresql/*/bin/pg_dump 2>/dev/null | sort -Vr | head -1)"
  [ -n "$PG_DUMP" ] || PG_DUMP="$(command -v pg_dump || true)"
fi
[ -n "$PG_DUMP" ] && [ -x "$PG_DUMP" ] \
  || fail "pg_dump not found (install postgresql-client-17 from pgdg: see docs/operations/backup-runbook.md)" 1
log "Using pg_dump at: $PG_DUMP ($("$PG_DUMP" --version))"

mkdir -p "$BACKUP_DIR"

# -------- Resolve DATABASE_URL --------
# Prefer an explicit env var; fall back to backend/.env.
if [ -z "$DATABASE_URL" ] && [ -r "${REPO_DIR}/backend/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "${REPO_DIR}/backend/.env" | head -1 | cut -d= -f2-)"
  # Strip optional surrounding quotes
  DATABASE_URL="${DATABASE_URL%\"}"
  DATABASE_URL="${DATABASE_URL#\"}"
  DATABASE_URL="${DATABASE_URL%\'}"
  DATABASE_URL="${DATABASE_URL#\'}"
fi
[ -n "$DATABASE_URL" ] || fail "DATABASE_URL not set (export it or populate ${REPO_DIR}/backend/.env)" 1

# Transform Supabase pooler URL for pg_dump compatibility:
# - Replace port :6543 (pgbouncer transaction mode) with :5432 (session mode).
#   pg_dump uses LOCK TABLE and temp-table constructs that don't survive
#   transaction pooling; session mode behaves like a direct connection.
# - Strip ?pgbouncer=true and &pgbouncer=true (no-op on direct, breaks nothing).
BACKUP_URL="${DATABASE_URL//:6543/:5432}"
BACKUP_URL="$(printf '%s' "$BACKUP_URL" | sed 's/[?&]pgbouncer=true//g')"
# Clean up possible trailing ? left after stripping the only query param
BACKUP_URL="${BACKUP_URL%\?}"

# Log a masked URL so the password never hits logs.
MASKED_URL="$(printf '%s' "$BACKUP_URL" | sed 's|://[^@]*@|://<REDACTED>@|')"
log "Backup target: $MASKED_URL"

# Split password out of the URL so pg_dump doesn't expose it via `ps aux`.
# We pass the password to pg_dump via PGPASSWORD env var and feed pg_dump a URL
# without embedded credentials. URL-decode the password via Python (bash doesn't
# natively handle %XX escapes; passwords from Supabase are URL-encoded in the URL).
export BACKUP_URL
PGPASSWORD="$(python3 -c '
import os, urllib.parse as u
print(u.unquote(u.urlparse(os.environ["BACKUP_URL"]).password or ""))
')"
STRIPPED_URL="$(python3 -c '
import os, urllib.parse as u
r = u.urlparse(os.environ["BACKUP_URL"])
host = r.hostname or ""
port = ":" + str(r.port) if r.port else ""
user = r.username or ""
nl = (user + "@" if user else "") + host + port
print(u.urlunparse((r.scheme, nl, r.path, r.params, r.query, r.fragment)))
')"
export PGPASSWORD
unset BACKUP_URL   # no reason for it to live in the env after this point

# -------- 1. pg_dump --------
TIMESTAMP="$(date -u +%Y-%m-%d-%H%M%S)"
DUMP_FILE="$BACKUP_DIR/fleet-prod-${TIMESTAMP}.dump"

log "Starting pg_dump → $DUMP_FILE"
if ! "$PG_DUMP" -Fc --no-owner --no-privileges "$STRIPPED_URL" > "$DUMP_FILE"; then
  unset PGPASSWORD
  fail "pg_dump failed — check network to Supabase, password, and DATABASE_URL format" 1
fi
unset PGPASSWORD

DUMP_SIZE="$(stat -c%s "$DUMP_FILE")"
if [ "$DUMP_SIZE" -lt 1024 ]; then
  fail "pg_dump produced suspiciously small file (${DUMP_SIZE} bytes) — aborting upload" 1
fi
log "pg_dump OK — ${DUMP_SIZE} bytes"

# -------- 2. Upload to DO Spaces --------
S3_KEY="daily/fleet-prod-${TIMESTAMP}.dump"
log "Uploading → s3://${S3_BUCKET}/${S3_KEY}"
if ! aws --profile "$AWS_PROFILE" --endpoint-url "$S3_ENDPOINT" \
     s3 cp "$DUMP_FILE" "s3://${S3_BUCKET}/${S3_KEY}" \
     --only-show-errors; then
  fail "S3 upload failed" 2
fi

# Verify the uploaded object matches the local file size; catches
# silent truncation on the network path.
REMOTE_SIZE="$(aws --profile "$AWS_PROFILE" --endpoint-url "$S3_ENDPOINT" \
               s3api head-object --bucket "$S3_BUCKET" --key "$S3_KEY" \
               --query 'ContentLength' --output text 2>/dev/null || echo "0")"
if [ "$REMOTE_SIZE" != "$DUMP_SIZE" ]; then
  fail "remote size ($REMOTE_SIZE) != local size ($DUMP_SIZE) — upload may be corrupt" 2
fi
log "Upload OK (remote size verified: ${REMOTE_SIZE}B)"

# -------- 3. Rotate remote backups older than RETENTION_DAYS --------
CUTOFF_DATE="$(date -u --date="${RETENTION_DAYS} days ago" +%Y-%m-%d)"
log "Rotating remote backups older than ${CUTOFF_DATE} (retention: ${RETENTION_DAYS} days)"

# Strict less-than (not <=) on the cutoff instant so a backup uploaded at
# exactly midnight on the cutoff date isn't clipped. Cutoff date is already
# RETENTION_DAYS days in the past; the comparison is to the START of that day.
OLD_KEYS="$(aws --profile "$AWS_PROFILE" --endpoint-url "$S3_ENDPOINT" \
            s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "daily/" \
            --query "Contents[?LastModified<'${CUTOFF_DATE}T00:00:00Z'].Key" \
            --output text 2>/dev/null || true)"

if [ -n "${OLD_KEYS:-}" ] && [ "$OLD_KEYS" != "None" ]; then
  for key in $OLD_KEYS; do
    if aws --profile "$AWS_PROFILE" --endpoint-url "$S3_ENDPOINT" \
         s3 rm "s3://${S3_BUCKET}/${key}" --only-show-errors 2>/dev/null; then
      log "Rotated: $key"
    else
      log "WARN: failed to delete $key (continuing)"
    fi
  done
else
  log "No old remote backups to rotate"
fi

# -------- 4. Local cleanup — keep last 3 only --------
find "$BACKUP_DIR" -maxdepth 1 -name "fleet-prod-*.dump" -type f -printf '%T@ %p\n' 2>/dev/null \
  | sort -n | head -n -3 | awk '{print $2}' | xargs -r rm -f

log "Done (size=${DUMP_SIZE}B, key=${S3_KEY})"
exit 0
