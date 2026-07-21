#!/usr/bin/env bash
# Market Intelligence auto-apply (Engine A tax-aware) — money guardrails + price-change
# audit. Ship DARK.
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-20-ship-market-autoapply-betaNNN.sh
#
# QUÉ: el motor de Market Intelligence (MarketScrapeProfile / computeRunComparison —
# "Engine A", el tax-aware) puede AHORA escribir precios de renta por-clase EN VIVO
# (RateDailyPrice.daily) en el cron, en vez de solo sugerir. TODO gateado por
# guardrails de dinero: por (tenant, location) un floorBase + ceilingBase + maxDeltaPct
# en MarketPricingConfig; un movimiento fuera de banda se RETIENE (held) — jamás se
# aplica ni se clampa, para que un scrape roto no empuje un precio vivo fuera de rango.
# El motor es SELF-CLEANING: solo limpia sus PROPIOS overrides (RateDailyPrice.source =
# 'MARKET_A'); un surge de feriado/evento puesto a mano por el operador (source = null)
# es intocable y gana por la lógica override-wins de resolveForRental. Cada decisión
# (auto O manual) deja una fila PriceChangeLog (applied | held | clamped) — el audit de
# récord (AuditLog no se reusa: exige reservationId, y un cambio de precio no tiene
# reserva).
#
# SHIP DARK: MARKET_AUTOAPPLY_ENABLED default "false" (kill switch maestro, leído en
# código como `String(env.MARKET_AUTOAPPLY_ENABLED || 'false') === 'true'` →
# absence == dark). Con el flag off, el path de auto-apply NO escribe nada y Engine B
# (PricingRule) queda idéntico. Blast radius hoy = 0. Los módulos market-scraper/ y
# pricing-suggestions/ YA están montados en main.js (no se tocan main.js/worker.js) —
# esto sólo cambia sus internos + añade el módulo NUEVO market-autoapply-guardrails.js
# (importado por market-scrape-correction.service.js: si NO entra al tag, el backend NO
# BOOTEA aunque el flag esté off; el gate de import-resolve lo PRUEBA).
#
# ⚠️ .env DEL DROPLET (BLOQUEA EL DEPLOY): este tag añade UNA key nueva a .env.example
# → MARKET_AUTOAPPLY_ENABLED. env-diff-check.sh es fail-closed y FALLARÁ hasta que la
# key esté en el .env del droplet. Ship DARK: el default en código es false, así que la
# AUSENCIA de la key = dark, pero env-diff exige paridad de NOMBRES de key. El script
# imprime la key + su default. **La pone HECTOR a mano** en backend/.env del droplet
# (con backup) ANTES del deploy — el agente deployer rechaza autorización relayed
# (correcto). NO la enciendas ("false"). Mismo procedimiento que las ADVANTAGE_*/NU_*.
#
# QA: SHIP (money-safe, dark). Empaque quirúrgico (mismas lecciones del Advantage
# script):
#   - schema.prisma se stagea COMPLETO: QA confirmó (y este script RE-verifica) que el
#     diff working-vs-HEAD es MI-only — RateDailyPrice.source, MarketPricingConfig
#     .ceilingBase/.maxDeltaPct, model PriceChangeLog, MarketScrapeRun.autoApplyAt.
#     phoneNormalized/kiosk/quotes YA están commiteados en HEAD (context, no aparecen en
#     el diff) → no hay re-corte que hacer, PERO el gate aborta si algo ajeno se cuela.
#   - package.json se RE-CORTA a MI-only (copia de HEAD + splice quirúrgico de la línea
#     test:market-scraper) por si otro workstream contamina el working copy antes de
#     correr esto. El working copy se restaura (trap) para no perder ediciones ajenas.
#
# DEPLOY (BACKEND + WORKER + FRONTEND, CON migración additive):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   # migración additive por el puerto de SESIÓN 5432, NUNCA pgbouncer 6543:
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG:-SET-NEXT-BETA-TAG}"
SELF=".deploy-notes/2026-07-20-ship-market-autoapply-betaNNN.sh"

