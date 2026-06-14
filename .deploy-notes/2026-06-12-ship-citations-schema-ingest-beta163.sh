#!/usr/bin/env bash
# v0.9.0-beta.163 — CITATIONS: schema + endpoint de ingestión (Fase A, P1 tickets)
#   bash .deploy-notes/2026-06-12-ship-citations-schema-ingest-beta163.sh
#
# CON MIGRACIÓN (additive). Spec: doc/citations-tolls-fase-a-spec-2026-06-12.md
# NO money: este bundle solo ingiere + matchea + expone. El billing (postear al
# RentalAgreement.balance) es Fase E y NO está aquí.
# NO frontend: la UI de Citations es una fase posterior.
#
# QUÉ ENTRA:
#   • MIGRACIÓN (idempotente, additive): Tenant.citationsEnabled + enums
#     CitationSource/CitationStatus/CitationBillingStatus/CitationMatchStatus +
#     tablas CitationSourceAccount/CitationImportRun/Citation/CitationAssignment.
#     Espejo 1:1 de los modelos Toll*. DDL verificado contra el canónico de Prisma.
#   • MÓDULO backend/src/modules/citations/ (NUEVO):
#     - service: ingestBatch idempotente por (tenantId, source, citationNo);
#       matching de dos niveles (vehicleId SIEMPRE por placa; reservationId si el
#       timestamp cae en la ventana de la renta → CitationAssignment AUTO_CONFIRMED);
#       list/detail/review/getVehicleHistory. NUNCA mueve dinero.
#     - routes: authed (ADMIN/OPS) list/detail/review/manual-import/vehicle, e
#       INTERNAL POST /api/internal/citations/ingest (shared secret
#       BACKEND_INTERNAL_TOKEN — el puente del scraper-droplet).
#   • main.js: monta /api/citations (authed) y /api/internal/citations (interno).
#
# MIGRACIÓN por el puerto de SESIÓN 5432 (no pgbouncer 6543):
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" \
#     | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260612_citations/migration.sql
#   backend/src/modules/citations/citations.service.js   (NUEVO)
#   backend/src/modules/citations/citations.routes.js    (NUEVO)
#   backend/src/main.js
#   backend/.env.example   (documenta BACKEND_INTERNAL_TOKEN)
#   doc/citations-tolls-fase-a-spec-2026-06-12.md
#   doc/citations-portal-ingestion-plan-2026-06-12.md
#   .deploy-notes/2026-06-12-ship-citations-schema-ingest-beta163.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.163"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260612_citations/migration.sql"
  "backend/src/modules/citations/citations.service.js"
  "backend/src/modules/citations/citations.routes.js"
  "backend/src/main.js"
  "backend/.env.example"
  "doc/citations-tolls-fase-a-spec-2026-06-12.md"
  "doc/citations-portal-ingestion-plan-2026-06-12.md"
  ".deploy-notes/2026-06-12-ship-citations-schema-ingest-beta163.sh"
)

# ── SCHEMA + SYNTAX GATES (todo import top-level de main.js debe checar).
( cd backend && npx --no-install prisma validate >/dev/null ) && echo "prisma schema valid."
( cd backend \
  && node --check src/modules/citations/citations.service.js \
  && node --check src/modules/citations/citations.routes.js \
  && node --check src/main.js \
  && node --check src/worker.js )
echo "node --check OK."

# ── GUARDS (migración + wiring presentes).
grep -nq 'CREATE TABLE IF NOT EXISTS "Citation"' backend/prisma/migrations/20260612_citations/migration.sql || { echo "ABORT: Citation table migration missing." >&2; exit 1; }
grep -nq "ADD COLUMN IF NOT EXISTS \"citationsEnabled\"" backend/prisma/migrations/20260612_citations/migration.sql || { echo "ABORT: citationsEnabled column missing." >&2; exit 1; }
grep -nq "CitationSource" backend/prisma/migrations/20260612_citations/migration.sql || { echo "ABORT: CitationSource enum missing." >&2; exit 1; }
grep -nq "model Citation " backend/prisma/schema.prisma || { echo "ABORT: Citation model missing from schema." >&2; exit 1; }
grep -nq "/api/internal/citations" backend/src/main.js || { echo "ABORT: internal ingest router not mounted." >&2; exit 1; }
grep -nq "/api/citations" backend/src/main.js || { echo "ABORT: authed router not mounted." >&2; exit 1; }
grep -nq "ingestBatch" backend/src/modules/citations/citations.service.js || { echo "ABORT: ingestBatch missing." >&2; exit 1; }
grep -nq "BACKEND_INTERNAL_TOKEN" backend/src/modules/citations/citations.routes.js || { echo "ABORT: internal token guard missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): schema + internal ingestion endpoint (Fase A, P1 tickets)

- Additive migration 20260612_citations: Tenant.citationsEnabled + 4 enums +
  CitationSourceAccount/CitationImportRun/Citation/CitationAssignment (mirror of Toll*).
- New module citations: idempotent ingestBatch + two-level amarre (vehicle always,
  reservation when timestamp in rental window) + list/detail/review. No money.
- POST /api/internal/citations/ingest (BACKEND_INTERNAL_TOKEN) = scraper-droplet bridge.
- Authed /api/citations (ADMIN/OPS). Spec: doc/citations-tolls-fase-a-spec-2026-06-12.md"
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Deploy en el droplet + migrate por 5432 (ver cabecera)."
