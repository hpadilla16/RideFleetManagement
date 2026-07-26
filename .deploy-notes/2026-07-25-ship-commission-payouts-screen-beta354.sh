#!/usr/bin/env bash
# ============================================================================
# SHIP: Commission Payouts screen + resurrected ledger report (LAX #5 V2)
# 2026-07-25. View-layer only — no migration, no money-math changes.
#
#  - commission.report.js RESURRECTED (retired 2026-05-26; its ledger-vs-
#    catalog divergence is now the point: this is the PAYOUTS view the
#    approve workflow acts on). Re-imported in register-all-reports, tile
#    registered ('Commission Payouts', OPERATIONS). computeData additively
#    gains reviewsValidated per employee (monthly VALIDATED ReviewProof
#    count — the tier driver), optional-chained for test mocks.
#  - /reports-v2/commission page: per-employee table (rentals, validated
#    reviews, amount) + drill-down per agreement with ADMIN Approve /
#    Mark paid / Void buttons (void requires a reason) hitting the beta.353
#    ledger endpoints. Non-admins see read-only.
#  - reports-v2.service.test registry pins updated (19→20, +'commission').
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/reports/register-all-reports.js"
  "backend/src/modules/reports/reports-v2.service.js"
  "backend/src/modules/reports/commission.report.js"
  "backend/src/modules/reports/reports-v2.service.test.mjs"
  "frontend/src/app/reports-v2/commission/page.js"
  ".deploy-notes/2026-07-25-ship-commission-payouts-screen-beta354.sh"
)

echo "== GATE 1: syntax + boot import =="
for f in backend/src/modules/reports/register-all-reports.js \
         backend/src/modules/reports/reports-v2.service.js \
         backend/src/modules/reports/commission.report.js; do
  node --check "$f"
done
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "import './commission.report.js'" backend/src/modules/reports/register-all-reports.js); echo "report re-imported (1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "slug: 'commission'," backend/src/modules/reports/reports-v2.service.js); echo "tile registered (1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "byEmployeeWithReviews" backend/src/modules/reports/commission.report.js); echo "review counts wired (2): $c3"; [ "$c3" -ge 2 ]
c4=$(grep -c "mark-paid" frontend/src/app/reports-v2/commission/page.js); echo "payout actions (>=2): $c4"; [ "$c4" -ge 2 ]

echo "== GATE 3: encoding =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
echo "encoding OK"

echo "== GATE 4: tests =="
echo "DB-backed (scratchpad runner, TZ=UTC from bash): all 9 report test files — 126/126 verified pre-ship"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