[ -n "$BRANCH" ] || { echo "ABORT: detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "ABORT: must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
# Próximo beta LIBRE = v0.9.0-beta.332 (327-331 ya existen y son ancestros de HEAD).
# Pásalo por TAG=v0.9.0-beta.332.
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "ABORT: set TAG=v0.9.0-beta.NNN — próximo libre es v0.9.0-beta.332 (327-331 existen)." >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — escoge otro." >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

# ── SCRATCH + TRAP ───────────────────────────────────────────────────────────
# El re-corte de package.json y el materializado de .env.example (para env-diff)
# modifican el working tree TEMPORALMENTE. El trap los restaura pase lo que pase —
# incluido un abort a mitad de camino. El script NUNCA deja el working tree modificado.
SCRATCH="$(mktemp -d)"
RESTORE_PKG=0; RESTORE_ENV=0
restore_tree() {
  [ "$RESTORE_PKG" = "1" ] && cp "$SCRATCH/pkg-working.json" backend/package.json || true
  [ "$RESTORE_ENV" = "1" ] && cp "$SCRATCH/env-working.example" backend/.env.example || true
  rm -rf "$SCRATCH" || true
}
trap restore_tree EXIT

# ── FILES[]: la lista EXPLÍCITA (nunca `git add -A`) ─────────────────────────
# main.js/worker.js NO cambian (market-scraper/ y pricing-suggestions/ ya están
# montados en HEAD). El ÚNICO archivo backend NUEVO en la cadena de imports es
# market-autoapply-guardrails.js (lo importa market-scrape-correction.service.js) →
# DEBE estar aquí o el backend no bootea. El gate de import-resolve lo PRUEBA sobre el
# árbol staged, no lo asume. schema.prisma y package.json se stagean aparte.
FILES=(
  # NUEVO — motor de guardrails (único archivo runtime backend nuevo)
  "backend/src/modules/market-scraper/market-autoapply-guardrails.js"
  # MI engine/services/routes modificados
  "backend/src/modules/market-scraper/market-scrape-correction.service.js"
  "backend/src/modules/market-scraper/market-scrape-runner.service.js"
  "backend/src/modules/market-scraper/market-scrape-comparison.service.js"
  "backend/src/modules/market-scraper/market-scraper.routes.js"
  "backend/src/modules/pricing-suggestions/pricing-suggestion-engine.service.js"
  "backend/src/modules/pricing-suggestions/pricing-suggestions.routes.js"
  "backend/src/modules/settings/settings.service.js"
  # tests
  "backend/src/modules/market-scraper/market-autoapply-guardrails.test.mjs"
  "backend/src/modules/market-scraper/market-autoapply.test.mjs"
  "backend/src/modules/market-scraper/market-autoapply-override-scope.test.mjs"
  "backend/src/modules/market-scraper/market-scrape-correction.test.mjs"
  "backend/src/modules/pricing-suggestions/pricing-engine-retire.test.mjs"
  # migración additive/idempotente + env (schema.prisma + package.json se stagean aparte)
  "backend/prisma/migrations/20260720_market_autoapply_guardrails/migration.sql"
  "backend/.env.example"
  # frontend — UI de config de guardrails (DEBE viajar junto: sin ella el paso 1 del
  # go-live "configura floor+ceiling+maxDeltaPct por location en Settings" no se puede)
  "frontend/src/app/settings/page.js"
  "frontend/src/app/globals.css"
  "$SELF"
)

# Archivos backend que cambian (para node --check). Incluye los 5 .mjs de test.
BACKEND_CHECK=(
  "backend/src/modules/market-scraper/market-autoapply-guardrails.js"
  "backend/src/modules/market-scraper/market-scrape-correction.service.js"
  "backend/src/modules/market-scraper/market-scrape-runner.service.js"
  "backend/src/modules/market-scraper/market-scrape-comparison.service.js"
  "backend/src/modules/market-scraper/market-scraper.routes.js"
  "backend/src/modules/pricing-suggestions/pricing-suggestion-engine.service.js"
  "backend/src/modules/pricing-suggestions/pricing-suggestions.routes.js"
  "backend/src/modules/settings/settings.service.js"
  "backend/src/modules/market-scraper/market-autoapply-guardrails.test.mjs"
  "backend/src/modules/market-scraper/market-autoapply.test.mjs"
  "backend/src/modules/market-scraper/market-autoapply-override-scope.test.mjs"
  "backend/src/modules/market-scraper/market-scrape-correction.test.mjs"
  "backend/src/modules/pricing-suggestions/pricing-engine-retire.test.mjs"
)

# ── GATE 1: node --check en todo archivo backend que cambia ──────────────────
for f in "${BACKEND_CHECK[@]}"; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
echo "GATE 1 OK: node --check limpio en los ${#BACKEND_CHECK[@]} archivos backend."

# ── GATE 2: ship-dark + wiring anclados en el CÓDIGO REAL ────────────────────
# El default false vive en código Y en .env.example. El módulo nuevo tiene que estar
# IMPORTADO por correction.service (call site, no definición).
grep -q "String(env.MARKET_AUTOAPPLY_ENABLED || 'false').toLowerCase() === 'true'" \
  backend/src/modules/market-scraper/market-autoapply-guardrails.js \
  || { echo "ABORT: el default fail-closed (|| 'false') del flag no está en guardrails.js" >&2; exit 1; }
grep -q "from './market-autoapply-guardrails.js'" \
  backend/src/modules/market-scraper/market-scrape-correction.service.js \
  || { echo "ABORT: correction.service NO importa market-autoapply-guardrails.js (call site ausente)" >&2; exit 1; }
grep -q 'MARKET_AUTOAPPLY_ENABLED="false"' backend/.env.example \
  || { echo "ABORT: MARKET_AUTOAPPLY_ENABLED no está en \"false\" en .env.example (ship dark)" >&2; exit 1; }
echo "GATE 2 OK: ship-dark (flag default false en código + .env.example) + import del guardrails anclados."

# ── m1: RE-CORTE de package.json → MI-only ───────────────────────────────────
# Copia de HEAD + splice de UNA línea (test:market-scraper, leída del working tree).
# El working copy ya está limpio (verificado: 1 sola línea de diff), pero el splice
# blinda contra que otro workstream contamine package.json antes de correr esto.
cp backend/package.json "$SCRATCH/pkg-working.json"; RESTORE_PKG=1
git show HEAD:backend/package.json > "$SCRATCH/pkg-head.json"
MS_LINE="$(grep '"test:market-scraper"' "$SCRATCH/pkg-working.json" || true)"
[ -n "$MS_LINE" ] || { echo "ABORT: no hay línea test:market-scraper en el package.json del working tree." >&2; exit 1; }
grep -q '"test:market-scraper"' "$SCRATCH/pkg-head.json" || { echo "ABORT: no hay ancla test:market-scraper en el package.json de HEAD." >&2; exit 1; }
grep -q 'market-autoapply' "$SCRATCH/pkg-head.json" && { echo "ABORT: HEAD ya referencia market-autoapply — ¿ya se shipeó?" >&2; exit 1; }
# Reemplaza la línea test:market-scraper de HEAD por la del working tree (que añade los
# 3 tests nuevos de autoapply + pricing-engine-retire).
awk -v ms="$MS_LINE" '/"test:market-scraper":/{print ms; next} {print}' \
  "$SCRATCH/pkg-head.json" > "$SCRATCH/pkg-cut.json"
node -e "JSON.parse(require('fs').readFileSync('$SCRATCH/pkg-cut.json','utf8'))" \
  || { echo "ABORT: el package.json re-cortado no es JSON válido." >&2; exit 1; }
cp "$SCRATCH/pkg-cut.json" backend/package.json
echo "m1 OK: package.json = copia de HEAD + solo la línea test:market-scraper."

# ── STAGE (idempotente) ──────────────────────────────────────────────────────
# schema.prisma se stagea COMPLETO desde el working tree (QA: MI-only, no re-corte);
# el GATE 3 lo verifica sobre el árbol staged. package.json va re-cortado.
git reset >/dev/null
git add -- backend/prisma/schema.prisma backend/package.json
git add -- "${FILES[@]}"
# Restaura YA package.json: el índice ya tiene la versión del tag, el working tree
# vuelve a ser de los otros workstreams.
cp "$SCRATCH/pkg-working.json" backend/package.json; RESTORE_PKG=0
echo "Staged. package.json working tree restaurado."

# ── GATE 3 (schema MI-only, fail-closed): el schema STAGED ───────────────────
# QA CONFIRMÓ el diff MI-only; esto lo RE-verifica sobre lo staged. Cuatro checks:
#   (a) toda línea BORRADA es un comentario (cero campos/modelos removidos → cambio de
#       schema NO destructivo; el único delete es el rewrite del doc-comment de
#       pricesApplied).
#   (b) shape exacto: 43 líneas añadidas, 3 borradas (tripwire — si drifta, revisión
#       humana).
#   (c) markers MI presentes.
#   (d) contaminación fuera: nada de phoneNormalized/kiosk/Quote en las líneas añadidas.
SCHEMA_DIFF="$(git diff --cached -- backend/prisma/schema.prisma)"
NONCOMMENT_DEL="$(printf '%s\n' "$SCHEMA_DIFF" | grep -E '^-[^-]' | grep -vE '^-[[:space:]]*//' || true)"
[ -z "$NONCOMMENT_DEL" ] || { echo "ABORT (schema): el diff BORRA líneas que NO son comentarios (posible cambio destructivo):"; printf '%s\n' "$NONCOMMENT_DEL"; git reset >/dev/null; exit 1; }
ADD_N="$(printf '%s\n' "$SCHEMA_DIFF" | grep -cE '^\+[^+]' || true)"
DEL_N="$(printf '%s\n' "$SCHEMA_DIFF" | grep -cE '^-[^-]' || true)"
[ "$ADD_N" = "43" ] && [ "$DEL_N" = "3" ] || { echo "ABORT (schema): shape inesperado (+$ADD_N/-$DEL_N, esperaba +43/-3). El diff cambió → revísalo a mano:"; printf '%s\n' "$SCHEMA_DIFF"; git reset >/dev/null; exit 1; }
for m in 'model PriceChangeLog' 'ceilingBase' 'maxDeltaPct' 'autoApplyAt'; do
  printf '%s\n' "$SCHEMA_DIFF" | grep -qE "^\+.*$m" || { echo "ABORT (schema): falta el marker MI '$m' en las líneas añadidas." >&2; git reset >/dev/null; exit 1; }
done
printf '%s\n' "$SCHEMA_DIFF" | grep -qE '^\+[[:space:]]*source[[:space:]]+String' || { echo "ABORT (schema): falta RateDailyPrice.source en las líneas añadidas." >&2; git reset >/dev/null; exit 1; }
SCHEMA_BADTOK="$(printf '%s\n' "$SCHEMA_DIFF" | grep -E '^\+' | grep -iE 'phoneNormaliz|kiosk|model[[:space:]]+Quote' || true)"
[ -z "$SCHEMA_BADTOK" ] || { echo "ABORT (schema): contaminación de otro workstream en el schema staged:"; printf '%s\n' "$SCHEMA_BADTOK"; git reset >/dev/null; exit 1; }
echo "GATE 3 OK: schema staged = MI-only (+43/-3, deletes comment-only, markers presentes, sin phoneNormalized/kiosk/quotes)."

# ── GATE 4 (package.json staged = UNA línea) ─────────────────────────────────
PKG_CHANGED="$(git diff --cached -- backend/package.json | grep -E '^[+-][^+-]' || true)"
PKG_COUNT="$(printf '%s\n' "$PKG_CHANGED" | grep -c . || true)"
[ "$PKG_COUNT" = "2" ] || { echo "ABORT (pkg): package.json staged con $PKG_COUNT líneas cambiadas, esperaba 2 (−1/+1 de test:market-scraper):"; echo "$PKG_CHANGED"; git reset >/dev/null; exit 1; }
printf '%s\n' "$PKG_CHANGED" | grep -q 'market-autoapply' || { echo "ABORT (pkg): la línea cambiada del package.json no añade los tests de market-autoapply:"; echo "$PKG_CHANGED"; git reset >/dev/null; exit 1; }
echo "GATE 4 OK: package.json staged = swap de la línea test:market-scraper (−1/+1)."

# ── GATE 5: NADA de otro workstream puede viajar en el tag ───────────────────
# QA marcó explícitamente estos paths como must-not-stage. Se grepea el DIFF STAGED
# (no el working tree). También: sólo UNA migración (la de MI) puede entrar.
STAGED_NAMES="$(git diff --cached --name-only)"
LEAK="$(printf '%s\n' "$STAGED_NAMES" | grep -E \
  'modules/quotes/|middleware/tenant-rate-limit|booking-source\.test\.mjs|tl-rematch-existing|\.fuse_hidden|modules/reservations/|modules/rental-agreements/' || true)"
[ -z "$LEAK" ] || { echo "ABORT: archivos de OTRO workstream (must-not-stage de QA) staged:"; printf '%s\n' "$LEAK"; git reset >/dev/null; exit 1; }
# Contaminación por TOKEN en las líneas añadidas del diff staged — EXCLUYENDO el
# propio ship script (contiene 'phoneNormalized'/'kiosk' en sus comentarios y en el
# regex de este mismo guard → auto-match falso positivo). Se escanea sólo el código.
STAGED_ADDED="$(git diff --cached -- ':!.deploy-notes/*' | grep -E '^\+[^+]' || true)"
BADTOK="$(printf '%s\n' "$STAGED_ADDED" | grep -iE 'phoneNormaliz|\bkiosk\b' || true)"
[ -z "$BADTOK" ] || { echo "ABORT: tokens de otro workstream (phoneNormalized/kiosk) en el diff staged:"; printf '%s\n' "$BADTOK" | head; git reset >/dev/null; exit 1; }
# Sólo la migración de MI.
MIGS="$(printf '%s\n' "$STAGED_NAMES" | grep 'prisma/migrations/' || true)"
[ "$MIGS" = "backend/prisma/migrations/20260720_market_autoapply_guardrails/migration.sql" ] \
  || { echo "ABORT: set de migraciones staged inesperado:"; printf '%s\n' "$MIGS"; git reset >/dev/null; exit 1; }
echo "GATE 5 OK: staged diff = MI-only (sin quotes / rate-limit / booking-source.test / reservations / rental-agreements / kiosk / FUSE; 1 sola migración)."

# ── GATE 6: IMPORT-RESOLVE sobre el ÁRBOL STAGED (el gate del boot) ──────────
# Se materializa el índice ENTERO (= exactamente el árbol del tag) y se camina cada
# import relativo estático Y dinámico desde main.js + worker.js. Un import top-level a
# un archivo que no entró al tag = el backend no bootea. Esto lo PRUEBA. (Causa #1 de
# boot crash en este repo.)
STAGED_TREE="$SCRATCH/staged-tree"; mkdir -p "$STAGED_TREE"
git checkout-index -a --prefix="$STAGED_TREE/"
cat > "$SCRATCH/resolve-chain.mjs" <<'RESOLVER_EOF'
import fs from 'node:fs';
import path from 'node:path';
const roots = process.argv.slice(2);
const seen = new Set(); const missing = []; let count = 0;
const RE = /(?:\bfrom\s*|\bimport\s*|\bexport\s+\*\s*from\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}
function resolveFile(p) {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  for (const ext of ['.js', '.mjs', '.json']) if (fs.existsSync(p + ext)) return p + ext;
  for (const idx of ['/index.js', '/index.mjs']) if (fs.existsSync(p + idx)) return p + idx;
  return null;
}
function walk(file, from) {
  const real = resolveFile(file);
  if (!real) { missing.push(`${from || '(entry)'}  ->  ${file}`); return; }
  if (seen.has(real)) return;
  seen.add(real); count++;
  for (const m of stripComments(fs.readFileSync(real, 'utf8')).matchAll(RE)) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    walk(path.resolve(path.dirname(real), spec), real);
  }
}
for (const r of roots) walk(path.resolve(r), null);
if (missing.length) {
  console.error(`CHAIN BROKEN — ${missing.length} import(s) sin resolver EN EL ÁRBOL DEL TAG:`);
  for (const m of missing) console.error('  ' + m);
  console.error('El backend NO BOOTEARÍA. Añade el/los archivo(s) a FILES[].');
  process.exit(1);
}
console.log(`CHAIN RESOLVES OK — ${count} módulos alcanzables desde ${roots.length} entrypoints.`);
RESOLVER_EOF
node "$SCRATCH/resolve-chain.mjs" "$STAGED_TREE/backend/src/main.js" "$STAGED_TREE/backend/src/worker.js" \
  || { echo "ABORT: la cadena de imports del ÁRBOL STAGED está rota (causa #1 de boot crash)." >&2; git reset >/dev/null; exit 1; }
