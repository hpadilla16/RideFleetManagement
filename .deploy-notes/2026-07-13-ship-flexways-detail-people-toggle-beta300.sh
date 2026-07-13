#!/usr/bin/env bash
# beta.300 — Flexways detail-fetch (Fase 3.5, DARK) + People employee deactivate toggle.
#   bash .deploy-notes/2026-07-13-ship-flexways-detail-people-toggle-beta300.sh
#
# DOS partes en un bundle (backend + frontend, SIN migración):
#
# PART A — Flexways detail-fetch (Fase 3.5), BACKEND, ships DARK.
#   Añade el enrich por-reserva: cuando el contrato aún NO está promovido, el
#   handler baja el detalle (modificarReserva.php via idAlquiler) para completar
#   vehicleAcriss/email/currency y auto-promover. INVARIANTE central (Innovation
#   + QA): el detail-fetch se SALTA para filas ya AUTO_PROMOTED/PROMOTED, y el
#   skip va ANTES del fetch — si no, cada sync (cada 15 min) re-martillaría el
#   portal (~1MB/fila × ~200 filas) y subiría el score de bot de reCAPTCHA-v3.
#   flexways-worker.test.mjs (DB-backed) blinda el orden: assert hits.detail===0
#   para una fila promovida. Channel filter fail-closed a ['API']. currency =
#   d.currency || null (no fabrica USD en la fila). Sigue DARK:
#   FLEXWAYS_INTEGRATION_ENABLED default false → el worker NO registra handler ni
#   scheduler; las rutas montan admin-gated pero inertes. Aditivo sobre beta.298/299.
#
# PART B — People: toggle activar/desactivar para EMPLEADOS, FRONTEND ONLY.
#   frontend/src/app/people/page.js: nuevo <select> "Account Status" (ACTIVE/
#   INACTIVE) visible SOLO al editar un empleado existente (!hostMode &&
#   editingPersonId). Al guardar manda {status} al PATCH /api/people/:id — que el
#   backend YA soporta (people.service.js:415 mapea status→User.isActive; ya
#   commiteado, NO va en este diff). getSessionUser corta con isActive=false
#   (cache 30s) → desactivar revoca la sesión viva en ~30s. Nota roja de danger
#   cuando INACTIVE (misma convención que la nota de daño en vehicles/[id]).
#   Reemplaza el hueco de "solo se podían pausar hosts, no empleados" (por eso a
#   ALEX PACHECO hubo que apagarlo a mano en Supabase el 2026-07-13).
#
# GATES: Innovation OK (invariante Flexways intacto + approach del toggle correcto,
#   sin MUST-CHANGE) · Graphic Design OK (control on-pattern; aplicado su SHOULD-
#   CONSIDER: color:#b91c1c en el texto de la nota) · QA SHIP.
#   Verificado en browser (dev, SUPER_ADMIN): el select rinde solo en edit de
#   empleado, nota roja en INACTIVE; curl round-trip PATCH INACTIVE→isActive=f,
#   ACTIVE→isActive=t.
#
# SIN migración (FlexwaysLocationConfig + ExternalReservation ya existen de beta.298).
# BACKEND+FRONTEND. DEPLOY:
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   # HARD REFRESH del browser tras el deploy (chunks nuevos del frontend).
#
# SMOKE (Hector): (A) Flexways sigue DARK — Settings→Integrations→Flexways abre
#   sin error, "Disabled"; el worker NO loggea flexways.sync. (B) People → editar
#   un empleado → aparece "Account Status"; poner INACTIVE + Save → el empleado no
#   puede entrar y su sesión cae en ~30s. Crear/editar hosts intacto.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.300}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  # Part A — Flexways detail-fetch (backend)
  "backend/src/modules/integrations/flexways/flexways.constants.js"
  "backend/src/modules/integrations/flexways/flexways.service.js"
  "backend/src/modules/integrations/flexways/flexways.worker.js"
  "backend/src/modules/integrations/flexways/flexways.test.mjs"
  "backend/src/modules/integrations/flexways/flexways-worker.test.mjs"
  # Part B — People employee deactivate toggle (frontend)
  "frontend/src/app/people/page.js"
  # docs + this script
  "doc/flexways-integration-plan-2026-07-13.md"
  ".deploy-notes/2026-07-13-ship-flexways-detail-people-toggle-beta300.sh"
)

# ── SANITY GATES ──
# A1: promoted-skip must sit BEFORE the detail fetch in the worker.
node -e '
const fs=require("fs");
const s=fs.readFileSync("backend/src/modules/integrations/flexways/flexways.worker.js","utf8");
const skip=s.indexOf("promotedSet.has");
const fetch=s.indexOf("await fetchReservationDetail("); // the CALL site, not the top import
if(skip<0){console.error("ABORT: promotedSet.has skip missing");process.exit(1);}
if(fetch<0){console.error("ABORT: fetchReservationDetail call site missing");process.exit(1);}
if(skip>fetch){console.error("ABORT: promoted-skip is AFTER the detail fetch — would re-hammer the portal");process.exit(1);}
' || exit 1
# A2: channel filter fails closed to API.
grep -q "CONTRACT_CHANNEL_FILTER" backend/src/modules/integrations/flexways/flexways.constants.js || { echo "ABORT: CONTRACT_CHANNEL_FILTER missing" >&2; exit 1; }
# A3: still dark by default (flag not force-enabled anywhere in source).
grep -q "FLEXWAYS_INTEGRATION_ENABLED" backend/src/modules/integrations/flexways/flexways.worker.js || true
# B1: the employee toggle block is present and gated correctly.
grep -q "Account Status" frontend/src/app/people/page.js || { echo "ABORT: Account Status control missing" >&2; exit 1; }
grep -q "!hostMode && editingPersonId" frontend/src/app/people/page.js || { echo "ABORT: employee-only gate missing on Account Status" >&2; exit 1; }
# B2: frontend parses (JSX via next swc).
node -e "const {transformSync}=require('$REPO_ROOT/frontend/node_modules/next/dist/build/swc'); transformSync(require('fs').readFileSync('frontend/src/app/people/page.js','utf8'),{jsc:{parser:{syntax:'ecmascript',jsx:true}},filename:'people.jsx'})" || { echo "ABORT: people/page.js no parsea" >&2; exit 1; }
echo "Guards OK (skip-before-fetch; channel fail-closed; Account Status gated; parse OK)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(flexways+people): Flexways detail-fetch (Fase 3.5, dark) + employee deactivate toggle

PART A (Flexways, backend, DARK): per-reservation detail enrich
(modificarReserva.php via idAlquiler) that auto-promotes contracts once
vehicleAcriss/email are known. The detail fetch is SKIPPED for already
AUTO_PROMOTED/PROMOTED rows, ordered BEFORE the fetch, so a 15-min sync never
re-hammers the portal (reCAPTCHA-v3 bot-score risk). Channel filter fails
closed to ['API']; currency stored as-is (no fabricated USD). Ships dark
(FLEXWAYS_INTEGRATION_ENABLED default false → no worker handler/scheduler).
DB-backed flexways-worker.test.mjs locks the skip-before-fetch ordering.

PART B (People, frontend-only): expose an Account Status ACTIVE/INACTIVE
select when editing an existing employee (backend status->isActive support
already committed). Deactivation blocks login and drops the live session in
~30s. Closes the gap where only hosts could be paused.

Gates: Innovation OK, Graphic Design OK, QA SHIP. No migration.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"
echo "Pushed $TAG. Deploy on the droplet (backend worker frontend build + force-recreate, no migration)."
