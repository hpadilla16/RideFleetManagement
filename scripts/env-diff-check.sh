#!/usr/bin/env bash
# env-diff-check.sh — pre-deploy env KEY-NAME parity check (names only, never values).
#
# WHY: catches the class of bug where a new var was added to backend/.env.example
# but never set in the production droplet's backend/.env. That exact gap already
# caused a 500 on Supabase Storage uploads (a SUPABASE_* key missing in prod).
#
# WHAT IT DOES: compares the KEY NAMES in a local .env.example against the KEY
# NAMES present in prod, and FAILS (exit 1) if any example key is missing. It
# compares ONLY key names — it never reads, prints, transmits, or logs a VALUE.
#
# Prod key names are gathered from BOTH the droplet's backend/.env FILE and the
# running container's printenv, unioned. Reading the FILE is what makes this a
# correct PRE-deploy check: a var you just appended to backend/.env is present
# in the file (and will load on the next recreate) even though the still-running
# container's printenv doesn't show it yet. Reading the container too means vars
# injected via docker-compose `environment:` (not the .env file) don't false-flag.
#
# SECURITY / SSH MODEL:
#   The repo ships a RESTRICTED ssh key at ops/.agent-ssh/ride-log-agent, but that
#   key is forced-command = LOG DUMP ONLY (see ops/droplet-setup-log-agent.sh). It
#   CANNOT run arbitrary commands, so it CANNOT read the prod .env. This check is
#   therefore meant to run FROM THE DEPLOYER'S MACHINE using their normal, fully
#   authorized droplet access (root@ridefleetmanager.com).
#
#   The remote command pulls KEY NAMES ONLY. It runs inside the prod backend
#   container and lists env var names via `printenv` piped through a name-only
#   filter — the values never leave the container, never cross the wire, and are
#   never printed locally.
#
# USAGE:
#   scripts/env-diff-check.sh [path-to-.env.example]
#   ENV_EXAMPLE=backend/.env.example DROPLET_HOST=root@ridefleetmanager.com \
#     PROD_CONTAINER=fleet-backend-prod scripts/env-diff-check.sh
#
# OVERRIDABLE via env vars (defaults shown):
#   ENV_EXAMPLE     = backend/.env.example   (or pass as $1)
#   DROPLET_HOST    = root@ridefleetmanager.com
#   PROD_CONTAINER  = fleet-backend-prod
#   DROPLET_ENV     = ~/RideFleetManagement/backend/.env   (prod env file path)
#   SSH_OPTS        = -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new
#
# EXIT CODES:
#   0 = every key in .env.example is present in the droplet env.
#   1 = one or more keys are missing in prod, OR the droplet was unreachable
#       (we fail closed on purpose so the deploy stops and a human checks).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ENV_EXAMPLE="${1:-${ENV_EXAMPLE:-backend/.env.example}}"
DROPLET_HOST="${DROPLET_HOST:-root@ridefleetmanager.com}"
PROD_CONTAINER="${PROD_CONTAINER:-fleet-backend-prod}"
DROPLET_ENV="${DROPLET_ENV:-~/RideFleetManagement/backend/.env}"
SSH_OPTS="${SSH_OPTS:--o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new}"

# Resolve the example path relative to the repo root if it isn't absolute.
case "$ENV_EXAMPLE" in
  /*) : ;;
  *)  ENV_EXAMPLE="$REPO_ROOT/$ENV_EXAMPLE" ;;
esac

if [ ! -f "$ENV_EXAMPLE" ]; then
  echo "ERROR: .env.example not found at: $ENV_EXAMPLE" >&2
  exit 1
fi

# Name-only extraction: take lines like  FOO_BAR=...  -> emit  FOO_BAR.
# Never captures or prints the value side of the '='.
extract_keys() {
  grep -oE '^[A-Z0-9_]+=' | sed 's/=$//' | sort -u
}

# --- Local example keys (names only) -----------------------------------------
EXAMPLE_KEYS="$(extract_keys < "$ENV_EXAMPLE" || true)"
if [ -z "$EXAMPLE_KEYS" ]; then
  echo "ERROR: no KEY= lines found in $ENV_EXAMPLE — nothing to check." >&2
  exit 1
fi

# --- Droplet keys (names only, over SSH) -------------------------------------
# We gather KEY NAMES from the prod backend/.env FILE *and* the running
# container's printenv, then strip values REMOTELY with `cut -d= -f1` so only
# NAMES ever travel back over the wire. Reading the .env file makes this a
# correct pre-deploy check (newly-appended vars show up before any recreate);
# reading the container avoids false-flagging vars injected via compose
# `environment:`. If ssh fails (unreachable, auth, container down) we fail
# closed below.
echo "Reading droplet env KEY NAMES from $DROPLET_HOST (.env file + $PROD_CONTAINER)..." >&2
echo "(names only — no secret values are read, transmitted, or printed)" >&2

# Union of: backend/.env file keys  +  container printenv keys. Both are
# value-stripped on the remote side. The .env read is best-effort (the file
# may legitimately not exist if all env comes from compose), so its failure is
# swallowed; the overall command still succeeds as long as printenv works.
REMOTE_CMD="{ cat ${DROPLET_ENV} 2>/dev/null | grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z0-9_]+=' | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//'; docker exec ${PROD_CONTAINER} printenv 2>/dev/null; } | cut -d= -f1"

set +e
# shellcheck disable=SC2086
DROPLET_RAW="$(ssh $SSH_OPTS "$DROPLET_HOST" "$REMOTE_CMD" 2>/dev/null)"
SSH_RC=$?
set -e

if [ "$SSH_RC" -ne 0 ] || [ -z "$DROPLET_RAW" ]; then
  echo "" >&2
  echo "WARNING: could not read env key names from the droplet (ssh rc=$SSH_RC)." >&2
  echo "  Host:      $DROPLET_HOST" >&2
  echo "  Container: $PROD_CONTAINER" >&2
  echo "  This may mean: droplet unreachable, not authorized from this machine," >&2
  echo "  the container is down, or docker exec is unavailable." >&2
  echo "  NOTE: the restricted ops/.agent-ssh/ride-log-agent key CANNOT run this —" >&2
  echo "  run from the deployer's machine with normal droplet access." >&2
  echo "  Failing closed so the deploy STOPS and a human verifies env parity." >&2
  exit 1
fi

# Droplet names: container env has lots of names; we only care whether each
# EXAMPLE key exists there. Normalize to one-name-per-line, sorted+unique.
DROPLET_KEYS="$(printf '%s\n' "$DROPLET_RAW" | grep -E '^[A-Z0-9_]+$' | sort -u || true)"

# --- Diff: example keys MISSING from droplet ---------------------------------
# comm -23 = lines only in the first (example) set, i.e. present in example but
# absent in droplet. Both inputs are name-only and already sorted.
MISSING="$(comm -23 \
  <(printf '%s\n' "$EXAMPLE_KEYS") \
  <(printf '%s\n' "$DROPLET_KEYS") || true)"

if [ -n "$MISSING" ]; then
  echo "" >&2
  echo "FAIL: keys present in $(basename "$ENV_EXAMPLE") but MISSING in the droplet .env:" >&2
  printf '  - %s\n' $MISSING >&2
  echo "" >&2
  echo "Set these on the droplet (backend/.env) BEFORE deploying, then re-run." >&2
  exit 1
fi

echo "OK: all $(printf '%s\n' "$EXAMPLE_KEYS" | wc -l | tr -d ' ') example keys are present in the droplet env." >&2
exit 0
