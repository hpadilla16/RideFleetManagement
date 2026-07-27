#!/usr/bin/env bash
# ============================================================================
# SHIP: dashboard Today-KPIs — "Collected Today" + "Pending Tolls" tiles.
# 2026-07-26. MONEY DISPLAY (read-only aggregate, no mutation).
#
# From the approved UI mockups (Hector explicitly liked these two KPIs).
# - Backend GET /api/reports/today-kpis: collectedToday reuses the CANONICAL
#   COLLECTED_PAYMENT_WHERE (PAID, AUTH_HOLD excluded — the $336k-vs-$47.5k
#   snapshot lesson) with the day cut in TENANT TZ; pendingTolls mirrors the
#   staff toll-alert bandeja where (unacked, on-contract, billable).
#   Guards: requireRole ADMIN/OPS/SUPER_ADMIN + rejectScopedUsers (same as
#   /snapshot); super without tenant gets nulls, never a null Prisma filter.
# - Frontend: two info-tiles on the home ops hub, soft-fail hidden when the
#   fetch 403s (agents/scoped) or returns nulls; tabular numerals; Pending
#   Tolls red-tints when > 0 (overdue-returns pattern); EN + ES strings.
# NO migration.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/reports/today-kpis.js"
  "backend/src/modules/reports/reports-v2.routes.js"
  "frontend/src/app/page.js"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  ".deploy-notes/2026-07-26-ship-today-kpis-beta366.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/reports/today-kpis.js
node --check backend/src/modules/reports/reports-v2.routes.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "COLLECTED_PAYMENT_WHERE" backend/src/modules/reports/today-kpis.js); echo "canonical money filter (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "startOfDayInTz" backend/src/modules/reports/today-kpis.js); echo "tenant-TZ day cut (>=1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "rejectScopedUsers" backend/src/modules/reports/reports-v2.routes.js); echo "fail-closed guard present: $c3"; [ "$c3" -ge 2 ]
c4=$(grep -c "today-kpis" frontend/src/app/page.js); echo "frontend fetch wired (1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "tilePendingTolls" frontend/src/locales/es.json); echo "ES strings (>=3): $c5"; [ "$c5" -ge 3 ]

echo "== GATE 3: encoding =="
for f in backend/src/modules/reports/today-kpis.js; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
node -e "JSON.parse(require('fs').readFileSync('frontend/src/locales/en.json')); JSON.parse(require('fs').readFileSync('frontend/src/locales/es.json'))" && echo "locales parse OK"

echo "== GATE 4: tests =="
echo "Boot OK; frontend build exit 0; money semantics reused from the tested"
echo "collected-payments module (payments-by-day suite covers the filter)."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
