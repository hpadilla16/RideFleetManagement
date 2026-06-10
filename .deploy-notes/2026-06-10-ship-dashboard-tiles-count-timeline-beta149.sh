#!/usr/bin/env bash
# v0.9.0-beta.149 — Dashboard: clickable tiles + accurate Reservations count + timeline date fix.
#   bash .deploy-notes/2026-06-10-ship-dashboard-tiles-count-timeline-beta149.sh
#
# CODE-ONLY — NO migration. No money code. Stacks on beta.148.
#
# WHAT:
#   - Workspace Ops Hub tiles Vehicles / Available / Migration Holds / Maintenance /
#     Active Reservations are now clickable → their corresponding filtered list.
#   - "Reservations" card now shows the accurate total (summary.totalReservations)
#     instead of the limit-500 page length.
#   - Operations Timeline no longer renders "Invalid Date" (safe ts: updatedAt →
#     createdAt → pickupAt, formatted defensively).
#   - /vehicles?status=available|maintenance|migration deep-link filter (+ clear).
#   - /reservations?filter=active list filter (mirrors the overdue filter).
#
# FILES:
#   backend/src/modules/reservations/reservations.service.js   summary.totalReservations + ?filter=active
#   frontend/src/app/page.js                                   clickable tiles + accurate count + timeline fix
#   frontend/src/app/vehicles/page.js                          ?status= deep-link filter
#   frontend/src/app/reservations/page.js                      active-filter banner
#   .deploy-notes/2026-06-10-ship-dashboard-tiles-count-timeline-beta149.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.149"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reservations/reservations.service.js"
  "frontend/src/app/page.js"
  "frontend/src/app/vehicles/page.js"
  "frontend/src/app/reservations/page.js"
  ".deploy-notes/2026-06-10-ship-dashboard-tiles-count-timeline-beta149.sh"
)

( cd backend && node --check src/modules/reservations/reservations.service.js && node --check src/main.js ) && echo "node --check OK."

# ── GUARDS.
grep -nq "totalReservations" backend/src/modules/reservations/reservations.service.js || { echo "ABORT: totalReservations missing." >&2; exit 1; }
grep -nq "filter || '').toLowerCase() === 'active'" backend/src/modules/reservations/reservations.service.js || { echo "ABORT: active filter missing." >&2; exit 1; }
grep -nq "status=available" frontend/src/app/page.js || { echo "ABORT: dashboard tiles not clickable." >&2; exit 1; }
grep -nq "totalReservations" frontend/src/app/page.js || { echo "ABORT: dashboard count not wired." >&2; exit 1; }
grep -nq "timelineTs" frontend/src/app/page.js || { echo "ABORT: timeline fix missing." >&2; exit 1; }
grep -nq "statusSets" frontend/src/app/vehicles/page.js || { echo "ABORT: vehicles deep-link missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(dashboard): clickable ops tiles + accurate Reservations total + timeline date fix

- Vehicles/Available/Migration Holds/Maintenance/Active Reservations tiles link
  to their filtered lists (/vehicles?status=…, /reservations?filter=active).
- 'Reservations' card uses summary.totalReservations (accurate) instead of the
  limit-500 page length.
- Operations Timeline no longer shows 'Invalid Date' (updatedAt→createdAt→pickupAt).
- backend: summary.totalReservations count + ?filter=active list filter.
Code-only, no migration."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (CODE-ONLY — no migration):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy + /health 200 + HARD refresh."
echo "  smoke: dashboard tiles click through to the right lists; Reservations shows the real"
echo "         total; Operations Timeline shows real dates (no 'Invalid Date')."
