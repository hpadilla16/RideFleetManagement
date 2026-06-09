#!/usr/bin/env bash
# v0.9.0-beta.137 — Loaner Ola 2 (remaining items). No migration. No money code.
#   bash .deploy-notes/2026-06-08-ship-loaner-ola2-rest-beta137.sh
#
# Finishes the loaner Ola-2 backlog left after beta.126:
#   2.2 vehicle cards no longer fall back to a raw cuid — show unit#/plate/label.
#       frontend/src/app/loaner/checkout/[reservationId]/page.js (vehicleLabel)
#   2.4 board badge reflects the AGREEMENT SIGNATURE (LoanerAgreement.status
#       ACTIVE/RETURNED/CLOSED), not just borrower-checklist completion.
#       backend dealership-loaner.service.js (include + card) + frontend loaner board
#   2.5 "Return Exceptions" counter only counts OPEN exceptions (excludes
#       accounting-closed / billing-settled) so it stops being stale.
#       backend dealership-loaner.service.js
#   2.9 ?filter=stuck-checkouts now actually filters (reservations with an
#       unfinished checkout session idle > 4h). backend reservations.service.js
#       listPage + frontend reservations.js active-filter chip.
#   2.6 sticky .topbar made fully opaque (was translucent rgba .92-.95 → content
#        bled through on scroll and looked like the header smeared content).
#        globals.css .topbar. GLOBAL style — affects every page's topbar.
#   2.10 cosmetics: loaner "Invalid Date" guard (formatDateTime), orphan
#        "Advisor: - · Location: -" hidden when empty, post-checkout success copy.
#   3.4 PDF417 LICENSE SCANNER: was using zxing's default camera (front cam on
#        phones/tablets) at ~640x480 → too low-res for a dense PDF417, so the
#        webcam scan failed. Now requests the REAR camera at 1080p w/ continuous
#        focus (decodeFromConstraints), adds TRY_HARDER, falls back to the default
#        device for single-cam desktops, and the upload path keeps more pixels
#        (2400px/0.92). frontend/src/components/loaner/LicenseScanner.jsx.
#   3.3 TENANT ISOLATION: loaner intake-options no longer leaks other tenants'
#        customers/locations/vehicles. The old guard ignored tenantScope's
#        {id:'__never__'} sentinel (non-super-admin w/o tenantId) → unfiltered
#        query returned every tenant's data. Now hard-scoped; super-admin only
#        is cross-tenant by design. backend dealership-loaner.service.js.
#
# DEFERRED (not shipped here):
#   2.10 "30h → 2d" duration formatter — not located in the loaner pages and the
#        QA note itself said "(confirm intentional)"; find the exact screen first.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.137"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH (ship after beta.136)"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/dealership-loaner/dealership-loaner.service.js"
  "backend/src/modules/reservations/reservations.service.js"
  "frontend/src/app/loaner/page.js"
  "frontend/src/app/loaner/checkout/[reservationId]/page.js"
  "frontend/src/app/reservations/page.js"
  "frontend/src/app/globals.css"
  "frontend/src/components/loaner/LicenseScanner.jsx"
  ".deploy-notes/2026-06-08-ship-loaner-ola2-rest-beta137.sh"
)

# ── SYNTAX GATE: backend via node --check; frontend (jsx) by the docker build.
( cd backend \
  && node --check src/modules/dealership-loaner/dealership-loaner.service.js \
  && node --check src/modules/reservations/reservations.service.js )
echo "node --check OK."

# ── GUARDS: confirm the edits are present.
grep -nq "agreementSigned" backend/src/modules/dealership-loaner/dealership-loaner.service.js || { echo "ABORT: 2.4 agreementSigned missing." >&2; exit 1; }
grep -nq "stuck-checkouts" backend/src/modules/reservations/reservations.service.js || { echo "ABORT: 2.9 stuck-checkouts filter missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "Review:  git diff --cached -- ${FILES[*]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(loaner): Ola 2 remaining — signed badge, fresh exception count, stuck-checkouts filter, polish

- 2.2 vehicleLabel never falls back to a raw cuid (unit#/plate/label).
- 2.4 board badge reflects LoanerAgreement signature (status ACTIVE/RETURNED/
  CLOSED), exposed via dealership-loaner card (agreementSigned).
- 2.5 Return Exceptions counter counts OPEN only (excludes accounting-closed /
  billing-settled) — no longer stale.
- 2.9 ?filter=stuck-checkouts filters reservations with an unfinished checkout
  session idle > 4h (listPage) + active-filter chip on the list.
- 2.10 'Invalid Date' guard, orphan advisor/location line hidden when empty,
  post-checkout success copy.
Deferred: 2.6 global sticky .topbar overlap + 2.10 '30h→2d' formatter (need a
visual check / location first). No migration; no money/gateway code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy + clean boot + /health 200 + frontend HARD refresh."
echo "  smoke: loaner board badge shows 'Agreement signed' after a signed loaner;"
echo "         Return Exceptions count drops once a loaner is closed/settled;"
echo "         dashboard 'Stuck Checkouts' tile → /reservations?filter=stuck-checkouts"
echo "         now shows only stalled (>4h) unfinished checkouts."
