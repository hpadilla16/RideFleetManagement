#!/usr/bin/env bash
# ============================================================================
# SHIP: review-tier commissions V1 (LAX #5, MONEY)
# 2026-07-25 — Hector's CUADRO DE COMISION: the counter employee's percent
# over what they sell (services + insurance, excl. taxes/fees/deposits) is
# set by their VALIDATED review count — 0-9 none, 10-19 2%, 20-29 3%,
# 30-39 4%, 40-60 5%, 61+ 6% — ONLY on Expedia/Priceline contracts.
# Soft gate (Hector: "blando") — admin always can act, audited.
#
# ASSUMPTION FLAGGED TO HECTOR (unconfirmed): review count RESETS MONTHLY
# (monthKey of upload month drives that month's contracts).
#
# WHAT SHIPS
#  - ReviewProof table + CommissionPlan.reviewTiersJson/reviewTierSourcesJson
#    (migration 20260725_review_tier_commissions).
#  - AI photo validation (review-proof.extract.js — Anthropic vision, same
#    pattern/key as kiosk/citation OCR; fail-closed: provider failure leaves
#    PENDING_AI for a human, never auto-VALIDATES; 20/hr per-employee cap).
#  - Sync: plans with tiers REPLACE the catalog for counter staff —
#    tierPct(validated this month) × sold items, only when the reservation's
#    bookingChannel OR the linked ExternalReservation.channel prefix-matches
#    the plan's sources (TL carries 'EXPEDIA02' there). Tenants without
#    tiers: catalog byte-identical.
#  - Payout workflow endpoints (approve / mark-paid / void — NEVER existed;
#    every ledger row was permanently PENDING) — ADMIN, AuditLog'd.
#  - Upload lives ON THE RESERVATION (Hector: employee app not in use yet) —
#    "Customer Review" card on the reservation detail, proof linked to the
#    reservation. The employee-app card also exists for when they adopt it.
#  - QA round 2 fixes: PAID amounts FROZEN in the sync (per-row, counter and
#    VA independently); photo SHA-256 dedupe auto-REJECTS re-uploads
#    tenant-wide; reviewerName persisted; tiers-without-sources 400s (also
#    on partial updates); business-name lookup fail-closed; proof list omits
#    photo blobs; blank tier rows dropped; FileReader onerror handled;
#    pre-existing car-sharing/protection 500 fixed (OPTIONAL_ADDONS alias).
#  - New reservation: "Booking source" selector (Walk-in/Expedia/Priceline).
#  - Settings: tier editor on the plan form (seeded with Hector's table).
#
# V2 (next increment, view-layer only): Commission Payouts screen with the
# approve/paid buttons + resurrected commission report with review columns.
# Until then admins can drive the workflow via the ledger API.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260725_review_tier_commissions/migration.sql"
  "backend/src/lib/review-tiers.js"
  "backend/src/lib/review-tiers.test.mjs"
  "backend/src/modules/commissions/review-proof.extract.js"
  "backend/src/modules/commissions/commissions.service.js"
  "backend/src/modules/commissions/commissions.routes.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/package.json"
  "frontend/src/app/employee/page.js"
  "frontend/src/app/reservations/[id]/page.js"
  "frontend/src/app/reservations/new/page.js"
  "frontend/src/app/settings/page.js"
  "frontend/src/app/settings/settings-constants.js"
  ".deploy-notes/2026-07-25-ship-review-tier-commissions-betaNNN.sh"
)

echo "== GATE 1: syntax + boot import =="
for f in backend/src/lib/review-tiers.js backend/src/modules/commissions/review-proof.extract.js \
         backend/src/modules/commissions/commissions.service.js backend/src/modules/commissions/commissions.routes.js \
         backend/src/modules/rental-agreements/rental-agreements.service.js; do
  node --check "$f"
done
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "tierPercentFor" backend/src/modules/rental-agreements/rental-agreements.service.js); echo "tier math in sync (>=1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "channelMatchesReviewSources" backend/src/modules/rental-agreements/rental-agreements.service.js); echo "qualifier def+use (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "setCommissionStatus" backend/src/modules/commissions/commissions.service.js); echo "workflow method (>=1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "review-proofs" backend/src/modules/commissions/commissions.routes.js); echo "proof routes (>=3): $c4"; [ "$c4" -ge 3 ]
c5=$(grep -c "PENDING_AI" backend/src/modules/commissions/commissions.service.js); echo "fail-closed AI posture (>=2): $c5"; [ "$c5" -ge 2 ]
c6=$(grep -c "IF NOT EXISTS" backend/prisma/migrations/20260725_review_tier_commissions/migration.sql); echo "migration idempotent (>=5): $c6"; [ "$c6" -ge 5 ]

echo "== GATE 3: encoding (no CR, migration ASCII-only) =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260725_review_tier_commissions/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "non-ASCII bytes in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:commissions )
echo "DB-backed via scratchpad runner: test:rental-agreements test:reservations; frontend: npx next build"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }

echo "== POST-DEPLOY: npx prisma generate on droplet HOST from backend/ (new table + columns) =="
echo "ACTIVATION (UI): Settings -> Commission Plans -> standard plan -> enable"
echo "'Review-tier commissions' (Hector's table pre-seeded, EXPEDIA+PRICELINE checked)."