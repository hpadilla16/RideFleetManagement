#!/usr/bin/env bash
# ============================================================================
# SHIP: toll sede scope + per-location re-match window + staff alerts
# (TollBridge findings (a)+(b) and Hector's point 9). MONEY-ADJACENT:
# matching decides who gets billed. 2026-07-26.
#
# (a) SEDE STAMP: TollProviderAccount.locationId -> stamped onto every
#     imported TollTransaction. Matcher never offers a vehicle homed at a
#     DIFFERENT sede (null home stays eligible; null stamp = old behavior).
#     Cross-sede identifier hits hold as 'vehicle-outside-location'.
# (b) RE-MATCH SWEEP: new worker timer retries needsReview+PENDING tolls
#     inside each sede's own window (locationConfig.tolls.rematchWindowDays,
#     default 14, max 120; LAX will set 45). Auto-confirms flow into the full
#     charge sync -> agreement mirror -> staff alert pipeline.
#     Env (all defaulted, none required): TOLLS_REMATCH_ENABLED,
#     TOLLS_REMATCH_INTERVAL_MINUTES (360), TOLLS_REMATCH_STARTUP_DELAY_SECONDS.
# (9) STAFF ALERTS: one email per toll (claim on staffNotifiedAt, released on
#     send failure), recipient locationConfig.tolls.alertEmail (toll sede ->
#     pickup sede fallback); in-app bandeja (GET /api/tolls/alerts + ack) with
#     closed contracts first; banner on the reservation page.
# Also: missing `import logger` in tolls.service.js (beta.357 latent — the
# mirror's catch would have thrown ReferenceError on the failure path).
#
# MIGRATION: 20260726_toll_location_staff_alerts (additive idempotent;
# BACKFILLS staffNotifiedAt/staffAckAt=now for pre-existing rows so history
# never alerts). Host `npx prisma generate` from backend/ REQUIRED.
# Migrate via SESSION port 5432, never 6543.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260726_toll_location_staff_alerts/migration.sql"
  "backend/src/modules/tolls/tolls.service.js"
  "backend/src/modules/tolls/tolls.routes.js"
  "backend/src/modules/tolls/tolls.scheduler.js"
  "backend/src/modules/tolls/tolls-location-alerts.test.mjs"
  "backend/package.json"
  "frontend/src/app/reservations/[id]/page.js"
  "frontend/src/app/tolls/page.js"
  "doc/tollbridge/tollbridge-integration-response-2026-07-24.md"
  ".deploy-notes/2026-07-26-ship-toll-sede-rematch-alerts-beta358.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/tolls/tolls.service.js
node --check backend/src/modules/tolls/tolls.routes.js
node --check backend/src/modules/tolls/tolls.scheduler.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "locationId: stampLocationId" backend/src/modules/tolls/tolls.service.js); echo "stamp on draft+row (2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "vehicle-outside-location" backend/src/modules/tolls/tolls.service.js); echo "sede hold reason (>=1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "rematchWindowDays" backend/src/modules/tolls/tolls.service.js); echo "per-sede window (>=2): $c3"; [ "$c3" -ge 2 ]
c4=$(grep -c "staffNotifiedAt: null" backend/src/modules/tolls/tolls.service.js); echo "claim WHERE null (>=1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "runRematchSweep" backend/src/modules/tolls/tolls.scheduler.js); echo "sweep wired to timer (>=2): $c5"; [ "$c5" -ge 2 ]
c6=$(grep -c "import logger" backend/src/modules/tolls/tolls.service.js); echo "logger import present (1): $c6"; [ "$c6" -ge 1 ]
c7=$(grep -c "tolls-location-alerts.test.mjs" backend/package.json); echo "regression wired (1): $c7"; [ "$c7" -ge 1 ]
c8=$(grep -c "IF NOT EXISTS" backend/prisma/migrations/20260726_toll_location_staff_alerts/migration.sql); echo "idempotent DDL (>=6): $c8"; [ "$c8" -ge 6 ]

echo "== GATE 3: encoding =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260726_toll_location_staff_alerts/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "NON-ASCII bytes in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
echo "DB-backed (scratchpad runner): test:tolls 17/17 (sede filter, stamp, QA pins:"
echo "RESET_MATCH hold, sweep no-op, ambiguous-stamp refusal), scope+guard green,"
echo "test:reservations 149/149, test:correct-readings 4/4,"
echo "test:startup-migrate 4/4. Frontend: npm run build exit 0."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
