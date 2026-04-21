#!/usr/bin/env bash
#
# ops/restore.sh — Restore-rehearsal: download a backup from DigitalOcean
# Spaces and load it into a throwaway Postgres 17 container so you can verify
# the backup is actually restorable + has expected row counts.
#
# This is NOT a production restore script. Production data lives on Supabase
# (managed); to recover into Supabase you'd coordinate with Supabase support
# or use their dashboard. This script proves that OUR pg_dump output is valid
# and loadable — a monthly rehearsal per backup-runbook.md.
#
# Usage (on the droplet):
#   ops/restore.sh <s3-dump-key>
#   ops/restore.sh daily/fleet-prod-2026-04-21-171949.dump
#
# Side effects:
#   - Creates a throwaway docker container named `fleet-db-scratch` on port 5433
#   - Populates `fleet_scratch` database inside it from the downloaded dump
#   - LEAVES THE CONTAINER RUNNING so you can inspect; clean up manually when done:
#     docker rm -f fleet-db-scratch
#
# Wave 1, Item 1.1 of the production-readiness plan
# (see docs/operations/production-readiness-plan-2026-04-20.md).

set -euo pipefail

# Ensure `aws` via snap (/snap/bin/) is on PATH even in minimal environments.
export PATH="/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

if [ $# -lt 1 ]; then
  cat <<'USAGE' >&2
Usage: ops/restore.sh <s3-dump-key>

Downloads the dump from DO Spaces, starts a throwaway postgres:17-alpine
container named `fleet-db-scratch`, restores the dump into a `fleet_scratch`
database, prints table + row counts so you can verify the restore worked.

Examples:
  ops/restore.sh daily/fleet-prod-2026-04-21-171949.dump

List available backups:
  aws --profile digitalocean --endpoint-url https://nyc3.digitaloceanspaces.com s3 ls s3://ridefleet-backup/daily/

When done inspecting:
  docker rm -f fleet-db-scratch
USAGE
  exit 1
fi

DUMP_KEY="$1"

: "${S3_BUCKET:=ridefleet-backup}"
: "${S3_ENDPOINT:=https://nyc3.digitaloceanspaces.com}"
: "${AWS_PROFILE:=digitalocean}"
: "${SCRATCH_DB:=fleet_scratch}"
: "${SCRATCH_CONTAINER:=fleet-db-scratch}"
: "${SCRATCH_PG_IMAGE:=postgres:17-alpine}"
: "${SCRATCH_PASSWORD:=scratch}"
: "${WORK_DIR:=/var/backups/ridefleet/restore}"

log() { echo "[restore] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

# -------- Preflight --------
command -v aws >/dev/null 2>&1 || fail "awscli not installed (snap install aws-cli --classic)"
command -v docker >/dev/null 2>&1 || fail "docker not available"
mkdir -p "$WORK_DIR"

# -------- 1. Download dump from DO Spaces --------
LOCAL_DUMP="$WORK_DIR/$(basename "$DUMP_KEY")"
log "Downloading s3://${S3_BUCKET}/${DUMP_KEY} → $LOCAL_DUMP"
aws --profile "$AWS_PROFILE" --endpoint-url "$S3_ENDPOINT" \
    s3 cp "s3://${S3_BUCKET}/${DUMP_KEY}" "$LOCAL_DUMP" --only-show-errors \
    || fail "download failed (check key exists: aws s3 ls s3://${S3_BUCKET}/daily/)"

DUMP_SIZE="$(stat -c%s "$LOCAL_DUMP")"
log "Download OK (${DUMP_SIZE} bytes)"

# -------- 2. (Re)start scratch container --------
if docker ps -a --format '{{.Names}}' | grep -qx "$SCRATCH_CONTAINER"; then
  log "Removing existing $SCRATCH_CONTAINER (idempotent re-run)"
  docker rm -f "$SCRATCH_CONTAINER" >/dev/null
fi

log "Starting scratch Postgres ($SCRATCH_PG_IMAGE) as $SCRATCH_CONTAINER"
docker run -d \
  --name "$SCRATCH_CONTAINER" \
  -e "POSTGRES_PASSWORD=$SCRATCH_PASSWORD" \
  -e "POSTGRES_DB=$SCRATCH_DB" \
  "$SCRATCH_PG_IMAGE" \
  >/dev/null || fail "could not start scratch container"

# -------- 3. Wait for container to accept connections --------
log "Waiting for Postgres to accept connections..."
READY=""
for _ in $(seq 1 30); do
  if docker exec "$SCRATCH_CONTAINER" pg_isready -U postgres -d "$SCRATCH_DB" >/dev/null 2>&1; then
    READY="yes"
    break
  fi
  sleep 1
done
[ -n "$READY" ] || fail "scratch Postgres never became ready (check: docker logs $SCRATCH_CONTAINER)"
log "Scratch Postgres ready"

# -------- 4. Copy dump into container + pg_restore --------
log "Copying dump into container"
docker cp "$LOCAL_DUMP" "$SCRATCH_CONTAINER":/tmp/dump.bin

log "Running pg_restore into $SCRATCH_DB (this may take a minute)"
if ! docker exec "$SCRATCH_CONTAINER" pg_restore \
       -U postgres -d "$SCRATCH_DB" \
       --no-owner --no-privileges --clean --if-exists \
       /tmp/dump.bin 2>&1 | tail -20; then
  log "WARN: pg_restore returned non-zero (often only warnings — verifying via queries)"
fi

# -------- 5. Verify via queries --------
TABLE_COUNT="$(docker exec "$SCRATCH_CONTAINER" psql -U postgres -d "$SCRATCH_DB" -tAc \
               "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" \
               2>/dev/null | tr -d '[:space:]')"

if [ -z "$TABLE_COUNT" ] || [ "$TABLE_COUNT" = "0" ]; then
  fail "restore produced 0 tables — dump may be broken; inspect: docker logs $SCRATCH_CONTAINER"
fi

log "Restore complete — $TABLE_COUNT tables in $SCRATCH_DB"

log "Sample row counts (non-fatal if some tables missing):"
docker exec "$SCRATCH_CONTAINER" psql -U postgres -d "$SCRATCH_DB" -P pager=off -c "
  SELECT 'Tenant'                    AS t, COUNT(*) FROM \"Tenant\"
  UNION ALL SELECT 'Reservation'     AS t, COUNT(*) FROM \"Reservation\"
  UNION ALL SELECT 'RentalAgreement' AS t, COUNT(*) FROM \"RentalAgreement\"
  UNION ALL SELECT 'Vehicle'         AS t, COUNT(*) FROM \"Vehicle\"
  UNION ALL SELECT 'Customer'        AS t, COUNT(*) FROM \"Customer\";
" 2>/dev/null || log "WARN: some tables not found; run \\dt to inspect"

log ""
log "Scratch container LEFT RUNNING for inspection."
log "  Inspect:   docker exec -it $SCRATCH_CONTAINER psql -U postgres -d $SCRATCH_DB"
log "  Clean up:  docker rm -f $SCRATCH_CONTAINER"
exit 0