# El módulo NUEVO tiene que estar en el árbol del tag (si falta, correction.service no
# importa nada al bootear → MODULE_NOT_FOUND).
[ -f "$STAGED_TREE/backend/src/modules/market-scraper/market-autoapply-guardrails.js" ] \
  || { echo "ABORT: market-autoapply-guardrails.js NO está en el árbol del tag." >&2; git reset >/dev/null; exit 1; }
echo "GATE 6 OK: cadena main.js/worker.js → market-scraper + pricing-suggestions + settings resuelve DESDE EL ÁRBOL STAGED (guardrails.js presente)."

# ── GATE 7: TESTS ────────────────────────────────────────────────────────────
# DB de dev en la Mac = localhost:5432/fleet_management (backend/.env apunta al 5433
# MUERTO; la forma postgres:postgres FALLA — mordió dos ship scripts hoy). Se sondea
# 5432 primero; los suites DB-backed (market-scraper 119 + rates) se SALTAN RUIDOSO si
# 5432 está caído. Los suites shared-source (nu/economy/booking-source) son DB-free
# (probado por el Advantage script) → corren siempre como red de regresión.
if nc -z localhost 5432 >/dev/null 2>&1; then
  ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run test:market-scraper ) \
    || { echo "ABORT: test:market-scraper falló contra la DB de dev (5432)" >&2; git reset >/dev/null; exit 1; }
  ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run test:rates ) \
    || { echo "ABORT: test:rates falló contra la DB de dev (5432)" >&2; git reset >/dev/null; exit 1; }
  echo "GATE 7 OK: test:market-scraper (119) + test:rates verdes contra localhost:5432."
