#!/usr/bin/env bash
# Droplet disk maintenance — reclaim Docker build leftovers, then report.
#
# WHY THIS EXISTS (2026-08-03): the production droplet filled to 154G/154G,
# 0 bytes free. Every request that needed to write anything failed at the
# network layer, so the browser showed a bare "Failed to fetch" and NOTHING
# reached the application logs — the server could not even write the log line
# describing its own failure. Cleanup reclaimed 227 GB: 122 GB of buildx cache
# and 105 GB of dangling images, all of it left behind by ordinary deploys.
# Nothing rotates that automatically, so it WILL refill without this.
#
# Safe by construction: only build cache and DANGLING (untagged) images are
# removed, and only when older than PRUNE_UNTIL. Images backing a running
# container are never dangling, so the live stack cannot be pruned out from
# under itself. The worst case is a slower next build.
#
# Usage:  ./droplet-disk-maintenance.sh [--quiet]
# Cron:   0 4 * * 0  /root/RideFleetManagement/scripts/ops/droplet-disk-maintenance.sh
#
# Exits non-zero when usage is still above ALERT_PCT after pruning, so cron
# mails the output / the run shows up as failed instead of passing silently.
set -uo pipefail

PRUNE_UNTIL="${PRUNE_UNTIL:-72h}"   # keep recent layers so rollbacks stay fast
ALERT_PCT="${ALERT_PCT:-80}"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

log() { [ "$QUIET" -eq 1 ] || echo "$@"; }
usage_pct() { df --output=pcent / | tail -1 | tr -dc '0-9'; }
avail_h()   { df -h --output=avail / | tail -1 | tr -d ' '; }

BEFORE_PCT="$(usage_pct)"
log "[disk-maintenance] $(date -u '+%Y-%m-%dT%H:%M:%SZ') start — / at ${BEFORE_PCT}% ($(avail_h) free)"

if ! command -v docker >/dev/null 2>&1; then
  echo "[disk-maintenance] docker not found — nothing to prune" >&2
  exit 0
fi

# Build cache first: it was the single biggest consumer (122 GB).
log "[disk-maintenance] pruning build cache older than ${PRUNE_UNTIL}…"
docker builder prune -af --filter "until=${PRUNE_UNTIL}" 2>&1 | tail -1

# Dangling images only (-a would also drop tagged images that nothing runs
# right now — e.g. the previous release you may want to roll back to).
log "[disk-maintenance] pruning dangling images older than ${PRUNE_UNTIL}…"
docker image prune -f --filter "until=${PRUNE_UNTIL}" 2>&1 | tail -1

# Container logs: json-file has no default rotation, so a chatty container can
# quietly grow tens of GB. Report the offenders rather than truncating logs
# out from under a live debugging session.
BIG_LOGS="$(find /var/lib/docker/containers -name '*-json.log' -size +512M 2>/dev/null || true)"
if [ -n "$BIG_LOGS" ]; then
  echo "[disk-maintenance] WARNING: container logs over 512MB (consider log rotation):"
  # shellcheck disable=SC2086
  du -h $BIG_LOGS 2>/dev/null | sort -rh
fi

AFTER_PCT="$(usage_pct)"
log "[disk-maintenance] done — / at ${AFTER_PCT}% ($(avail_h) free), was ${BEFORE_PCT}%"

if [ "$AFTER_PCT" -ge "$ALERT_PCT" ]; then
  echo "[disk-maintenance] ALERT: / is ${AFTER_PCT}% full (threshold ${ALERT_PCT}%) AFTER pruning." >&2
  echo "[disk-maintenance] Pruning is no longer enough — investigate with:" >&2
  echo "  docker system df ; du -sh /var/lib/docker/* | sort -rh | head" >&2
  exit 1
fi
exit 0
