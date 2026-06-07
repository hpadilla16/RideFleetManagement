#!/usr/bin/env bash
# v0.9.0-beta.126 — Loaner Ola 2 UX (4 fixes). Frontend + 1 backend search. No migrations.
#   bash .deploy-notes/2026-06-06-ship-loaner-ux-ola2-beta126.sh
#
# No money path, no gateway. Items from doc/loaner-qa-action-plan-2026-06-05.md:
#   2.3 Loaner intake → on success, redirect into the check-out wizard for the
#       new reservation (before: form just blanked → looked like a failure →
#       advisors re-submitted → DUPLICATE loaners). frontend/src/app/loaner/page.js
#   2.8 Cancel reservation now: (a) blocks cancel when CHECKED_OUT/CHECKED_IN/
#       CHECKED_IN_UNPAID (button disabled + guard), (b) confirm() before the
#       reason prompt — before, one click silently cancelled.
#       frontend/src/app/reservations/[id]/page.js
#   2.1 Loaner check-out + check-in wizards persist the step pointer to
#       localStorage (per reservationId), so a tablet reload resumes where the
#       advisor left off; cleared on done. (Field data already persisted.)
#       frontend/src/app/loaner/checkout/[reservationId]/page.js
#       frontend/src/app/loaner/checkin/[reservationId]/page.js
#   2.7 Customer search matches the full "First Last" (and "Last First"), not
#       just last name — concatenated name match in the SQL search.
#       backend/src/modules/customers/customers.service.js
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.126"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout a branch first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/customers/customers.service.js"
  "frontend/src/app/loaner/page.js"
  "frontend/src/app/loaner/checkout/[reservationId]/page.js"
  "frontend/src/app/loaner/checkin/[reservationId]/page.js"
  "frontend/src/app/reservations/[id]/page.js"
  ".deploy-notes/2026-06-06-ship-loaner-ux-ola2-beta126.sh"
)

# ── SYNTAX GATE: node --check the backend file; frontend parses are validated by
#    the docker frontend build (force-recreate below). esbuild already confirmed
#    all 4 frontend files parse clean during prep.
( cd backend && node --check src/modules/customers/customers.service.js )
echo "node --check OK (customers.service.js)."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(loaner): Ola 2 UX — intake redirect, cancel guard+confirm, wizard step persist, full-name search

- 2.3 loaner intake redirects into the check-out wizard on success (kills the
  duplicate-loaner re-submits caused by silent feedback).
- 2.8 cancel reservation: disabled + guarded for CHECKED_OUT/CHECKED_IN/
  CHECKED_IN_UNPAID, and a confirm() before the reason prompt.
- 2.1 loaner check-out/check-in wizards persist the step pointer (localStorage,
  per reservationId), cleared on done — tablet reloads resume in place.
- 2.7 customer search matches full 'First Last' (and 'Last First'), not just
  last name. No migrations; no money/gateway code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy + /health 200 + frontend HARD refresh (Cmd-Shift-R)."
echo "  smoke: (2.3) create a loaner → lands in check-out wizard; (2.8) Cancel is"
echo "  disabled on a checked-out reservation + asks to confirm otherwise;"
echo "  (2.1) reload a loaner wizard mid-flow → resumes the same step;"
echo "  (2.7) search a customer by 'First Last' → found."