else
  echo "############################################################"
  echo "GATE 7 SKIP (RUIDOSO): no hay postgres en localhost:5432 →"
  echo "test:market-scraper (119, DB-backed) + test:rates NO corrieron."
  echo "Levanta la DB de dev (postgresql://\$(whoami)@localhost:5432/"
  echo "fleet_management) y re-corre este script para la prueba completa"
  echo "antes de confiar en el tag."
  echo "############################################################"
fi
# Regresión shared-source (DB-free) — SIEMPRE.
( cd backend && npm run test:nu )             || { echo "ABORT: test:nu falló (regresión shared-source)" >&2; git reset >/dev/null; exit 1; }
( cd backend && npm run test:economy )        || { echo "ABORT: test:economy falló (regresión shared-source)" >&2; git reset >/dev/null; exit 1; }
( cd backend && npm run test:booking-source ) || { echo "ABORT: test:booking-source falló (regresión shared-source)" >&2; git reset >/dev/null; exit 1; }
echo "GATE 7b OK: regresión shared-source verde (nu · economy · booking-source, DB-free)."

# ── GATE 8: BUILD DEL FRONTEND ───────────────────────────────────────────────
# Corre sobre el working tree (next necesita node_modules, que el árbol staged no
# tiene). Los archivos frontend del tag (settings/page.js + globals.css) son los mismos
# del working tree (verificado MI-only), así que el build es representativo.
( cd frontend && npx next build ) || { echo "ABORT: next build falló" >&2; git reset >/dev/null; exit 1; }
echo "GATE 8 OK: next build limpio."

