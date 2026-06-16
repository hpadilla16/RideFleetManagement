#!/usr/bin/env bash
# v0.9.0-beta.190 — Citations: Affidavit of Transfer of Liability (PDF). Fase D #4.
#   bash .deploy-notes/2026-06-16-ship-citation-affidavit-beta190.sh
#
# BACKEND + FRONTEND, code-only, sin migración. NO money.
#
# QUE ENTRA:
#   - NUEVO backend/src/modules/citations/citations-affidavit.service.js:
#       buildAffidavitHtml(citation,cfg) + affidavitPdfBuffer(id,scope). Arma un affidavit
#       imprimible/notarizable (membrete del OWNER = config del rental agreement:
#       companyName/Address/Phone) con los datos del RENTER (nombre/dirección/DOB/DL#) +
#       la multa, modelado sobre Fla. Stat. § 316.0083 para vehículos rentados. Reusa el
#       patrón de PDF de reports (renderReportPdf, portrait Letter). 400 si la citation no
#       está matcheada a una reserva con renter.
#   - citations.routes.js: GET /api/citations/:id/affidavit/pdf (authed, tenant-scoped vía
#       scopeFor) → streamea el PDF como attachment.
#   - Detalle (/citations/[id]): botón "Download affidavit (transfer of liability)" en el
#       panel Pay & documents (descarga con el Bearer token vía fetch→blob). Solo aparece
#       cuando la citation tiene renter; si no, muestra un hint.
#   - OWNER configurable por tenant: nuevos campos affidavitOwnerName/Address/Phone en el
#       rental-agreement config (settings.service DEFAULTS → ALLOWED_KEYS auto) + inputs en
#       Settings → Rental Agreement ("Affidavit owner"). El affidavit usa el owner si está
#       seteado; si está en blanco, cae a companyName/Address/Phone.
#
# NOTA legal: el wording referencia § 316.0083 (cámaras de luz roja) + "applicable Florida
#   law" genérico; revisar con tu asesor y ajustar por jurisdicción/tipo de violación.
#   El admin-fee SOP de SunPass (TSD) es OTRO tema, no entra aquí.
#
# Deploy: build backend + worker + FRONTEND + force-recreate + HARD REFRESH.
#
# FILES:
#   backend/src/modules/citations/citations-affidavit.service.js
#   backend/src/modules/citations/citations.routes.js
#   backend/src/modules/settings/settings.service.js
#   frontend/src/app/citations/[id]/page.js
#   frontend/src/app/settings/page.js
#   .deploy-notes/2026-06-16-ship-citation-affidavit-beta190.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.190"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/citations/citations-affidavit.service.js"
  "backend/src/modules/citations/citations.routes.js"
  "backend/src/modules/settings/settings.service.js"
  "frontend/src/app/citations/[id]/page.js"
  "frontend/src/app/settings/page.js"
  ".deploy-notes/2026-06-16-ship-citation-affidavit-beta190.sh"
)

# ── GATES
node --check backend/src/modules/citations/citations-affidavit.service.js
node --check backend/src/modules/citations/citations.routes.js
node --check backend/src/modules/settings/settings.service.js
# El service NUEVO es importado por routes.js — si falta del FILES[], el backend NO bootea.
grep -nq "citations-affidavit.service.js" backend/src/modules/citations/citations.routes.js || { echo "ABORT: routes no importa el service del affidavit." >&2; exit 1; }
grep -nq "affidavit/pdf" backend/src/modules/citations/citations.routes.js || { echo "ABORT: la ruta del affidavit falta." >&2; exit 1; }
grep -nq "buildAffidavitHtml" backend/src/modules/citations/citations-affidavit.service.js || { echo "ABORT: buildAffidavitHtml falta." >&2; exit 1; }
grep -nq "affidavitOwnerName" backend/src/modules/settings/settings.service.js || { echo "ABORT: settings no expone affidavitOwnerName." >&2; exit 1; }
grep -nq "affidavitOwnerName" backend/src/modules/citations/citations-affidavit.service.js || { echo "ABORT: el affidavit no usa el owner configurable." >&2; exit 1; }
grep -nq "Download affidavit" "frontend/src/app/citations/[id]/page.js" || { echo "ABORT: botón del affidavit falta en el detalle." >&2; exit 1; }
grep -nq "Affidavit owner" "frontend/src/app/settings/page.js" || { echo "ABORT: campos de owner faltan en Settings." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): Affidavit of Transfer of Liability PDF (Fase D #4)

New GET /api/citations/:id/affidavit/pdf streams a printable, notarizable affidavit the
vehicle owner submits to the issuing authority to transfer liability to the renter who had
care, custody, and control of the vehicle. Includes the renter's name/address/DOB/DL# per
Fla. Stat. § 316.0083, owner letterhead from the rental-agreement config, and the citation
details. Reuses the reports renderReportPdf pattern. A 'Download affidavit' button on the
citation detail downloads it (token-authed blob). 400 if no matched renter. NOT money."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh. Open a MATCHED citation → Download affidavit."
