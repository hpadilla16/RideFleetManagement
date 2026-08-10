#!/usr/bin/env bash
# Send an ops alert, once, to whoever OPS_ALERT_EMAIL names.
#
# Extracted from http-5xx-watch.sh when a second watcher needed the same thing
# (2026-08-10). Two copies of a notification path drift in the worst possible
# way: the one nobody tested is the one that stays silent during an incident.
#
# Usage:  ops-alert.sh <key> <subject> <body>
#   key   groups the quiet period. Different keys alert independently, so a
#         Redis warning is never swallowed because a 5xx alert went out first.
#
# Reads MAILERSEND_API_KEY / MAILERSEND_FROM / OPS_ALERT_EMAIL from the
# backend's own .env — no second copy of the credentials to fall out of date.
#
# Exit codes: 0 sent, 1 suppressed by the quiet period, 2 could not send.
# Says loudly when it cannot send rather than failing quiet, which would
# recreate the exact problem these watchers exist to solve.
set -uo pipefail

KEY="${1:?usage: ops-alert.sh <key> <subject> <body>}"
SUBJECT="${2:?subject required}"
BODY="${3:?body required}"

ENV_FILE="${ENV_FILE:-/root/RideFleetManagement/backend/.env}"
STATE_DIR="${STATE_DIR:-/var/lib/ridefleet-ops-alerts}"
RENOTIFY_MINUTES="${RENOTIFY_MINUTES:-60}"

log() { echo "[ops-alert:$KEY] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }
mkdir -p "$STATE_DIR"
LAST="$STATE_DIR/$KEY.last"

if [ -f "$LAST" ]; then
  AGE_MIN=$(( ( $(date +%s) - $(stat -c %Y "$LAST") ) / 60 ))
  if [ "$AGE_MIN" -lt "$RENOTIFY_MINUTES" ]; then
    log "already alerted ${AGE_MIN}m ago — staying quiet"
    exit 1
  fi
fi

TO="${OPS_ALERT_EMAIL:-$(grep -E '^OPS_ALERT_EMAIL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)}"
API_KEY="$(grep -E '^MAILERSEND_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
FROM="$(grep -E '^MAILERSEND_FROM=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"

if [ -z "$TO" ] || [ -z "$API_KEY" ] || [ -z "$FROM" ]; then
  log "ALERT NOT SENT — set OPS_ALERT_EMAIL in $ENV_FILE (MailerSend key/from must also be present)"
  printf '%s\n%s\n' "$SUBJECT" "$BODY"
  exit 2
fi

HTTP="$(curl -s -o /tmp/ops-alert-resp -w '%{http_code}' -X POST https://api.mailersend.com/v1/email \
  -H "Authorization: Bearer ${API_KEY}" -H 'Content-Type: application/json' \
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
  touch "$LAST"
  log "sent to $TO"
  exit 0
fi
log "send FAILED (http $HTTP): $(head -c 300 /tmp/ops-alert-resp 2>/dev/null)"
printf '%s\n%s\n' "$SUBJECT" "$BODY"
exit 2