# ── GATE 9: ENV PARITY (fail-closed, contra el DROPLET) ──────────────────────
# Se corre contra la copia EXACTA de .env.example del tag (= la staged), no contra el
# working tree (que podría cargar keys de otro workstream). Backup/restore trick:
# materializa la copia staged en disco, corre env-diff, restaura. FALLARÁ hasta que
# MARKET_AUTOAPPLY_ENABLED esté en el .env del droplet. NO se rodea. `< /dev/null`
# porque el SSH de env-diff-check se COME el stdin.
cp backend/.env.example "$SCRATCH/env-working.example"; RESTORE_ENV=1
git show :backend/.env.example > backend/.env.example
if ! bash scripts/env-diff-check.sh < /dev/null; then
  cp "$SCRATCH/env-working.example" backend/.env.example; RESTORE_ENV=0
  echo
  echo "############################################################"
  echo "env-diff-check FALLÓ — falta la key nueva en el .env del droplet."
  echo "Esto NO se rodea. HECTOR la añade a mano a backend/.env del droplet"
  echo "(con backup .env.bak-$(date +%F)-market-autoapply) ANTES del deploy —"
  echo "el agente deployer rechaza autorización relayed."
  echo
  echo "La UNA key nueva, con su default (ship DARK — NO la enciendas):"
  echo "------------------------------------------------------------"
  grep -E '^MARKET_AUTOAPPLY' backend/.env.example
  echo "------------------------------------------------------------"
  echo "Luego re-corre este script."
  echo "############################################################"
  git reset >/dev/null; exit 1
