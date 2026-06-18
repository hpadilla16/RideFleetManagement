#!/usr/bin/env bash
# v0.9.0-beta.197 — API Docs: render Swagger UI inline (fix "shows raw code" behind Basic Auth).
#   bash .deploy-notes/2026-06-18-ship-api-docs-swagger-inline-beta197.sh
#
# BACKEND-only, code-only, SIN migración. NO money. (Sigue a beta196.)
#
# QUE ENTRA:
#   - swaggerHtml() ahora embebe el spec INLINE (spec: {...}) en vez de url:'/api/docs/openapi.json'.
#     Con el Basic Auth de beta196, el fetch del spec por Swagger UI no mandaba credenciales → la
#     página mostraba el JSON crudo en vez de la UI. La página ya está autenticada, así que el spec
#     embebido no necesita fetch extra. Se escapa '<' para que ningún '</script>' en el spec rompa.
#   - /api/docs ahora construye el spec y se lo pasa a swaggerHtml (main.js).
#   - /api/docs/openapi.json sigue igual (JSON crudo, authed) para uso programático.
#
# Deploy: build BACKEND + force-recreate. SIN migración. SIN env nuevas.
#
# FILES:
#   backend/src/main.js
#   backend/src/docs/openapi.js
#   .deploy-notes/2026-06-18-ship-api-docs-swagger-inline-beta197.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.197"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/main.js"
  "backend/src/docs/openapi.js"
  ".deploy-notes/2026-06-18-ship-api-docs-swagger-inline-beta197.sh"
)

# ── GATES ──
node --check backend/src/main.js || { echo "ABORT: main.js parse" >&2; exit 1; }
node --check backend/src/docs/openapi.js || { echo "ABORT: openapi.js parse" >&2; exit 1; }
# El extra-routes.generated.js sigue presente (vino en beta196) — openapi.js lo importa.
[ -f backend/src/docs/extra-routes.generated.js ] || { echo "ABORT: falta extra-routes.generated.js (¿beta196 no está?)." >&2; exit 1; }
# La página debe embeber el spec inline y NO usar el url: viejo.
node --input-type=module -e "
import('./backend/src/docs/openapi.js').then(({buildOpenApiSpec,swaggerHtml})=>{
  const html=swaggerHtml(buildOpenApiSpec('http://x'));
  if(!html.includes('spec: {')) throw new Error('no embebe el spec inline');
  if(html.includes(\"url: '/api/docs/openapi.json'\")) throw new Error('sigue usando url: viejo');
  console.log('swagger inline OK');
}).catch(e=>{console.error('ABORT:',e.message);process.exit(1)});" || exit 1
grep -q "swaggerHtml(buildOpenApiSpec(serverUrl))" backend/src/main.js || { echo "ABORT: /api/docs no pasa el spec construido." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(docs): render Swagger UI inline behind Basic Auth

swaggerHtml() now embeds the OpenAPI spec inline (spec:{...}) instead of url:'/api/docs/openapi.json'.
Behind the beta196 Basic Auth gate, Swagger UI's secondary fetch for the spec wasn't sending creds,
so the page rendered raw JSON. The page is already authenticated, so the inline spec needs no extra
fetch. '<' is escaped to avoid any '</script>' breakout. Backend-only, no migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. En el droplet: build backend → force-recreate. Sin migración, sin env nuevas."
