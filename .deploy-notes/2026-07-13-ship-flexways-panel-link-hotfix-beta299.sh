#!/usr/bin/env bash
# HOTFIX: el panel de Flexways crasheaba /settings — <Link href={null}>.
#   bash .deploy-notes/2026-07-13-ship-flexways-panel-link-hotfix-beta299.sh
#
# BUG (Sentry NEXTJSFRONTEND, prod tras beta.298): al abrir Settings→Integraciones→
# Flexways, /settings tiraba "TypeError: Cannot destructure property 'auth' from
# null or undefined value" en un useMemo → pantalla en blanco / system error.
# CAUSA: el callout del ACRISS map renderizaba <Link href={acrissHref}> y en el
# fix de Graphic Design (should-consider #3 de beta.298) se puso acrissHref =
# acriss?.href || null para "esconder" el link cuando no hay destino — pero el
# <Link> seguía renderizando con href=null. next/link llama formatUrl(href), que
# destructura {auth,hostname,...} del href → con null explota. Confirmado
# descargando el chunk minificado de prod (formatUrl + regex /https?|ftp|gopher|
# file/). Introducido por MÍ en beta.298; QA/GD no lo cacharon porque el panel
# parsea y los tests no renderizan el componente.
#
# FIX (1 archivo, frontend): renderizar el <Link> del ACRISS SOLO cuando
# acrissHref es un string real (`acrissHref ? <Link/> : null`). El otro <Link
# href="/reservations"> es estático, sin riesgo.
#
# VERIFICADO en browser (dev local, tenant ADMIN): Settings→Integrations→Flexways
# abre limpio (panel "Not configured · Disabled"), cero errores de consola, el
# callout del ACRISS rinde y el link NO se renderiza (no hay href todavía) — el
# comportamiento correcto.
#
# SIN migración. FRONTEND ONLY. DEPLOY:
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
#   # HARD REFRESH del browser tras el deploy (chunks nuevos).
#
# SMOKE: Settings → Integraciones → Flexways abre sin error; el resto de tabs
# (TL/Economy/NU) siguen igual.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.299}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/components/settings/FlexwaysIntegrationPanel.jsx"
  ".deploy-notes/2026-07-13-ship-flexways-panel-link-hotfix-beta299.sh"
)

# ── SANITY GATES ──
grep -q "acrissHref ? (" frontend/src/components/settings/FlexwaysIntegrationPanel.jsx || { echo "ABORT: el guard del Link no está presente" >&2; exit 1; }
node -e "const {transformSync}=require('/Users/hectorpadilla/Code/RideFleetManagement/frontend/node_modules/next/dist/build/swc'); transformSync(require('fs').readFileSync('frontend/src/components/settings/FlexwaysIntegrationPanel.jsx','utf8'),{jsc:{parser:{syntax:'ecmascript',jsx:true}},filename:'x.jsx'})" || { echo "ABORT: el panel no parsea" >&2; exit 1; }
echo "Guards OK (Link gateado por acrissHref; parse OK; verificado en browser)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(flexways): don't render <Link href={null}> in the ACRISS callout (crashed /settings)

Opening Settings → Integrations → Flexways crashed /settings with
\"Cannot destructure property 'auth' from null\" (Sentry, prod after beta.298):
the ACRISS-map callout rendered <Link href={acrissHref}> and beta.298's GD
fix set acrissHref = acriss?.href || null to hide the link when there's no
destination — but the <Link> still rendered with href=null, and next/link's
formatUrl destructures {auth,...} from the href → throws on null. Render the
Link only when acrissHref is a real string. Frontend-only, no migration.
Verified in a real browser: the Flexways panel now opens clean, no console
error, and the link is absent until a real href exists."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build frontend -> recreate -> HARD REFRESH."
