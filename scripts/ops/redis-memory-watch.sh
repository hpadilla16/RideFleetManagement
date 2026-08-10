#!/usr/bin/env bash
# Warn before Redis runs out of room.
#
# WHY THIS EXISTS (2026-08-10): the managed Redis was configured
# `allkeys-lru`, which under memory pressure DELETES keys to make space. Nearly
# everything in there is BullMQ — 440 of 441 keys, and 393 of the first 400
# sampled have no expiry — so "make space" meant silently dropping queued jobs,
# including reservation.autocharge-after-checkin. Money work could vanish with
# no error and no trace.
#
# The fix is `noeviction`, which turns that silent loss into a loud write
# failure. That is strictly better, but it moves the failure to a new place: if
# Redis ever DOES fill, enqueues start erroring. So the ceiling now needs
# watching, which nothing did.
#
# Headroom is large today — 10.7 MB of 418 MB, peak 10.8 MB, with BullMQ
# retention already capping history (completed 24h/1000, failed 7d). This is a
# tripwire, not a daily concern.
#
# Usage:  ./redis-memory-watch.sh [--dry-run]
# Cron:   */15 * * * *  /root/RideFleetManagement/scripts/ops/redis-memory-watch.sh
set -uo pipefail

CONTAINER="${CONTAINER:-fleet-backend-prod}"
THRESHOLD_PCT="${THRESHOLD_PCT:-70}"
ALERT="${ALERT:-/root/RideFleetManagement/scripts/ops/ops-alert.sh}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { echo "[redis-mem] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

# Read through the app's own container so the credentials live in exactly one
# place. Bounded, because a watcher that hangs is a watcher that is not
# watching — the same lesson as the outage it descends from.
READING="$(timeout 30 docker exec "$CONTAINER" node -e '
const IORedis = require("ioredis");
const c = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
c.connect().then(async () => {
  const m = await c.info("memory");
  const g = (k) => (m.split("\n").find((l) => l.startsWith(k + ":")) || "").split(":")[1]?.trim();
  console.log([g("used_memory"), g("maxmemory"), g("maxmemory_policy"), g("used_memory_human"), g("maxmemory_human")].join("|"));
  await c.quit(); process.exit(0);
}).catch((e) => { console.error("ERR " + e.message); process.exit(1); });
' 2>/dev/null)"

if [ -z "$READING" ]; then
  log "could not read Redis (container down, or Redis unreachable)"
  exit 0    # the 5xx watcher owns "the app is broken"; this one only owns memory
fi

USED="$(echo "$READING" | cut -d'|' -f1)"
MAX="$(echo "$READING" | cut -d'|' -f2)"
POLICY="$(echo "$READING" | cut -d'|' -f3)"
USED_H="$(echo "$READING" | cut -d'|' -f4)"
MAX_H="$(echo "$READING" | cut -d'|' -f5)"

if [ -z "$MAX" ] || [ "$MAX" -le 0 ] 2>/dev/null; then
  log "no maxmemory set — nothing to be full of ($USED_H used, policy $POLICY)"
  exit 0
fi
PCT=$(( USED * 100 / MAX ))
log "$USED_H of $MAX_H (${PCT}%), policy=$POLICY"

# Two different concerns, deliberately alerted apart.
#
# Memory filling is an INCIDENT: it escalates within hours, so it renotifies
# hourly. A wrong eviction policy is CONFIG DRIFT: it is equally real but it
# does not get worse by the hour, and mailing about it every sixty minutes
# until someone opens a control panel is how an alert address learns to be
# ignored. Once a day is enough to keep it from being forgotten.
if [ "$PCT" -ge "$THRESHOLD_PCT" ]; then
  BODY="Redis is at ${PCT}% of its memory ($USED_H of $MAX_H), policy=$POLICY.

  noeviction   -> writes will start FAILING when it fills. Enqueues error out;
                  autocharge falls back to the manual workflow.
  allkeys-lru  -> keys are being DELETED to make room. Queued jobs can vanish
                  silently.

Nearly all of it is BullMQ. Check what grew:
  docker exec $CONTAINER node -e \"const R=require('ioredis');const c=new R(process.env.REDIS_URL);c.dbsize().then(n=>{console.log(n);c.quit()})\"
"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY RUN — would alert (memory):"; printf '%s
' "$BODY"
  else
    "$ALERT" redis-memory "RFM: Redis at ${PCT}% of memory" "$BODY"
  fi
  FIRED=1
fi

if [ "$POLICY" != "noeviction" ]; then
  BODY="Redis eviction policy is '$POLICY', not 'noeviction'.

Under memory pressure this DELETES queued jobs instead of refusing new ones.
Nearly everything in Redis is BullMQ, so that means jobs — autocharge included
— disappearing with no error and no trace.

Change it in the DigitalOcean panel:
  Databases -> the Redis cluster -> Settings -> Eviction policy -> noeviction

It cannot be set from a shell: the CONFIG command is disabled on managed
instances. This check is also how you confirm the change landed — once the
policy is noeviction, this alert stops on its own.

Currently $USED_H of $MAX_H (${PCT}%), so there is no urgency, only drift.
"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY RUN — would alert (policy):"; printf '%s
' "$BODY"
  else
    RENOTIFY_MINUTES=1440 "$ALERT" redis-policy "RFM: Redis eviction policy is '$POLICY'" "$BODY"
  fi
  FIRED=1
fi

[ "${FIRED:-0}" -eq 1 ] && exit 1
exit 0