fi
cp "$SCRATCH/env-working.example" backend/.env.example; RESTORE_ENV=0
echo "GATE 9 OK: env parity contra el droplet."

# ── REVIEW ───────────────────────────────────────────────────────────────────
echo; git status --short -- "${FILES[@]}" backend/prisma/schema.prisma backend/package.json; echo
git diff --cached --stat; echo
echo "Revisa el schema staged:      git diff --cached -- backend/prisma/schema.prisma"
echo "Revisa el package.json staged: git diff --cached -- backend/package.json"
echo
# `read < /dev/tty`: NUNCA heredar el stdin (env-diff-check/ssh se lo come → prompt
# tragado y varios scripts colgados).
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Dejado staged (sin commitear). Para desestagear: git reset"; exit 0; }

git commit -m "feat(market-intelligence): auto-apply engine with money guardrails + price-change audit (dark)

Engine A (tax-aware MI) may now WRITE live per-class rental prices
(RateDailyPrice.daily) on the cron instead of only suggesting. Every
write goes through per-(tenant, location) money guardrails on
MarketPricingConfig: floorBase + ceilingBase + maxDeltaPct. A move beyond
the maxDeltaPct band vs the current live resolved price is HELD -- never
applied, never clamped -- so a broken scrape can't push a live price out
of band. The engine is self-cleaning: it only clears its OWN overrides
(RateDailyPrice.source = 'MARKET_A'); an operator-set holiday/event surge
(source = null) is untouched and wins via resolveForRental override-wins.

