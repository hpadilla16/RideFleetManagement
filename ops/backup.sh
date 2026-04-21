#!/usr/bin/env bash
#
# ops/backup.sh — Automated Postgres backup to DigitalOcean Spaces.
#
# Usage (on the droplet):
#   /root/RideFleetManagement/ops/backup.sh
#
# Typical cron entry (edit with `crontab -e` as root):
#   0 2 * * *  /root/RideFleetManagement/ops/backup.sh >> /var/log/ridefleet-backup.log 2>&1
#
# Required:
#   - awscli v1 or v2 installed and on PATH (`apt install awscli` or awscliv2)
#   - an AWS profile (default: `digitalocean`) pointing at DO Spaces with
#     credentials saved via `aws configure --profile digitalocean`
#   - docker + docker-compose available; the prod stack running
#
# See `docs/operations/backup-runbook.md` for setup + restore operator flow.
#
# Exit codes:
#   0  success
#   1  pg_dump failed or preflight check failed
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
: "${DB_CONTAINER:=fleet-db-prod}"
: "${DB_NAME:=fleet_management}"
: "${DB_USER:=postgres}"
: "${RETENTION_DAYS:=30}"
: "${REPO_DIR:=/root/RideFleetManagement}"

# -------- Helpers --------
log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }
fail() { log "FAIL: $*"; exit "${2:-1}"; }

# -------- Preflight --------
command -v aws >/dev/null 2>&1 || fail "awscli not installed" 1
command -v docker >/dev/null 2>&1 || fail "docker not available" 1
mkdir -p "$BACKUP_DIR"

# -------- 1. pg_dump --------
TIMESTAMP="$(date -u +%Y-%m-%d-%H%M%S)"
DUMP_FILE="$BACKUP_DIR/fleet-prod-${TIMESTAMP}.dump"

log "Starting pg_dump → $DUMP_FILE"
cd "$REPO_DIR"
if ! docker compose -f docker-compose.prod.yml exec -T db \
     pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$DUMP_FILE"; then
  fail "pg_dump failed (container: $DB_CONTAINER, db: $DB_NAME)" 1
fi

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
log "Upload OK"

# -------- 3. Rotate remote backups older than RETENTION_DAYS --------
CUTOFF_DATE="$(date -u --date="${RETENTION_DAYS} days ago" +%Y-%m-%d)"
log "Rotating remote backups older than ${CUTOFF_DATE} (retention: ${RETENTION_DAYS} days)"

OLD_KEYS="$(aws --profile "$AWS_PROFILE" --endpoint-url "$S3_ENDPOINT" \
            s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "daily/" \
            --query "Contents[?LastModified<='${CUTOFF_DATE}T00:00:00Z'].Key" \
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
