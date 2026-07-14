#!/usr/bin/env bash
# FIX: el worker sacaba vehicleAcriss=null en TODAS las reservas → todo a MANUAL_REVIEW.
#   bash .deploy-notes/2026-07-14-ship-flexways-unclosed-option-acriss-beta309.sh
#
# CAUSA (probada con el log diagnóstico de beta.308 en prod): la sesión headless del
# worker SÍ recibe el HTML del detalle con la opción seleccionada
# (hasCbCategoria=true, selectedOptionText="Intermediate US (ICAR)"), pero
# extractSelectedOptionText devolvía null porque su regex de opción exigía
# `</option>` — y el <select name=cbCategoria> de Flexways renderiza las opciones
# SIN tag de cierre (`<option value=1>Economico Base (EBMN)<option value=3>...`).
# Sin `</option>`, el regex no matcheaba ninguna opción → categoría null → ACRISS
# null → todo a MANUAL_REVIEW.
#
# FIX (1 archivo backend): el regex de opción matchea el texto hasta el siguiente
# `<` en vez de exigir `</option>` (retrocompatible con opciones bien formadas).
# Antes: /<option\b([^>]*)>([\s\S]*?)<\/option>/  →  Ahora: /<option\b([^>]*)>([^<]*)/
#
# Tests: test:flexways 35/35 (nuevo test con opciones SIN cierre → ICAR). SIN
# migración. BACKEND+WORKER (el detalle corre en el worker). Flexways YA está vivo.
# DEPLOY:
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# SMOKE: en el próximo run el worker re-fetchea el detalle de las MANUAL_REVIEW y
# ahora sí extrae el ACRISS. Verificar en la DB:
#   SELECT vehicleAcriss, COUNT(*) FROM ExternalReservation
#   WHERE sourceSystem='FLEXWAYS' GROUP BY vehicleAcriss;
# (esperado: la mayoría con ACRISS; las que su código esté en AcrissCategoryMap de
# corpus AUTO_PROMUEVEN, el resto queda MANUAL_REVIEW hasta sembrar esos códigos.)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.309}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/integrations/flexways/flexways.service.js"
  "backend/src/modules/integrations/flexways/flexways.test.mjs"
  ".deploy-notes/2026-07-14-ship-flexways-unclosed-option-acriss-beta309.sh"
)

# ── SANITY GATES ──
grep -qF 'Options may be UNCLOSED' backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: el fix del regex de opción no está presente" >&2; exit 1; }
grep -qF '/<option\b([^>]*)>([^<]*)/gi' backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: el regex de opción no está actualizado a [^<]*" >&2; exit 1; }
node --check backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: service no parsea" >&2; exit 1; }
echo "Guards OK (regex de opción sin </option>; parse OK). test:flexways 35/35 verificado."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(flexways): extractSelectedOptionText handles unclosed <option> tags

The worker got vehicleAcriss=null for every reservation. beta.308's diagnostic
proved the headless session DOES receive the detail HTML with the reserved
<option selected> (selectedOptionText was populated with the ACRISS text), but
extractSelectedOptionText required a </option> closing tag to capture the label
— and Flexways' cbCategoria <select> renders options WITHOUT </option>. So it
matched nothing and returned null → ACRISS null → everything MANUAL_REVIEW.
Match the label as text up to the next tag instead. test:flexways 35/35.
No migration.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"
echo "Pushed $TAG. Deploy: build + force-recreate backend worker. Next run extracts ACRISS."
