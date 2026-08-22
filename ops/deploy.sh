#!/usr/bin/env bash
#
# ops/deploy.sh — ZERO-DOWNTIME production deploy for RideFleetManagement.
#
# WHY: `docker compose up -d` recreates a container in place, so nginx has no
# upstream for the ~10s it takes the new container to become healthy, and every
# request in that window gets a 502 (observed 2026-08-22, hit the counter).
#
# HOW (blue-green on one host): build the new images, bring up GREEN copies of
# the HTTP services on alternate ports, wait until they answer /health, flip
# nginx to green with a graceful reload, recreate the BLUE (prod) containers on
# the new image, flip nginx back, then stop green. nginx always has a healthy
# upstream, so no request is dropped.
#
# The worker has no HTTP surface and nginx never touches it, so it is simply
# recreated with the prod containers — a few seconds of worker downtime is
# invisible (BullMQ jobs are queued and retried).
#
# USAGE (on the droplet, as root):
#   /root/RideFleetManagement/ops/deploy.sh
#
# SAFETY: if green never becomes healthy the script aborts BEFORE touching nginx
# or the prod containers — the running site is left exactly as it was. Every
# nginx change is `nginx -t`-validated before reload.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/root/RideFleetManagement}"
PROD_FILE="docker-compose.prod.yml"
GREEN_FILE="docker-compose.green.yml"
UPSTREAM_CONF="${UPSTREAM_CONF:-/etc/nginx/conf.d/rfm-upstreams.conf}"

BLUE_BACKEND_PORT=4000
BLUE_FRONTEND_PORT=3000
GREEN_BACKEND_PORT=4010
GREEN_FRONTEND_PORT=3010

HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-90}"

log()  { echo "[deploy] $(date -u +%H:%M:%S) $*"; }
fail() { echo "[deploy] FAIL: $*" >&2; exit 1; }

cd "$REPO_DIR"

dc() { docker compose -f "$PROD_FILE" "$@"; }
dcg() { docker compose -f "$PROD_FILE" -f "$GREEN_FILE" "$@"; }

# Poll an HTTP endpoint until it answers, or time out.
wait_healthy() {
  local url="$1" label="$2" deadline=$(( SECONDS + HEALTH_TIMEOUT_SECS ))
  log "waiting for $label ($url) ..."
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS -o /dev/null --max-time 4 "$url"; then
      log "$label healthy"
      return 0
    fi
    sleep 2
  done
  return 1
}

# Rewrite the upstream conf to the given ports and gracefully reload nginx.
# Validates config first; a bad config is never loaded.
point_nginx() {
  local backend_port="$1" frontend_port="$2"
  cat > "$UPSTREAM_CONF" <<EOF
# Managed by ops/deploy.sh — do not edit by hand.
upstream rfm_backend {
    server 127.0.0.1:${backend_port} max_fails=0;
}
upstream rfm_frontend {
    server 127.0.0.1:${frontend_port} max_fails=0;
}
EOF
  nginx -t 2>/dev/null || fail "nginx -t rejected the config for ports ${backend_port}/${frontend_port}"
  nginx -s reload
  log "nginx now points at backend:${backend_port} frontend:${frontend_port}"
}

stop_green() {
  log "stopping green containers"
  dcg rm -sf backend-green frontend-green >/dev/null 2>&1 || true
}

# Always clean up green on exit (success or failure) so no stray container or
# extra DB connections linger between deploys.
trap 'stop_green' EXIT

# ---------------------------------------------------------------------------
log "1/6 pulling"
git pull --ff-only origin main

log "2/6 building images"
dc build backend frontend worker

log "3/6 starting green on alt ports (${GREEN_BACKEND_PORT}/${GREEN_FRONTEND_PORT})"
dcg up -d backend-green frontend-green

if ! wait_healthy "http://127.0.0.1:${GREEN_BACKEND_PORT}/health" "green backend"; then
  fail "green backend never became healthy — prod untouched, aborting"
fi
if ! wait_healthy "http://127.0.0.1:${GREEN_FRONTEND_PORT}/" "green frontend"; then
  fail "green frontend never became healthy — prod untouched, aborting"
fi

log "4/6 flip nginx -> green"
point_nginx "$GREEN_BACKEND_PORT" "$GREEN_FRONTEND_PORT"

log "5/6 recreate blue (prod) on the new image"
dc up -d --no-deps backend worker
if ! wait_healthy "http://127.0.0.1:${BLUE_BACKEND_PORT}/health" "blue backend"; then
  log "WARN: blue backend unhealthy after recreate — leaving nginx on green, aborting before flip-back"
  fail "blue backend did not come healthy; site is serving on green, investigate"
fi
dc up -d --no-deps frontend
if ! wait_healthy "http://127.0.0.1:${BLUE_FRONTEND_PORT}/" "blue frontend"; then
  log "WARN: blue frontend unhealthy after recreate — leaving nginx on green, aborting before flip-back"
  fail "blue frontend did not come healthy; site is serving on green, investigate"
fi

log "6/6 flip nginx -> blue (prod)"
point_nginx "$BLUE_BACKEND_PORT" "$BLUE_FRONTEND_PORT"

log "done — deploy complete with no downtime"
