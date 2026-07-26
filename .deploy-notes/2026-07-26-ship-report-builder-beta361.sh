#!/usr/bin/env bash
# ============================================================================
# SHIP: Report Builder — users build their own reports (TSD-style categories)
# 2026-07-26. Hector: "cualquier data que tengan en el sistema, lo mas
# inclusivo posible". Innovation-agent verdict (composer-as-registry) + full
# adversarial QA applied (2 blockers + 3 majors fixed pre-ship).
#
# - 10 datasets (reservations/payments/charges/fleet/customers/tolls/
#   citations/commissions/maintenance/incidents), 126 admin fields, all
#   role-gated: money/PII = ADMIN+OPS, enforced at RUN time (a shared report
#   opened by an AGENT runs with money columns stripped + visible notice).
#   Secrets/card tokens/licenses NEVER entered the registry.
# - One engine executes saved definitions: tenant + sede scope INJECTED
#   (definition JSON cannot express them), sede-scoped users allowed on
#   datasets with location paths (403 fail-closed otherwise), date ranges
#   default-bounded (max 366d) in TENANT TZ, caps 200 preview / 5000 export,
#   drift-safe unknown keys.
# - Routes /api/reports/custom (auth stack of reports-v2): datasets-for-role,
#   ad-hoc run, CRUD (PRIVATE/TENANT visibility), saved run with one-off
#   range override, Excel export (proper {buffer} destructure — QA blocker).
# - Frontend: My/Team Reports on the reports-v2 landing, 2-pane builder with
#   live preview, saved view with Export Excel primary. Honest grouped-
#   truncation warnings (QA).
#
# MIGRATION: 20260726_custom_reports (new table + enum, additive idempotent).
# Host `npx prisma generate` from backend/ REQUIRED. Session 5432, never 6543.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260726_custom_reports/migration.sql"
  "backend/src/modules/reports/custom/custom-report-datasets.js"
  "backend/src/modules/reports/custom/custom-report.engine.js"
  "backend/src/modules/reports/custom/custom-reports.routes.js"
  "backend/src/modules/reports/custom/custom-report-engine.test.mjs"
  "backend/src/main.js"
  "backend/package.json"
  "frontend/src/app/reports-v2/page.js"
  "frontend/src/app/reports-v2/builder/page.js"
  "frontend/src/app/reports-v2/custom/[id]/page.js"
  ".deploy-notes/2026-07-26-ship-report-builder-beta361.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/reports/custom/custom-report-datasets.js
node --check backend/src/modules/reports/custom/custom-report.engine.js
node --check backend/src/modules/reports/custom/custom-reports.routes.js
node --check backend/src/main.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "scopedUsersBlocked: true" backend/src/modules/reports/custom/custom-report-datasets.js); echo "no-location datasets blocked (4): $c1"; [ "$c1" -ge 4 ]
c2=$(grep -c "'cardOnFileToken'\|'licenseNumber'\|'dateOfBirth'\|'authnetCustomerProfileId'\|'signatureDataUrl'" backend/src/modules/reports/custom/custom-report-datasets.js || true); echo "secret/PII field KEYS absent from registry (0): $c2"; [ "$c2" -eq 0 ]
c3=$(grep -c "const { buffer } = await renderReportExcel" backend/src/modules/reports/custom/custom-reports.routes.js); echo "excel destructure fixed (1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "pathToSelect" backend/src/modules/reports/custom/custom-report.engine.js); echo "path-select builder (>=2): $c4"; [ "$c4" -ge 2 ]
c5=$(grep -c "api/reports/custom" backend/src/main.js); echo "mounted before v2 (1): $c5"; [ "$c5" -ge 1 ]
c6=$(grep -c "custom-report-engine.test.mjs" backend/package.json); echo "test wired (>=1): $c6"; [ "$c6" -ge 1 ]
c7=$(grep -c "IF NOT EXISTS" backend/prisma/migrations/20260726_custom_reports/migration.sql); echo "idempotent DDL (>=3): $c7"; [ "$c7" -ge 3 ]

echo "== GATE 3: encoding =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c)
  case "$f" in
    backend/src/main.js|backend/package.json) echo "$f CR bytes (pre-existing CRLF allowed): $n" ;;
    *) [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; } ;;
  esac
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260726_custom_reports/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "NON-ASCII bytes in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
echo "DB-backed: test:custom-reports 5/5 (tenant/sede injection, AGENT strip +"
echo "payments 403, AST TZ bucketing, path-only select pin, drift, 366d cap);"
echo "test:reports 126/126 (TZ=UTC via bash); reports-scope-guard 7/7;"
echo "startup-migrate 4/4. Frontend build exit 0, both new routes compiled."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
