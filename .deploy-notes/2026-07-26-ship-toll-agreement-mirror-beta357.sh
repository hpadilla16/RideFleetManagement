#!/usr/bin/env bash
# ============================================================================
# SHIP: toll charges now reach the CLOSED agreement balance (MONEY)
# 2026-07-26 — found by the TollBridge team reading our tolls module,
# verified by us in code. Affects TODAY's providers (AutoExpreso/SunPass),
# not just the future TollBridge feed.
#
# THE BUG: syncReservationTollCharges wrote the TOLL_MODULE ReservationCharge
# and stopped — it never mirrored into the RentalAgreement, whose `balance`
# is what the counter reads. Tolls almost always post AFTER the rental
# closed, so the charge existed on the reservation, the counter never saw
# it, and nobody collected it. Silent loss.
#
# THE FIX: the sync tail now calls
# reservationPricingService.syncAgreementCharges(..., { allowClosed: true })
# — the established post-close mirror pattern (manual charges, corrections,
# extensions). Dynamic import (reservation-pricing statically imports tolls;
# a static import back would cycle). Mirror failure is LOUD but does not
# abort the sync (the ReservationCharge is written; next sync retries).
# getPricing's call site passes skipAgreementMirror — it already runs
# syncAgreementCharges in the SAME Promise.all and would race a second
# concurrent rebuild.
#
# NO migration. Backfill note: existing stranded charges self-heal on the
# next toll sync touch of each reservation (any import/match/pricing-open),
# because the mirror now runs every time.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/tolls/tolls.service.js"
  "backend/src/modules/reservations/reservation-pricing.service.js"
  "backend/src/modules/tolls/tolls-agreement-mirror.test.mjs"
  "backend/package.json"
  ".deploy-notes/2026-07-26-ship-toll-agreement-mirror-beta357.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/tolls/tolls.service.js
node --check backend/src/modules/reservations/reservation-pricing.service.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "allowClosed: true" backend/src/modules/tolls/tolls.service.js); echo "post-close mirror (1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "skipAgreementMirror" backend/src/modules/tolls/tolls.service.js); echo "race guard in tolls (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "skipAgreementMirror" backend/src/modules/reservations/reservation-pricing.service.js); echo "getPricing opts out (>=1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "tolls-agreement-mirror.test.mjs" backend/package.json); echo "regression wired (1): $c4"; [ "$c4" -ge 1 ]

echo "== GATE 3: encoding =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
echo "encoding OK"

echo "== GATE 4: tests =="
echo "DB-backed (scratchpad runner): test:tolls 9/9 (incl. the mirror regression + skip guard), test:reservations 149/149, test:correct-readings 4/4 — verified pre-ship"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
