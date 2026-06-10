#!/usr/bin/env bash
# v0.9.0-beta.147 — Inventory Helper, Phase C (PDF report + Inventory Reports).
#   bash .deploy-notes/2026-06-10-ship-inventory-helper-C-beta147.sh
#
# CODE-ONLY — NO migration (the 4 tables already shipped in beta.145). No money
# code. Stacks on beta.146 (release/deposit-balance-fix-beta119).
#
# WHAT: completing an inventory now generates a detailed PDF (puppeteer, like the
# incident report), archives it to Supabase (best-effort; download regenerates if
# absent), and lists it under Reports → Inventory Reports for download. The wizard
# shows a completion screen with Download + View in Reports.
#
# FILES:
#   backend/src/modules/inventory/inventory-pdf.js            buildInventoryReportHtml
#   backend/src/modules/inventory/inventory.service.js        completeSession → PDF + archive + InventoryReport; getReportPdf
#   backend/src/modules/inventory/inventory.routes.js         GET /reports/:id/download
#   frontend/src/app/reports-v2/inventory-reports/page.js     reports list + download
#   frontend/src/app/vehicles/inventory-helper/page.js        completion screen
#   frontend/src/components/AppShell.jsx                      nav: Inventory Reports
#   frontend/src/locales/en.json, es.json                     nav.inventoryReports
#   .deploy-notes/2026-06-10-ship-inventory-helper-C-beta147.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.147"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/inventory/inventory-pdf.js"
  "backend/src/modules/inventory/inventory.service.js"
  "backend/src/modules/inventory/inventory.routes.js"
  "frontend/src/app/reports-v2/inventory-reports/page.js"
  "frontend/src/app/vehicles/inventory-helper/page.js"
  "frontend/src/components/AppShell.jsx"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  ".deploy-notes/2026-06-10-ship-inventory-helper-C-beta147.sh"
)

# ── SYNTAX GATE (backend; frontend jsx validated by the docker build).
( cd backend \
  && node --check src/modules/inventory/inventory-pdf.js \
  && node --check src/modules/inventory/inventory.service.js \
  && node --check src/modules/inventory/inventory.routes.js \
  && node --check src/main.js )
echo "node --check OK."

# ── UNIT TESTS + JSON validity.
( cd backend && node --test src/modules/inventory/inventory-logic.test.mjs >/dev/null ) && echo "inventory unit tests OK."
node -e "JSON.parse(require('fs').readFileSync('frontend/src/locales/en.json'));JSON.parse(require('fs').readFileSync('frontend/src/locales/es.json'));" && echo "locales JSON OK."

# ── GUARDS: wiring present.
grep -nq "buildInventoryReportHtml" backend/src/modules/inventory/inventory-pdf.js || { echo "ABORT: pdf builder missing." >&2; exit 1; }
grep -nq "getReportPdf" backend/src/modules/inventory/inventory.service.js || { echo "ABORT: service missing getReportPdf." >&2; exit 1; }
grep -nq "reports/:id/download" backend/src/modules/inventory/inventory.routes.js || { echo "ABORT: download route missing." >&2; exit 1; }
grep -nq "inventory-reports" frontend/src/components/AppShell.jsx || { echo "ABORT: nav entry missing." >&2; exit 1; }
[ -f frontend/src/app/reports-v2/inventory-reports/page.js ] || { echo "ABORT: reports page missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(inventory): Phase C — completion PDF report + Reports → Inventory Reports

Completing an inventory generates a detailed PDF (puppeteer), archives it to
Supabase (best-effort; download regenerates from the completed session if
absent), and lists it under Reports → Inventory Reports for download. Wizard
gains a completion screen. Code-only, no migration."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (CODE-ONLY — no migration):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy + clean boot + /health 200 + HARD refresh."
echo "  smoke: complete an inventory → completion screen → Download PDF works;"
echo "         Reports → Inventory Reports lists it and downloads."