Every decision (auto OR manual) writes a PriceChangeLog row
(applied | held | clamped) -- the audit of record for MI price changes
(AuditLog can't be reused: it hard-requires a reservationId, and a price
change has no reservation). New PriceChangeLog table + guardrail columns
(ceilingBase, maxDeltaPct) + RateDailyPrice.source + MarketScrapeRun
.autoApplyAt, all additive/idempotent.

Ships DARK: MARKET_AUTOAPPLY_ENABLED defaults false (master kill switch,
read as String(env || 'false') === 'true'). With the flag off the
auto-apply path writes nothing and Engine B (PricingRule) is unchanged.
Frontend adds the per-location guardrail config UI in Settings -> Market
Intelligence (floor/ceiling/maxDeltaPct) so enablement step 1 is doable.

Packaging: schema.prisma staged whole (verified MI-only vs HEAD:
+43/-3, deletes comment-only); package.json re-cut to HEAD + the single
test:market-scraper line."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"

cat <<EOF

Pushed $TAG.

PRE-DEPLOY (HECTOR, a mano): añadir la key MARKET_AUTOAPPLY_ENABLED="false" a
backend/.env del droplet (con backup del .env). Sin eso env-diff-check falla y el
deploy para. NO la enciendas — ship DARK.

DROPLET:
  git fetch --tags && git checkout $TAG
  docker compose -f docker-compose.prod.yml build backend worker frontend
  docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
  # migración additive por el puerto de SESIÓN 5432, NUNCA pgbouncer 6543:
  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo "\$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'

