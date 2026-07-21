#!/usr/bin/env bash
# resolveForRental fail-closed on the ONLINE path (rates.service.js ~815): a class
# with no class-specific RateItem returns null (dropped from availability) instead
# of being cross-priced via another rate's header. Scoped to options.displayOnline
# — the internal/staff fallback is unchanged. VozIA audit item (c). Backend-only,
# no migration, no env keys, no charge code. Innovation OK + QA SHIP; blast radius
# measured = 0 classes drop in prod today (pure forward backstop).
#
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-21-ship-resolveforrental-failclosed-betaNNN.sh
#
# Next free: v0.9.0-beta.334 (333 = quotes insurance passthrough).
#
# WORKING-TREE CAUTION: the tree carries many unrelated uncommitted workstreams.
# Stage ONLY the 3 files below (+ this script) — never `git add -A`. Verified
# pre-ship: rates.service.js diff = the fail-closed hunk only; package.json diff =
# the single test:rates line only. Staging whole is safe.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout the release branch first" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN (334 next)." >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"

FILES=(
  "backend/src/modules/rates/rates.service.js"
  "backend/src/modules/rates/resolve-for-rental-failclosed.test.mjs"
  "backend/package.json"
  ".deploy-notes/2026-07-21-ship-resolveforrental-failclosed-betaNNN.sh"
)

# ── GATE 1: syntax
( cd backend && node --check src/modules/rates/rates.service.js )
echo "GATE 1 OK: node --check limpio."

# ── GATE 2: rates.service.js changed ONLY the resolver fail-closed hunk
RATES_ADDED="$(git diff HEAD -- backend/src/modules/rates/rates.service.js | grep -E '^\+[^+]' || true)"
BAD="$(printf '%s\n' "$RATES_ADDED" | grep -viE 'chosen|scoped|rateItems|displayOnline|Fail-closed|item\?\.|no class|cross-price|customer|dropped|staff|VozIA|default rate|preserved|falsy|header|availability|visible|\|\| null' | grep -E '\S' || true)"
[ -z "$BAD" ] || { echo "ABORT: rates.service.js diff has lines beyond the fail-closed hunk:"; printf '%s\n' "$BAD"; exit 1; }
echo "GATE 2 OK: rates.service.js = fail-closed hunk only."

# ── GATE 3: package.json changed ONLY the test:rates line
PKG_CHANGED="$(git diff HEAD -- backend/package.json | grep -E '^[+-][^+-]' || true)"
PKG_NONRATES="$(printf '%s\n' "$PKG_CHANGED" | grep -v 'test:rates' | grep -E '\S' || true)"
[ -z "$PKG_NONRATES" ] || { echo "ABORT: package.json changed beyond the test:rates line:"; printf '%s\n' "$PKG_NONRATES"; exit 1; }
echo "GATE 3 OK: package.json = test:rates line only."

# ── GATE 4: tests (dev DB localhost:5432/fleet_management; NOT the dead 5433)
if command -v nc >/dev/null 2>&1 && nc -z localhost 5432 >/dev/null 2>&1; then
  ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run test:rates ) \
    || { echo "ABORT: test:rates failed." >&2; exit 1; }
  echo "GATE 4 OK: test:rates green (7/7 incl. the 4 fail-closed tests)."
else
  echo "GATE 4 SKIP: no postgres on localhost:5432 — test:rates did NOT run. Bring up the dev DB and re-run."
fi

# ── GATE 5: env parity (no new keys; against HEAD's .env.example)
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example 2>/dev/null || true
bash scripts/env-diff-check.sh < /dev/null || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example

# ── STAGE (explicit) + contamination guard
git reset >/dev/null
git add -- "${FILES[@]}"
LEAK="$(git diff --cached --name-only | grep -vE '^(backend/src/modules/rates/rates\.service\.js|backend/src/modules/rates/resolve-for-rental-failclosed\.test\.mjs|backend/package\.json|\.deploy-notes/2026-07-21-ship-resolveforrental-failclosed-betaNNN\.sh)$' || true)"
[ -z "$LEAK" ] || { echo "ABORT: unexpected files staged:"; printf '%s\n' "$LEAK"; git reset >/dev/null; exit 1; }
echo "GATE 6 OK: staged set = the 3 files + this script."

echo; git diff --cached --stat; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Left staged (not committed)."; exit 0; }
git commit -m "fix(rates): fail-closed online resolveForRental — no cross-pricing a class without its own rate

On the online/public path (options.displayOnline), a rental class with no
class-specific RateItem now returns null (dropped from availability)
instead of being quoted via another rate's header daily — which would
cross-price a customer. Scoped to displayOnline: the internal/staff path
keeps the scoped[0] fallback unchanged. All customer paths funnel through
searchRental (hardcodes displayOnline:true) incl. the booking-CREATE
re-price, so a customer can't be quoted OR charged another class's price.
Null drops cleanly from search results / 422 on a direct quote. VozIA
audit item (c); SJU data already fixed, blast radius measured 0. Backend
-only, no migration. Innovation OK + QA SHIP.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo; echo "Pushed $TAG. Droplet: git fetch --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "No migration. Verify: 3 containers healthy + clean boot + /api/health 200."
