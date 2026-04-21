#!/usr/bin/env bash
#
# ops/restore.sh — Restore a Postgres backup from DigitalOcean Spaces into a
# target database on the droplet's Postgres container.
#
# Usage (on the droplet):
#   ops/restore.sh <s3-dump-key> <target-db>
#   ops/restore.sh daily/fleet-prod-2026-04-21-020000.dump fleet_scratch
#
# Intended for scratch / staging / DR-rehearsal use. By default, this script
# REFUSES to restore into the production database name `fleet_management`;
# override with `FORCE_RESTORE_PROD=yes` only after confirming the production
# DB is already corrupted or gone and you've taken a fresh backup of its
# current state first.
#
# See `docs/operations/backup-runbook.md` for the operator procedure
# (including the required 5-minute "are you sure" ceremony before restoring
# into production).
#
# Wave 1, Item 1.1 of the production-readiness plan.

set -euo pipefail

# Ensure `aws` via snap (/snap/bin/) is on PATH even in minimal environments.
export PATH="/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

if [ $# -lt 2 ]; then
  cat <<'USAGE' >&2
Usage: ops/restore.sh <s3-dump-key> <target-db>

  <s3-dump-key>   S3 key within the backup bucket (e.g., daily/fleet-prod-2026-04-21-020000.dump)
  <target-db>     Postgres database name to restore INTO (will be DROPPED and recreated)

Examples:
  ops/restore.sh daily/fleet-prod-2026-04-21-020000.dump fleet_scratch
  ops/restore.sh daily/fleet-prod-2026-04-21-020000.dump fleet_staging

List available backups:
  aws --profile digitalocean --endpoint-url https://nyc3.digitaloceanspaces.com s3 ls s3://ridefleet-backup/daily/
USAGE
  exit 1
fi

DUMP_KEY="$1"
TARGET_DB="$2"

: "${S3_BUCKET:=ridefleet-backup}"
: "${S3_ENDPOINT:=https://nyc3.digitaloceanspaces.com}"
: "${AWS_PROFILE:=digitalocean}"
: "${DB_USER:=postgres}"
: "${REPO_DIR:=/root/RideFleetManagement}"
: "${WORK_DIR:=/var/backups/ridefleet/restore}"

log() { echo "[restore] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

# -------- Safety: refuse production DB unless explicitly forced --------
if [ "$TARGET_DB" = "fleet_management" ]; then
  if [ "${FORCE_RESTORE_PROD:-no}" != "yes" ]; then
    cat <<'SAFETY' >&2
REFUSING to restore into the production database `fleet_management`.

This would DROP and recreate the live DB. Before proceeding, confirm:
  1. You have a fresh backup of the current (even corrupt) state
  2. You have coordinated with the team / posted a status
  3. You know the exact dump key you want to restore from
  4. You've rehearsed this restore in a scratch DB first

If all four are true, re-run with FORCE_RESTORE_PROD=yes:
  FORCE_RESTORE_PROD=yes ops/restore.sh <dump-key> fleet_management
SAFETY
    exit 1
  fi
  log "WARNING: FORCE_RESTORE_PROD=yes supplied — proceeding with production restore"
fi

# -------- Preflight --------
command -v aws >/dev/null 2>&1 || fail "awscli not installed"
command -v docker >/dev/null 2>&1 || fail "docker not available"
mkdir -p "$WORK_DIR"

# -------- 1. Download dump from DO Spaces --------
LOCAL_DUMP="$WORK_DIR/$(basename "$DUMP_KEY")"
log "Downloading s3://${S3_BUCKET}/${DUMP_KEY} → $LOCAL_DUMP"
aws --profile "$AWS_PROFILE" --endpoint-url "$S3_ENDPOINT" \
    s3 cp "s3://${S3_BUCKET}/${DUMP_KEY}" "$LOCAL_DUMP" --only-show-errors \
    || fail "download failed (check the key exists: aws s3 ls s3://${S3_BUCKET}/daily/)"

DUMP_SIZE="$(stat -c%s "$LOCAL_DUMP")"
log "Download OK (${DUMP_SIZE} bytes)"

# -------- 2. Drop + recreate target DB --------
cd "$REPO_DIR"
log "Dropping and recreating database '$TARGET_DB'"
docker compose -f docker-compose.prod.yml exec -T db \
    psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"${TARGET_DB}\";" \
    || fail "DROP DATABASE failed"
docker compose -f docker-compose.prod.yml exec -T db \
    psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"${TARGET_DB}\";" \
    || fail "CREATE DATABASE failed"

# -------- 3. pg_restore --------
log "Running pg_restore into '$TARGET_DB' (this may take a while)"
if ! docker compose -f docker-compose.prod.yml exec -T db \
       pg_restore -U "$DB_USER" -d "$TARGET_DB" --no-owner --no-privileges \
       < "$LOCAL_DUMP"; then
  log "WARN: pg_restore returned non-zero (often OK for --no-owner); verifying table count"
fi

# -------- 4. Verify --------
TABLE_COUNT="$(docker compose -f docker-compose.prod.yml exec -T db \
               psql -U "$DB_USER" -d "$TARGET_DB" -tAc \
               "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" \
               | tr -d '[:space:]')"

log "Restore complete — ${TABLE_COUNT} tables in '$TARGET_DB'"
log "Verify manually: docker compose -f docker-compose.prod.yml exec db psql -U ${DB_USER} -d ${TARGET_DB} -c '\\dt'"
exit 0