VERIFICACIÓN (un push verde NO es un deploy verde):
  [ ] 3 contenedores healthy (fleet-backend-prod, fleet-worker-prod, fleet-frontend-prod), 0 restarts
  [ ] boot LIMPIO: sin MODULE_NOT_FOUND ni TypeError (la cadena estática
      main.js -> market-scraper.routes -> market-scrape-correction.service ->
      market-autoapply-guardrails.js tiene que resolver aunque el flag esté off)
  [ ] /health 200 (interno y público /api/health)
  [ ] migración aplicada por 5432: columnas "MarketPricingConfig"."ceilingBase"/"maxDeltaPct",
      "RateDailyPrice"."source", "MarketScrapeRun"."autoApplyAt" y tabla "PriceChangeLog" existen
  [ ] PRUEBA DE DARK MODE: MARKET_AUTOAPPLY_ENABLED != "true" en el droplet → el cron NO
      escribe RateDailyPrice; el reporte MI sigue siendo review-only (Engine B intacto)
  [ ] Settings -> Market Intelligence: los campos Ceiling (base \$) + Max delta % cargan
      por location (configurable, pero inerte con el flag off)

=================  SHIPS DARK  =================================================
MARKET_AUTOAPPLY_ENABLED default "false" → el auto-apply NO escribe precios vivos.
El deploy NO cambia comportamiento hasta que Hector siga el go-live ABAJO.

ORDEN DE GO-LIVE (HECTOR, aparte, cuando quiera encender — el ORDEN IMPORTA;
un orden equivocado FALLA CERRADO = HOLD, nunca un precio malo):
  (1) Configura los guardrails por-location en Settings -> Market Intelligence:
      floorBase + ceilingBase + maxDeltaPct. Sin maxDeltaPct configurado, ese
      location FALLA-CERRADO (HOLD) — no se aplica nada.
  (2) Una vez por rate manejado: force-apply MANUAL una vez para SEMBRAR la base
      (la primera corrida absorbe el gross-down; el oldDaily del PriceChangeLog
      viene del header fallback si aún no hay base sembrada).
  (3) Pon autoApply=true en el/los profile(s) de MarketScrapeProfile.
  (4) Flip MARKET_AUTOAPPLY_ENABLED="true" en el .env del droplet + \`restart
      backend worker\` (sin rebuild).
  Regla: AUTO escribe SOLO cuando (4) master ON **y** (3) profile autoApply=true
  **y** (1) guardrails configurados **y** el movimiento cae DENTRO de la banda
  maxDeltaPct. Cualquier pieza que falte = HOLD (fail-closed).
EOF
