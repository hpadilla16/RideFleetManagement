#!/usr/bin/env bash
# ============================================================================
# SHIP: local vs non-local renter deposit rules + mileage allowance (MONEY)
# 2026-07-25 — approved by Hector (staff channel included; exact $2,000/$1,000
# amounts, "up to" is the agent's manual override; T&C text verified in QA).
#
# WHAT SHIPS
#  - backend/src/lib/deposit-rules.js — parse/validate locationConfig.depositRules
#    (malformed blob = rule inert + logger.error), classify renter by licence
#    state then address state (full US state names normalized), unknown → LOCAL.
#  - Staff reservation create + public booking checkout evaluate the rule and
#    FREEZE the decision on ReservationPricingSnapshot.securityDepositRuleJson
#    (new additive column, migration 20260725_snapshot_deposit_rule).
#  - runDepositHold safety net applyLocalRenterDepositRule: only for
#    reservations with NO frozen decision and source != UI_MANUAL; only ever
#    raises; runs BEFORE the debit uplift (max wins).
#  - resolveIncludedMilesPerDay: frozen decision (150 local / Infinity
#    non-local) → VehicleType.unlimitedMileage/freeMilesPerDay → legacy 200.
#    Fee engine guards Infinity at the includedMiles multiply.
#  - Pre-check-in re-evaluation (QA M2): website bookings freeze UNKNOWN →
#    LOCAL; when the real licence arrives at pre-check-in the decision is
#    re-evaluated ONLY if basis was UNKNOWN and source != UI_MANUAL. Deposit
#    and mileage update together (customer-portal.routes.js).
#
# QA FIXES BAKED IN (adversarial QA 2026-07-25):
#  - M1: safety net skips CAR_SHARING reservations / CAR_SHARING_TRIP
#    snapshots — host listing deposits are never overridden.
#  - m1: MIGRATION channel exempt at staff create (matches depositSnapshot).
#  - m2: PUT /:id/pricing forces source UI_MANUAL server-side.
#  - m3: placeholder licence junk ("N/A", "-", "XX") → UNKNOWN → LOCAL;
#    CALIF/CALI aliases → CA. 'ND' stays North Dakota.
#  - m5: malformed-config error log deduped per location+problems.
#  - M3 pre-ship check RAN against prod 2026-07-25: NO tenant has
#    freeMilesPerDay set; only Rent & Go has unlimitedMileage=true (7
#    classes, 74 vehicles) — customer-favorable only, nobody bills more.
#
# DELIBERATE BEHAVIOR CHANGES (documented, not bugs):
#  - VehicleType.unlimitedMileage/freeMilesPerDay now HONORED at check-in
#    billing (they were public-site display only; unlimited classes billed
#    overage past 200 mi/day).
#  - With rules configured, STAFF-created reservations get the security
#    deposit pre-filled (was always $0 from config for staff).
#
# Run gates manually (read </dev/tty> prompts don't work non-interactively).
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/lib/deposit-rules.js"
  "backend/src/lib/deposit-rules.test.mjs"
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260725_snapshot_deposit_rule/migration.sql"
  "backend/src/modules/reservations/reservations.routes.js"
  "backend/src/modules/customer-portal/customer-portal.routes.js"
  "backend/src/modules/booking-engine/booking-engine.service.js"
  "backend/src/modules/checkout-session/spin-charge.service.js"
  "backend/src/modules/rental-agreements/checkin-close.service.js"
  "backend/src/modules/fees/fee-engine.service.js"
  "backend/src/modules/fees/fee-engine.test.mjs"
  "backend/package.json"
  ".deploy-notes/2026-07-25-ship-deposit-rules-local-nonlocal-betaNNN.sh"
)

echo "== GATE 1: syntax + boot import =="
for f in backend/src/lib/deposit-rules.js backend/src/modules/reservations/reservations.routes.js \
         backend/src/modules/booking-engine/booking-engine.service.js \
         backend/src/modules/checkout-session/spin-charge.service.js \
         backend/src/modules/rental-agreements/checkin-close.service.js \
         backend/src/modules/fees/fee-engine.service.js; do
  node --check "$f"
done
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps (mutation-relevant anchors) =="
c1=$(grep -c "applyLocalRenterDepositRule" backend/src/modules/checkout-session/spin-charge.service.js); echo "safety net def+call (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "securityDepositRuleJson" backend/src/modules/reservations/reservations.routes.js); echo "routes stamps rule json (>=3): $c2"; [ "$c2" -ge 3 ]
c2b=$(grep -c "CAR_SHARING" backend/src/modules/checkout-session/spin-charge.service.js); echo "safety net car-sharing guard (>=2): $c2b"; [ "$c2b" -ge 2 ]
c2c=$(grep -c "source: 'UI_MANUAL'" backend/src/modules/reservations/reservations.routes.js); echo "forced UI_MANUAL provenance (>=1): $c2c"; [ "$c2c" -ge 1 ]
c2d=$(grep -c "basis === 'UNKNOWN'" backend/src/modules/customer-portal/customer-portal.routes.js); echo "precheckin re-eval gated on UNKNOWN (>=1): $c2d"; [ "$c2d" -ge 1 ]
c3=$(grep -c "securityDepositRuleJson" backend/src/modules/booking-engine/booking-engine.service.js); echo "public booking stamps rule json (>=3): $c3"; [ "$c3" -ge 3 ]
c4=$(grep -c "UNLIMITED_MILES\|parseDepositRuleDecision" backend/src/modules/rental-agreements/checkin-close.service.js); echo "mileage resolver wired (>=3): $c4"; [ "$c4" -ge 3 ]
c5=$(grep -c "Infinity" backend/src/modules/fees/fee-engine.service.js); echo "fee engine Infinity guard (>=2): $c5"; [ "$c5" -ge 2 ]
c6=$(grep -c "IF NOT EXISTS" backend/prisma/migrations/20260725_snapshot_deposit_rule/migration.sql); echo "migration idempotent (1): $c6"; [ "$c6" -ge 1 ]

echo "== GATE 3: encoding (no CR, migration ASCII-only) =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260725_snapshot_deposit_rule/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "non-ASCII bytes in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests (unit + DB-backed via scratchpad embedded-pg runner) =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:deposit-rules )
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:fees )
echo "DB-backed: run the scratchpad runner for test:booking-engine test:checkout-session test:rental-agreements test:correct-readings"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }

echo "== READY: check remote tags BEFORE tagging (a parallel session raced 343/344 on 2026-07-25) =="
echo "  git ls-remote --tags origin | tail -5"
echo "  git commit -F <msg>  &&  git tag v0.9.0-beta.NNN  &&  git push origin <branch> v0.9.0-beta.NNN"
echo ""
echo "POST-DEPLOY (droplet): npx prisma generate on HOST (new schema column),"
echo "then load LAX config (Hector approves the exact JSON first):"
echo "  locationConfig.depositRules = {\"localStates\":[\"CA\"],\"local\":{\"securityDeposit\":2000,\"milesPerDay\":150},\"nonLocal\":{\"securityDeposit\":1000,\"unlimitedMileage\":true}}"
