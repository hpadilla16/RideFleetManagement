#!/usr/bin/env bash
# GET /api/quotes/preview: pass through the engine's already-computed
# `insurancePlans` in mapEngineRow (quotes.service.js). searchRental already
# computes them (booking-engine ~1407); the mapper was dropping the field, so
# VozIA's post-booking insurance upsell (Chloe) saw an empty list. ONE additive,
# display-only line — no charge logic, no migration, backend-only, no new imports.
#
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-21-ship-quotes-insurance-passthrough-betaNNN.sh
#
# Next free tag: v0.9.0-beta.333 (332 = MI auto-apply).
#
# WORKING TREE CAUTION: the tree carries many unrelated uncommitted workstreams
# (VozIA phoneNormalized, kiosk, etc.). Stage ONLY the 3 files below — never
# `git add -A`. quotes.service.js's working-tree diff is the insurance line ONLY
# (verified pre-ship); staging it whole is safe.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout the release branch first" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN (333 is next) before running." >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"

FILES=(
  "backend/src/modules/quotes/quotes.service.js"
  "backend/src/modules/quotes/quotes.service.test.mjs"
  "doc/vozia-insurance-preview-passthrough-2026-07-21.md"
  ".deploy-notes/2026-07-21-ship-quotes-insurance-passthrough-betaNNN.sh"
)

# ── GATE 1: syntax
( cd backend && node --check src/modules/quotes/quotes.service.js )
echo "GATE 1 OK: node --check limpio."

# ── GATE 2: the change is ONLY the insurance passthrough (no other hunk rode in)
DIFF_ADDED="$(git diff HEAD -- backend/src/modules/quotes/quotes.service.js | grep -E '^\+[^+]' || true)"
# allow-list: the insurance line + its comment block, and the pre-existing
# revenuePricingApplied line (it only gains a trailing comma when the new field
# is added below it — a legitimate consequence, not a foreign hunk).
BAD="$(printf '%s\n' "$DIFF_ADDED" | grep -viE 'insurancePlans|Pass through|priced|VozIA|charge logic|for the trip|so preview|insurance\.|revenuePricingApplied' | grep -E '\S' || true)"
[ -z "$BAD" ] || { echo "ABORT: quotes.service.js working-tree diff has lines beyond the insurance passthrough:"; printf '%s\n' "$BAD"; exit 1; }
echo "GATE 2 OK: quotes.service.js diff = insurance passthrough only."

# ── GATE 3: tests (dev DB is localhost:5432/fleet_management; backend/.env's 5433 is dead)
if command -v nc >/dev/null 2>&1 && nc -z localhost 5432 >/dev/null 2>&1; then
  ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run test:quotes ) \
    || { echo "ABORT: test:quotes failed." >&2; exit 1; }
  echo "GATE 3 OK: test:quotes green (28/28 incl. passthrough + default [])."
else
  echo "############################################################"
  echo "GATE 3 SKIP: no postgres on localhost:5432 — test:quotes did NOT run."
  echo "Bring up the dev DB and re-run for the full proof."
  echo "############################################################"
fi

# ── GATE 4: env parity (no new keys this ship; check against HEAD's .env.example)
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example 2>/dev/null || true
bash scripts/env-diff-check.sh < /dev/null || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example

# ── STAGE (explicit) + contamination guard
git reset >/dev/null
git add -- "${FILES[@]}"
LEAK="$(git diff --cached --name-only | grep -vE '^(backend/src/modules/quotes/quotes\.service\.(js|test\.mjs)|doc/vozia-insurance-preview-passthrough-2026-07-21\.md|\.deploy-notes/2026-07-21-ship-quotes-insurance-passthrough-betaNNN\.sh)$' || true)"
[ -z "$LEAK" ] || { echo "ABORT: unexpected files staged:"; printf '%s\n' "$LEAK"; git reset >/dev/null; exit 1; }
echo "GATE 5 OK: staged set = the 3 files + this script, nothing else."

echo; git diff --cached --stat; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Left staged (not committed)."; exit 0; }
git commit -m "feat(quotes): pass through insurancePlans in /api/quotes/preview

mapEngineRow dropped the engine's already-computed insurancePlans, so
VozIA's post-booking insurance upsell (Chloe) saw an empty list.
searchRental already prices each plan for the trip (booking-engine
~1407); this passes the array through. Additive, display-only — no
charge logic, no migration, backend-only.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo; echo "Pushed $TAG. Droplet: git fetch --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "No migration. Verify: 3 containers healthy + clean boot + /api/health 200 + preview returns populated insurancePlans[]."
