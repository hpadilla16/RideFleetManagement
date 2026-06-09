#!/usr/bin/env bash
# v0.9.0-beta.136 — New Reservation UI v2 (4-step wizard).
#   bash .deploy-notes/2026-06-08-ship-new-reservation-v2-beta136.sh
#
# Frontend-only. No migration. No backend changes — the wizard reuses the exact
# same endpoints + POST body as the legacy modal (resolve-rate, locations,
# vehicle-types, customers, market/summary, POST /api/reservations). No money
# logic touched.
#
# WHAT: a dedicated /reservations/new page — a 4-step guided booking (dates &
# locations → vehicle class cards with market median context → customer
# search/create with DO-NOT-RENT flag → review) with a sticky live-summary pane
# (running quote + pre-auth hold callout). Reachable via the new "New Reservation
# (v2)" button on /reservations; the legacy modal stays as-is for now.
#
# NOTE: built to the approved-mockup description in the beta.131 handoff (the
# mockup file lives outside the repo). Compare against the mockup and tweak copy/
# layout as needed — the data wiring is final.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.136"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH (ship after beta.135)"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/reservations/new/page.js"
  "frontend/src/app/reservations/page.js"
  ".deploy-notes/2026-06-08-ship-new-reservation-v2-beta136.sh"
)

# ── SYNTAX GATE: jsx validated by the docker frontend build (force-recreate).
#    Both files parsed clean with @babel/parser (jsx) during prep.
# ── GUARDS: confirm the new page + entry point exist.
[ -f frontend/src/app/reservations/new/page.js ] || { echo "ABORT: v2 page missing." >&2; exit 1; }
grep -nq "reservations/new" frontend/src/app/reservations/page.js || { echo "ABORT: v2 entry button missing from /reservations." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "Review:  git diff --cached -- ${FILES[*]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(reservations): New Reservation UI v2 — 4-step wizard

A dedicated /reservations/new guided booking flow with a sticky live-summary
pane, replacing the cramped single modal (kept as-is for now). Steps:
dates & locations → vehicle class cards (market median context per SIPP) →
customer search/create (surfaces DO-NOT-RENT flag) → review & confirm.

Frontend-only: reuses the existing endpoints (resolve-rate, locations,
vehicle-types, customers, market/summary) and posts the exact same body to
POST /api/reservations as the legacy form. No backend/money changes; no
migration. Reachable via a new 'New Reservation (v2)' button on /reservations."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy + /health 200 + frontend HARD refresh."
echo "  smoke: /reservations → 'New Reservation (v2)' → step through dates →"
echo "         vehicle class (market median shows) → customer → review → Create →"
echo "         lands on the new reservation detail. Confirm the created reservation"
echo "         matches one made via the legacy modal (rate, total, dates, customer)."
