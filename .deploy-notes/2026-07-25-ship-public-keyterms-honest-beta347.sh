#!/usr/bin/env bash
# ============================================================================
# SHIP: public "key terms" panel — honest deposit + mileage (MONEY display)
# 2026-07-25 — spawned fix, built in a separate session, reviewed by Claude
# in the main session, shipped on Hector's standing approval ("tan pronto
# termina revisalo y vamos con el ship").
#
# THE BUG: _deriveKeyTerms read reservation.securityDepositAmount — a field
# that does not exist on Reservation — so `|| 300` told EVERY customer the
# deposit was $300. It also read reservation.dailyMileageCap (also
# nonexistent), so the mileage line was static.
#
# THE FIX: deposit from ReservationPricingSnapshot.securityDepositAmount
# (the number the payment flow actually authorizes); no snapshot / zero →
# NO dollar figure (2026-05-29 no-silent-default precedent). Mileage from
# the frozen local/non-local decision (securityDepositRuleJson, beta.346)
# → VehicleType.unlimitedMileage/freeMilesPerDay → honest generic line.
# Depends on beta.346 (lib/deposit-rules.js) — already deployed.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/package.json"
  "backend/src/modules/public-booking/public-booking.service.js"
  "backend/src/modules/public-booking/agreement-key-terms.test.mjs"
  ".deploy-notes/2026-07-25-ship-public-keyterms-honest-beta347.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/public-booking/public-booking.service.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "parseDepositRuleDecision\|decideIncludedMilesPerDay" backend/src/modules/public-booking/public-booking.service.js); echo "reads frozen decision (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "|| 300" backend/src/modules/public-booking/public-booking.service.js || true); echo "magic 300 gone (0): $c2"; [ "$c2" -eq 0 ]
c3=$(grep -c "dailyMileageCap" backend/src/modules/public-booking/public-booking.service.js || true); echo "phantom field gone (0): $c3"; [ "$c3" -eq 0 ]
c4=$(grep -c "agreement-key-terms.test.mjs" backend/package.json); echo "test wired (1): $c4"; [ "$c4" -ge 1 ]

echo "== GATE 3: encoding =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" node --test src/modules/public-booking/agreement-key-terms.test.mjs )
echo "NOTE: full test:public-booking has 7 PRE-EXISTING failures (baselined with stash by QA 2026-07-25) — do not chase."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
