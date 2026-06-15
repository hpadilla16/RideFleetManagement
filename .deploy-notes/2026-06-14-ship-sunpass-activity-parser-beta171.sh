#!/usr/bin/env bash
# v0.9.0-beta.171 — SunPass: parser + filtro de la página de Activity rediseñada
#   bash .deploy-notes/2026-06-14-ship-sunpass-activity-parser-beta171.sh
#
# BACKEND-ONLY (tolls.service.js). SIN migración. NO toca el matching/charge math
# (createManualTransactions intacto); cambia solo cómo se LEE la tabla de SunPass.
#
# POR QUÉ: tras login (beta.169) + ventana (beta.170) el Live-Sync corría OK pero
#   scrapedCount=0. Dump de DevTools (Hector) confirmó que el portal rediseñado cambió
#   la página de transacciones: columnas "Description"/"Debit(-)"/"Credit(+)" (no
#   plaza/amount) → scrapeSunPassRows DESCARTABA la tabla; y los selects del filtro
#   tienen nombres nuevos (filterBy/dateType/startDateAll/endDateAll).
#
# QUÉ ENTRA (tolls.service.js):
#   • scrapeSunPassRows reescrito para la tabla real: PostedDate|TransactionDate|
#     Transaction Details|TransactionTime|Transponder/License Plate|Description|Debit(-)|
#     Credit(+)|Balance. Detecta por transponder/debit/details; monto = Debit(-) (salta
#     créditos/pagos); extrae "Transaction Number" del blob de Details como id estable;
#     filtra solo filas de toll.
#   • _runSunPassSync: externalId = ese Transaction Number (= esquema de la carga manual
#     de 708 → dedup exacto, no duplica); clasifica "Transponder/License Plate" en
#     transponder (dígitos → tag, matchea Vehicle.tollTagNumber) vs placa (→ plate);
#     fecha = TransactionDate + TransactionTime.
#   • sunpassFilterAndSearch usa los nombres reales: filterBy="Toll Transaction",
#     dateType="Posted Date" (capta los de posteo tardío en la ventana), startDateAll/
#     endDateAll, botón VIEW. Mantiene fallback por label.
#   Verificado con simulación de la fila real del dump (amount/fecha/tag/externalId OK).
#
# Deploy: build backend + worker + force-recreate. Re-test: Live-Sync de SunPass →
#   AHORA scrapedCount debe ser > 0 (decenas/cientos), la mayoría duplicateExistingCount
#   (ya cargados), importedCount = los nuevos. Si >0 → conector SunPass VIVO end-to-end.
#
# FILES:
#   backend/src/modules/tolls/tolls.service.js
#   .deploy-notes/2026-06-14-ship-sunpass-activity-parser-beta171.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.171"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/tolls/tolls.service.js"
  ".deploy-notes/2026-06-14-ship-sunpass-activity-parser-beta171.sh"
)

# ── GATES
node --check backend/src/modules/tolls/tolls.service.js
grep -nq "isTollTable" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: new toll-table detector missing." >&2; exit 1; }
grep -nq 'select\[name="filterBy"\]' backend/src/modules/tolls/tolls.service.js || { echo "ABORT: filterBy selector missing." >&2; exit 1; }
grep -nq "transaction\\\\s\*number" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: transaction-number extraction missing." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(tolls): parse redesigned SunPass activity table + real filter names

- scrapeSunPassRows reads the new columns (Description/Debit(-)/Credit(+)/Transaction
  Details), takes the toll charge from Debit, extracts the Transaction Number as the
  stable id, skips credits/payments.
- _runSunPassSync uses that Transaction Number as externalId (matches the manual
  backfill so re-scrapes dedup), classifies transponder-vs-plate (tag matches
  Vehicle.tollTagNumber).
- sunpassFilterAndSearch sets filterBy=Toll Transaction, dateType=Posted Date,
  startDateAll/endDateAll, VIEW. No matching/charge changes."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Deploy backend+worker, re-run SunPass Live-Sync, expect scrapedCount>0."
