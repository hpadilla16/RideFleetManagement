#!/usr/bin/env bash
# Incident Report §6 — tax PRORRATEADO a las líneas del reporte (bug TL-ZE40809640BA).
#   bash .deploy-notes/2026-07-02-ship-incident-report-tax-proration.sh
#
# Backend-only, SIN migración. Documento-only (no toca cobros ni balances).
#
# BUG (reportado por Hector 2026-07-02): el agreement guarda UNA sola línea TAX agregada
# calculada sobre TODO el subtotal taxable del contrato. El §6 del incident report copiaba
# las líneas escogidas tal cual → al reportar solo el Cleaning Fee Level 3 ($200) de
# RA-20260625164420-1763 (TL-ZE40809640BA), arrastró el TAX completo ($33.46, que incluye
# los $10.46 de los tolls YA PAGADOS el 6/25) y mostró $233.46 en vez de $200 + $23.00 = $223.00.
# El balance del agreement en DB ($223.00) siempre estuvo correcto — el error era SOLO del documento.
#
# FIX:
#   NUEVO backend/src/modules/incident-report/incident-report-charges.js — compute PURO (sin prisma):
#     - Las filas TAX y DEPOSIT nunca entran como líneas del reporte (el depósito ya se maneja
#       vía depositApplied; escoger la fila TAX explícitamente tampoco la arrastra).
#     - El tax mostrado se RECALCULA: líneas taxable escogidas × rate efectivo
#       (rate = TAX agregado ÷ base taxable sobre la que se calculó; fallback al "(11.50%)"
#       embebido en el nombre de la fila; sin fila TAX → sin línea de tax).
#   incident-report.service.js: assembleReport delega el §6 en computeChargeSection
#     (mismos campos de salida: lines/total/depositApplied/balanceDue; chargeApplied usa
#     solo los nombres de fees, sin la línea de tax).
#   package.json: test:incident incluye incident-report-charges.test.mjs (8 tests, incl. el
#     caso real TL-ZE40809640BA y el caso "default pick" que reproduce el 33.46 exacto).
#
# NOTA: el fixture de incident-report-pdf.test.mjs ya asumía este diseño (lines sin tax/deposit,
# total con tax atribuible: 500+150 → 721.50 @ 11%) — el service nunca lo había implementado.
#
# ── SMOKE ──
#   cd backend && npm run test:incident        # 8 tests nuevos + pdf + service (19 total), todos verdes
#   En prod: Reservations → TL-ZE40809640BA → Incident Report del cleaning fee → regenerar PDF
#   → §6 debe mostrar: Fee: Cleaning Fee Level 3 $200.00 · Sales Tax (11.50%) $23.00 · Total $223.00.
#
# DEPLOY (BACKEND only, sin migración):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
#   backend/src/modules/incident-report/incident-report-charges.js
#   backend/src/modules/incident-report/incident-report-charges.test.mjs
#   backend/src/modules/incident-report/incident-report.service.js
#   backend/package.json
#   .deploy-notes/2026-07-02-ship-incident-report-tax-proration.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
# ⚠️ TAG: verificar el último beta en prod ANTES (git tag -l 'v0.9.0-beta.*' | sort -V | tail -1)
# y usar el siguiente. Override: TAG_OVERRIDE=v0.9.0-beta.NNN bash <este script>
TAG="${TAG_OVERRIDE:-v0.9.0-beta.231}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE con el próximo número libre" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/incident-report/incident-report-charges.js"
  "backend/src/modules/incident-report/incident-report-charges.test.mjs"
  "backend/src/modules/incident-report/incident-report.service.js"
  "backend/package.json"
  ".deploy-notes/2026-07-02-ship-incident-report-tax-proration.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/incident-report/incident-report-charges.js || { echo "ABORT: node --check charges" >&2; exit 1; }
node --check backend/src/modules/incident-report/incident-report.service.js || { echo "ABORT: node --check service" >&2; exit 1; }
grep -q "computeChargeSection" backend/src/modules/incident-report/incident-report.service.js || { echo "ABORT: el service no usa computeChargeSection" >&2; exit 1; }
grep -q "incident-report-charges.test.mjs" backend/package.json || { echo "ABORT: test:incident no incluye el test nuevo" >&2; exit 1; }
( cd backend && npm run test:incident ) || { echo "ABORT: test:incident falló" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(incident-report): prorate tax to the report's picked lines (TL-ZE40809640BA)

The agreement keeps ONE aggregated TAX row computed over the whole contract's
taxable subtotal. §6 of the incident report copied picked rows verbatim, so a
partial-charge report dragged the full-contract tax in: a \$200 cleaning fee on
TL-ZE40809640BA rendered \$233.46 (fee + \$33.46 full tax, including \$10.46 of
already-paid toll tax) instead of \$200 + \$23.00 = \$223.00. New pure module
incident-report-charges.js: TAX/DEPOSIT rows never appear as report lines; the
tax shown is recomputed as picked taxable lines x effective rate (aggregated
TAX / its taxable base, falling back to the percent embedded in the row name).
Document-only — agreement charges/balances untouched (DB was always correct).
8 unit tests incl. the real case; wired into npm run test:incident."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → recreate backend+worker. Smoke: regenerar el incident report de TL-ZE40809640BA → \$223.00."
