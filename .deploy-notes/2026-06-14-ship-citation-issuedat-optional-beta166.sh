#!/usr/bin/env bash
# v0.9.0-beta.166 — CITATIONS: issuedAt opcional (list-only sources / CPC Fase A)
#   bash .deploy-notes/2026-06-14-ship-citation-issuedat-optional-beta166.sh
#
# CON MIGRACIÓN (additive, safe). NO money, NO frontend.
#
# QUÉ ENTRA:
#   • schema: Citation.issuedAt DateTime → DateTime? (opcional).
#   • migración 20260614_citation_issuedat_optional: ALTER COLUMN DROP NOT NULL.
#   • citations.service.js ingestBatch: solo exige citationNo; issuedAt null OK →
#     la multa amarra al VEHÍCULO por placa y queda NEEDS_REVIEW (sin reserva, porque
#     el match de reserva necesita el timestamp). Cero cambio al resto del matching.
#   Motivo: el adapter CPC (list-only) trae citation#+placa+monto sin fecha — el detalle
#   (fecha) es session-bound y se hará en Fase B con Camoufox. Con esto las multas reales
#   (ej. los 7 carros con balance en Orlando) entran HOY amarradas al carro.
#
# MIGRACIÓN por el puerto de SESIÓN 5432 (no pgbouncer 6543):
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" \
#     | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260614_citation_issuedat_optional/migration.sql
#   backend/src/modules/citations/citations.service.js
#   .deploy-notes/2026-06-14-ship-citation-issuedat-optional-beta166.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.166"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260614_citation_issuedat_optional/migration.sql"
  "backend/src/modules/citations/citations.service.js"
  ".deploy-notes/2026-06-14-ship-citation-issuedat-optional-beta166.sh"
)

( cd backend && npx --no-install prisma validate >/dev/null ) && echo "prisma schema valid."
( cd backend && node --check src/modules/citations/citations.service.js && node --check src/main.js && node --check src/worker.js )
echo "node --check OK."

grep -nq 'ALTER COLUMN "issuedAt" DROP NOT NULL' backend/prisma/migrations/20260614_citation_issuedat_optional/migration.sql || { echo "ABORT: migration missing." >&2; exit 1; }
grep -nq "issuedAt          DateTime?" backend/prisma/schema.prisma || { echo "ABORT: schema not made optional." >&2; exit 1; }
grep -nq "'citationNo required'" backend/src/modules/citations/citations.service.js || { echo "ABORT: service still requires issuedAt." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): issuedAt optional for list-only sources

- Citation.issuedAt DateTime -> DateTime? (additive migration DROP NOT NULL).
- ingestBatch requires only citationNo; null issuedAt binds to vehicle by plate,
  stays NEEDS_REVIEW (reservation match needs the timestamp). Matching unchanged.
- Unblocks the CPC list-only adapter (citation+plate+amount, date enriched in Phase B)."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Deploy + migrate por 5432 (ver cabecera)."
