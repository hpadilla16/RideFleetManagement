#!/usr/bin/env bash
# v0.9.0-beta.196 — API Docs: HTTP Basic Auth + full OpenAPI update (100 → 539 paths).
#   bash .deploy-notes/2026-06-18-ship-api-docs-auth-beta196.sh
#
# BACKEND-only, code-only, SIN migración. NO money.
#
# QUE ENTRA:
#   - /api/docs y /api/docs/openapi.json ahora exigen HTTP Basic Auth (DOCS_USER/DOCS_PASS del
#     .env; sin ambas → 503, docs deshabilitadas). Compare constant-time.
#   - openapi.js: expander de rutas + 23 tags nuevos; importa el array generado
#     backend/src/docs/extra-routes.generated.js (514 descriptores). El spec pasó de 100 a 539
#     paths / 635 operaciones cubriendo TODO lo nuevo (citations, inspections, incidents,
#     inventory, planner, car-sharing, loaner, checkout, payment-gateway, market intelligence,
#     settings, catalog, reports-v2, etc.). Las docs hechas a mano ganan en conflictos.
#
# ── ENV NUEVAS (ponerlas en el .env del droplet ANTES de deployar; env-diff-check es fail-closed):
#     DOCS_USER   y   DOCS_PASS
#   Sin ellas el backend bootea igual, pero /api/docs responde 503 hasta setearlas.
#
# Deploy: build BACKEND + force-recreate. SIN migración. (env-diff-check.sh primero.)
#
# FILES:
#   backend/src/main.js
#   backend/src/docs/openapi.js
#   backend/src/docs/extra-routes.generated.js   (NUEVO — import top-level de openapi.js → main.js)
#   backend/.env.example
#   .deploy-notes/2026-06-18-ship-api-docs-auth-beta196.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.196"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/main.js"
  "backend/src/docs/openapi.js"
  "backend/src/docs/extra-routes.generated.js"
  "backend/.env.example"
  ".deploy-notes/2026-06-18-ship-api-docs-auth-beta196.sh"
)

# ── BOOT-SAFETY GATES (causa #1 de boot crashes: un import top-level que falta del FILES[]) ──
# 1) El módulo generado que importa openapi.js DEBE existir y estar en FILES[].
[ -f backend/src/docs/extra-routes.generated.js ] || { echo "ABORT: falta backend/src/docs/extra-routes.generated.js" >&2; exit 1; }
grep -q "from './extra-routes.generated.js'" backend/src/docs/openapi.js || { echo "ABORT: openapi.js no importa extra-routes.generated.js (¿se movió?)." >&2; exit 1; }
printf '%s\n' "${FILES[@]}" | grep -qx "backend/src/docs/extra-routes.generated.js" || { echo "ABORT: extra-routes.generated.js no está en FILES[]." >&2; exit 1; }

# 2) Parse-check de los 3 archivos backend (un parse error tumba el boot).
for f in backend/src/main.js backend/src/docs/openapi.js backend/src/docs/extra-routes.generated.js; do
  node --check "$f" || { echo "ABORT: node --check falló en $f" >&2; exit 1; }
done

# 3) El spec construye y serializa a JSON (cero referencias rotas / tags sin declarar).
node --input-type=module -e "
import('./backend/src/docs/openapi.js').then(({buildOpenApiSpec})=>{
  const s=buildOpenApiSpec('http://x'); const n=Object.keys(s.paths).length;
  if(n<500) throw new Error('spec con muy pocos paths: '+n);
  const declared=new Set(s.tags.map(t=>t.name)); const used=new Set();
  for(const p of Object.keys(s.paths)) for(const m of Object.keys(s.paths[p])) (s.paths[p][m].tags||[]).forEach(t=>used.add(t));
  const miss=[...used].filter(t=>!declared.has(t)); if(miss.length) throw new Error('tags sin declarar: '+miss);
  JSON.stringify(s); console.log('spec OK:', n, 'paths');
}).catch(e=>{console.error('ABORT spec:', e.message); process.exit(1)});" || exit 1

# 4) El auth de docs está realmente puesto (no dejamos /api/docs abierto).
grep -q "requireDocsAuth" backend/src/main.js || { echo "ABORT: requireDocsAuth no está montado en main.js." >&2; exit 1; }
grep -q "DOCS_USER" backend/.env.example || { echo "ABORT: DOCS_USER no está en .env.example (env-diff-check no lo exigiría)." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo ">> RECORDATORIO: poné DOCS_USER y DOCS_PASS en el .env del droplet y corré scripts/env-diff-check.sh ANTES de deployar."
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(docs): password-protect /api/docs + full OpenAPI update (100→539 paths)

HTTP Basic Auth (DOCS_USER/DOCS_PASS, constant-time compare; 503 when unset) on /api/docs and
/api/docs/openapi.json. openapi.js gains a compact route expander + 23 new tags and imports
extra-routes.generated.js (514 descriptors) so the whole live API is documented — citations,
inspections, incidents, inventory, planner, car-sharing, loaner, checkout, payment-gateway,
market intelligence, settings, catalog, reports-v2, etc. Hand-written paths win on conflicts.
Backend-only, no migration. New env: DOCS_USER, DOCS_PASS."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. En el droplet: env-diff-check.sh → build backend → force-recreate. Sin migración."
