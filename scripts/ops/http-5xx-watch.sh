#!/usr/bin/env bash
# Watch nginx for a sustained 5xx burst and tell a human.
#
# WHY THIS EXISTS (2026-08-08): DigitalOcean maintenance on the managed Redis
# left the rate limiter's ioredis client hung, every tenant request stalled,
# and nginx returned 1,176 × 504 over two hours. Nobody was paged. Hector
# found out because users complained.
#
# The container healthcheck could not have caught it: /health returned 200
# THROUGHOUT — it does not pass through the rate limiter, exactly like the
# SUPER_ADMIN bypass that made the outage look selective. The only place the
# truth was visible was the nginx access log, so that is what this reads.
#
# Deliberately dumb: no metrics stack, no agent. A shell script and cron have
# no dependency that can be down at the same time as the thing they watch.
#
# Usage:  ./http-5xx-watch.sh [--dry-run]
# Cron:   */5 * * * *  /root/RideFleetManagement/scripts/ops/http-5xx-watch.sh
#
# Exits non-zero when the threshold is breached, so the run is visibly failed
# even if the email cannot be sent.
set -uo pipefail

ACCESS_LOG="${ACCESS_LOG:-/var/log/nginx/access.log}"
STATE_DIR="${STATE_DIR:-/var/lib/ridefleet-5xx-watch}"
ENV_FILE="${ENV_FILE:-/root/RideFleetManagement/backend/.env}"
# A handful of 5xx is ordinary (a bad request, a restart). A sustained burst is
# not. The incident ran ~10 per minute for two hours.
THRESHOLD="${THRESHOLD:-15}"
# Don't re-send every 5 minutes for the whole outage — one alert, then quiet
# until it clears or this long passes.
RENOTIFY_MINUTES="${RENOTIFY_MINUTES:-60}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { echo "[5xx-watch] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

[ -r "$ACCESS_LOG" ] || { log "cannot read $ACCESS_LOG"; exit 0; }
mkdir -p "$STATE_DIR"
POS_FILE="$STATE_DIR/position"
LAST_ALERT_FILE="$STATE_DIR/last-alert"

# Read only what is NEW since the last run. Tracking the inode as well as the
# line count means a logrotate mid-window restarts cleanly instead of silently
# skipping an entire log file's worth of errors.
INODE="$(stat -c %i "$ACCESS_LOG" 2>/dev/null || echo 0)"
TOTAL="$(wc -l < "$ACCESS_LOG" 2>/dev/null || echo 0)"
PREV_INODE=0; PREV_LINES=0
COLD_START=0
if [ -f "$POS_FILE" ]; then
  read -r PREV_INODE PREV_LINES < "$POS_FILE" 2>/dev/null || true
else
  # Cold start: with no position, the whole file is "new" and the run would
  # alert on history. Tested on install — the first pass saw 859 errors, all of
  # them from an outage that ended hours earlier. Record where we are and say
  # nothing; the next run reports only what happened since.
  COLD_START=1
fi
[ "$INODE" = "$PREV_INODE" ] || PREV_LINES=0          # rotated
[ "$TOTAL" -ge "$PREV_LINES" ] || PREV_LINES=0        # truncated
echo "$INODE $TOTAL" > "$POS_FILE"

if [ "$COLD_START" -eq 1 ]; then
  log "first run — baseline recorded at line $TOTAL, not alerting on history"
  exit 0
fi

NEW=$((TOTAL - PREV_LINES))
[ "$NEW" -gt 0 ] || { log "no new requests"; exit 0; }

WINDOW="$(tail -n "$NEW" "$ACCESS_LOG")"
# 502/503/504 only. A 500 is usually one broken handler; these three mean the
# app is unreachable, which is the outage shape worth waking someone for.
COUNT="$(printf '%s\n' "$WINDOW" | awk '$9 ~ /^50[234]$/' | wc -l | tr -d ' ')"
log "$NEW new requests, $COUNT were 502/503/504 (threshold $THRESHOLD)"

if [ "$COUNT" -lt "$THRESHOLD" ]; then
  rm -f "$LAST_ALERT_FILE"     # cleared — the next burst alerts immediately
  exit 0
fi

TOP="$(printf '%s\n' "$WINDOW" | awk '$9 ~ /^50[234]$/ {print $9, $7}' | sort | uniq -c | sort -rn | head -8)"
SUBJECT="RFM: ${COUNT} gateway errors in the last few minutes"
BODY="nginx returned ${COUNT} × 502/503/504 out of ${NEW} requests on $(hostname).

Most affected:
${TOP}

The container healthcheck does NOT catch this — /health bypasses the rate
limiter and answered 200 through the entire 2026-08-08 outage. Check whether
requests are stalling before they reach Postgres:

  docker logs --since 10m fleet-backend-prod | tail -50
  docker compose -f docker-compose.prod.yml restart backend worker

Sent by scripts/ops/http-5xx-watch.sh"

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY RUN — would alert:"; printf '%s\n%s\n' "$SUBJECT" "$BODY"; exit 1
fi

# Quiet period, so a two-hour outage sends one email and not twenty-four.
if [ -f "$LAST_ALERT_FILE" ]; then
  AGE_MIN=$(( ( $(date +%s) - $(stat -c %Y "$LAST_ALERT_FILE") ) / 60 ))
  if [ "$AGE_MIN" -lt "$RENOTIFY_MINUTES" ]; then
    log "already alerted ${AGE_MIN}m ago — staying quiet"; exit 1
  fi
fi

# Credentials come from the backend's own env; no second copy to drift.
TO="${OPS_ALERT_EMAIL:-$(grep -E '^OPS_ALERT_EMAIL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)}"
KEY="$(grep -E '^MAILERSEND_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
FROM="$(grep -E '^MAILERSEND_FROM=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"

if [ -z "$TO" ] || [ -z "$KEY" ] || [ -z "$FROM" ]; then
  log "ALERT NOT SENT — set OPS_ALERT_EMAIL in $ENV_FILE (MailerSend key/from must also be present)"
  printf '%s\n%s\n' "$SUBJECT" "$BODY"
  exit 1
fi

HTTP="$(curl -s -o /tmp/5xx-watch-resp -w '%{http_code}' -X POST https://api.mailersend.com/v1/email \
  -H "Authorization: Bearer ${KEY}" -H 'Content-Type: application/json' \
  --data "$(python3 - "$FROM" "$TO" "$SUBJECT" "$BODY" <<'PY'
import json, sys
frm, to, subject, body = sys.argv[1:5]
print(json.dumps({
    "from": {"email": frm, "name": "RFM Ops"},
    "to": [{"email": to}],
    "subject": subject,
    "text": body,
}))
PY
)")"

if [ "$HTTP" = "202" ] || [ "$HTTP" = "200" ]; then
  touch "$LAST_ALERT_FILE"; log "alert sent to $TO"
else
  log "alert send FAILED (http $HTTP): $(head -c 300 /tmp/5xx-watch-resp 2>/dev/null)"
fi
exit 1
