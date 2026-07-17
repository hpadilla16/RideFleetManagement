#!/usr/bin/env bash
# Advantage (TSD RezCentral) — 5ta integración autónoma de booking-source. Ship DARK.
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-17-ship-advantage-integration-betaNNN.sh
#
# QUÉ: quinta booking-source (TL → Economy → NU → Flexways → ADVANTAGE) montada
# sobre el andamiaje compartido `booking-source/` (promote, customer-autocreate,
# scheduler-factory, window, http-common, promotion-matcher). Advantage vive dentro
# de TSD RezCentral (rezcentral.tsdasp.net/WebRezClient), un back-office ASP.NET
# WebForms: login por HTTP plano (SIN captcha — recon Fase 0), navegación por
# postback de menú (single-window estricto de TSD), parser del grid del reporte.
# MULTI-CONFIG por PAR (tsdNumber, branch) → AdvantageLocationConfig, porque el
# grid devuelve el par en UNA celda (`Loc` = "61302.MCO"). Cero tenant/location
# hardcodeado: todo mapping es data.
#
# COMPARTIDO (toca 4 fuentes vivas): promotion-matcher.service.js gana
# `overrideCustomerId` (el caller que acaba de crear el customer no re-busca) +
# `isPlaceholderPhone` (guard del teléfono degenerado all-zeros — ~50% de las filas
# de Advantage no traen email, y sin el guard un placeholder matchea el pool
# entero). Regresión probada abajo: nu 60 / economy 41 / booking-source 42 verdes
# SIN tocar sus tests.
#
# SHIP DARK: ADVANTAGE_INTEGRATION_ENABLED default "false" → worker.js NO registra
# el handler advantage.sync y el scheduler-factory no arranca. Rutas montadas
# (admin-gated) pero inertes. Blast radius hoy = 0. Encender = flag + credenciales
# + >= 1 AdvantageLocationConfig enabled.
#
# PIPELINE: QA FIX-FIRST → el CÓDIGO Advantage quedó SHIP sin cambios; el ÚNICO
# blocker era el EMPAQUE (este script). Los dos must-fix de QA están implementados
# como gates abajo:
#   M1 (MAJOR) — schema.prisma RE-CORTADO a Advantage-only. El working tree carga
#     `Customer.phoneNormalized` de un workstream AJENO (VozIA/customers-phone) cuya
#     migración 20260715_customer_phone_normalized/ y extensión de lib/prisma.js
#     están UNTRACKED. Prisma emite la columna en todo default-select de Customer →
#     en prod (donde 20260715 NO está aplicada) eso es un P2022 en CADA query de
#     Customer. Y beta-ci.yml solo corre prisma:generate + node --check + un
#     import-resolve (sin DB, nunca `npm test`) → CI VERDE mientras prod muere.
#     El commit c97dbda de este repo es el hotfix de beta.315 por exactamente este
#     error. NO se arregla stageando la 20260715: se re-corta el schema.
#   m1 (MINOR) — package.json RE-CORTADO a Advantage-only (copia de HEAD + splice
#     quirúrgico de la línea test:advantage). El working copy contamina el tag con
#     test:customers-phone, tests de swap-photos y kiosk-name-update.test.mjs, cuyos
#     archivos están untracked.
#
# ⚠️ .env DEL DROPLET (BLOQUEA EL DEPLOY): este tag añade 11 keys ADVANTAGE_* a
# .env.example → env-diff-check.sh FALLA hasta que estén en el .env del droplet.
# El script imprime las 11 keys con sus defaults. **Las pone HECTOR a mano** (el
# agente deployer rechaza autorización relayed — correcto). Mismo procedimiento que
# las ECONOMY_*/NU_*/FLEXWAYS_*. ADVANTAGE_INTEGRATION_ENABLED="false" — NO encender.
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
SELF=".deploy-notes/2026-07-17-ship-advantage-integration-betaNNN.sh"

[ -n "$BRANCH" ] || { echo "ABORT: detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "ABORT: must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
# TAG sentinel: 302 y 312-316 los tomó el workstream de KIOSK; beta.317 fue el
# último shipeado. Escoge el próximo libre y pásalo por TAG=.
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "ABORT: set TAG=v0.9.0-beta.NNN (próximo beta libre; 302 y 312-316 son de kiosk, 317 ya salió)." >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — escoge otro." >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

# ── SCRATCH + TRAP ───────────────────────────────────────────────────────────
# El re-corte de M1/m1 modifica schema.prisma y package.json TEMPORALMENTE en el
# working tree (git solo stagea desde el working tree). El trap los restaura pase
# lo que pase — incluido un abort a mitad de camino. El script NUNCA deja el
# working tree modificado.
SCRATCH="$(mktemp -d)"
RESTORE_SCHEMA=0; RESTORE_PKG=0
restore_tree() {
  [ "$RESTORE_SCHEMA" = "1" ] && cp "$SCRATCH/schema-working.prisma" backend/prisma/schema.prisma || true
  [ "$RESTORE_PKG" = "1" ] && cp "$SCRATCH/pkg-working.json" backend/package.json || true
  rm -rf "$SCRATCH" || true
}
trap restore_tree EXIT

# ── FILES[]: la lista EXPLÍCITA (nunca `git add -A`) ─────────────────────────
# CADA módulo de la cadena de imports estáticos DEBE estar aquí: main.js importa
# advantage.routes.js ESTÁTICAMENTE → arrastra service/worker/scheduler/constants →
# booking-source/*. Si falta uno, el backend NO BOOTEA aunque el flag esté off.
# (Causa #1 de boot crash en este repo — ya pasó dos veces.) El gate de
# import-resolve más abajo lo PRUEBA sobre el árbol staged, no lo asume.
FILES=(
  # Advantage — directorio COMPLETO (incluye los 3 archivos de test de test:advantage)
  "backend/src/modules/integrations/advantage/advantage.constants.js"
  "backend/src/modules/integrations/advantage/advantage.service.js"
  "backend/src/modules/integrations/advantage/advantage.worker.js"
  "backend/src/modules/integrations/advantage/advantage.scheduler.js"
  "backend/src/modules/integrations/advantage/advantage.routes.js"
  "backend/src/modules/integrations/advantage/advantage.test.mjs"
  "backend/src/modules/integrations/advantage/advantage.routes.test.mjs"
  "backend/src/modules/integrations/advantage/advantage-worker.test.mjs"
  # migración additive/idempotente (schema.prisma se stagea RE-CORTADO, aparte)
  "backend/prisma/migrations/20260716_advantage_integration/migration.sql"
  # wiring gateado + env
  "backend/src/main.js"
  "backend/src/worker.js"
  "backend/.env.example"
  # capa compartida (overrideCustomerId + isPlaceholderPhone)
  "backend/src/modules/integrations/booking-source/promotion-matcher.service.js"
  # frontend
  "frontend/src/components/settings/AdvantageIntegrationPanel.jsx"
  "frontend/src/lib/advantage-location-contract.js"
  "frontend/src/app/settings/page.js"
  "frontend/src/app/reservations/page.js"
  "frontend/src/components/reservations/PendingFranchiseImportsTray.jsx"
  "$SELF"
)

# ── GATE 1: node --check en todo archivo backend que cambia ──────────────────
for f in constants service worker scheduler routes; do
  node --check "backend/src/modules/integrations/advantage/advantage.$f.js" \
    || { echo "ABORT: node --check advantage.$f.js" >&2; exit 1; }
done
node --check backend/src/main.js   || { echo "ABORT: node --check main.js" >&2; exit 1; }
node --check backend/src/worker.js || { echo "ABORT: node --check worker.js" >&2; exit 1; }
node --check backend/src/modules/integrations/booking-source/promotion-matcher.service.js \
  || { echo "ABORT: node --check promotion-matcher.service.js" >&2; exit 1; }
echo "GATE 1 OK: node --check limpio en los 7 archivos backend."

# ── GATE 2: wiring — anclado en CALL SITES, nunca en definiciones ────────────
# (Dos falsos positivos hoy por gates que grepeaban la DEFINICIÓN de una función
# —presente— en vez de su LLAMADA —ausente—. Aquí se ancla en el uso real.)
grep -q "advantageRouter" backend/src/main.js \
  || { echo "ABORT: main.js no monta advantageRouter" >&2; exit 1; }
grep -q "ADVANTAGE_INTEGRATION_ENABLED" backend/src/worker.js \
  || { echo "ABORT: worker.js no gatea advantage bajo el flag" >&2; exit 1; }
grep -q "registerAdvantageSyncWorker()" backend/src/worker.js \
  || { echo "ABORT: worker.js no LLAMA registerAdvantageSyncWorker()" >&2; exit 1; }
grep -q "startAdvantageSyncScheduler()" backend/src/worker.js \
  || { echo "ABORT: worker.js no LLAMA startAdvantageSyncScheduler()" >&2; exit 1; }
# CALL SITE de la capa compartida: advantage.worker.js debe PASAR overrideCustomerId
# (la definición vive en promotion-matcher y siempre está presente → no sirve de ancla).
grep -q "overrideCustomerId: newCust.id" backend/src/modules/integrations/advantage/advantage.worker.js \
  || { echo "ABORT: advantage.worker.js no pasa overrideCustomerId al promoter (call site ausente)" >&2; exit 1; }
grep -q "isPlaceholderPhone(extRes.customerPhone)" backend/src/modules/integrations/booking-source/promotion-matcher.service.js \
  || { echo "ABORT: promotion-matcher no LLAMA isPlaceholderPhone (call site ausente)" >&2; exit 1; }
grep -q 'ADVANTAGE_INTEGRATION_ENABLED="false"' backend/.env.example \
  || { echo "ABORT: ADVANTAGE_INTEGRATION_ENABLED no está en false (ship dark)" >&2; exit 1; }
echo "GATE 2 OK: wiring + ship-dark anclados en call sites."

# ── M1: RE-CORTE de schema.prisma → Advantage-only ───────────────────────────
# El diff working-vs-HEAD del schema son TRES hunks, todos additivos: (1) la
# relación Tenant.advantageLocationConfigs, (2) Customer.phoneNormalized [AJENO],
# (3) el modelo AdvantageLocationConfig. Se borra el bloque (2) — el comentario
# VozIA de 3 líneas + el campo — y quedan solo (1) y (3).
cp backend/prisma/schema.prisma "$SCRATCH/schema-working.prisma"; RESTORE_SCHEMA=1
awk '
  /^[[:space:]]*\/\/ VozIA gap #4 \(2026-07-15\)/ { skip=1 }
  skip && /^[[:space:]]*phoneNormalized[[:space:]]+String\?/ { skip=0; next }
  skip { next }
  { print }
' "$SCRATCH/schema-working.prisma" > "$SCRATCH/schema-cut.prisma"

CUT_LINES=$(( $(wc -l < "$SCRATCH/schema-working.prisma") - $(wc -l < "$SCRATCH/schema-cut.prisma") ))
[ "$CUT_LINES" = "4" ] || { echo "ABORT: el re-corte del schema borró $CUT_LINES líneas, esperaba 4 (3 de comentario + el campo). El bloque phoneNormalized cambió de forma — revisa a mano." >&2; exit 1; }
grep -q "phoneNormalized" "$SCRATCH/schema-cut.prisma" && { echo "ABORT: phoneNormalized SIGUE en el schema re-cortado." >&2; exit 1; }
grep -q "model AdvantageLocationConfig" "$SCRATCH/schema-cut.prisma" || { echo "ABORT: el schema re-cortado perdió AdvantageLocationConfig." >&2; exit 1; }
cp "$SCRATCH/schema-cut.prisma" backend/prisma/schema.prisma
# El schema RE-CORTADO tiene que seguir siendo válido: un re-corte que rompe el
# schema es peor que el contaminante (prisma generate revienta en el build).
( cd backend && npx prisma validate ) || { echo "ABORT (M1): el schema RE-CORTADO no valida." >&2; exit 1; }
echo "M1 OK: schema re-cortado (−4 líneas: phoneNormalized + su comentario) y prisma validate limpio."

# ── m1: RE-CORTE de package.json → Advantage-only ────────────────────────────
# La copia de HEAD + splice de UNA línea (test:advantage), insertada tras
# test:flexways. El working copy trae además test:customers-phone, los tests de
# swap-photos y kiosk-name-update.test.mjs — todos con archivos untracked → si
# entran al tag, `npm test` en CI/prod revienta buscando archivos que no existen.
# Se restaura el working copy al final (trap) para que los otros CUATRO
# workstreams conserven sus ediciones.
cp backend/package.json "$SCRATCH/pkg-working.json"; RESTORE_PKG=1
git show HEAD:backend/package.json > "$SCRATCH/pkg-head.json"
ADV_LINE="$(grep '"test:advantage"' "$SCRATCH/pkg-working.json" || true)"
[ -n "$ADV_LINE" ] || { echo "ABORT: no hay línea test:advantage en el package.json del working tree." >&2; exit 1; }
grep -q '"test:advantage"' "$SCRATCH/pkg-head.json" && { echo "ABORT: HEAD ya tiene test:advantage — ¿ya se shipeó?" >&2; exit 1; }
grep -q '"test:flexways"' "$SCRATCH/pkg-head.json" || { echo "ABORT: no hay ancla test:flexways en el package.json de HEAD." >&2; exit 1; }
awk -v adv="$ADV_LINE" '
  { print }
  /"test:flexways":/ && !done { print adv; done=1 }
' "$SCRATCH/pkg-head.json" > "$SCRATCH/pkg-cut.json"
node -e "JSON.parse(require('fs').readFileSync('$SCRATCH/pkg-cut.json','utf8'))" \
  || { echo "ABORT: el package.json re-cortado no es JSON válido." >&2; exit 1; }
cp "$SCRATCH/pkg-cut.json" backend/package.json
echo "m1 OK: package.json = copia de HEAD + solo la línea test:advantage."

# ── STAGE (idempotente) ──────────────────────────────────────────────────────
git reset >/dev/null
git add -- backend/prisma/schema.prisma backend/package.json
git add -- "${FILES[@]}"
# Restaura YA los dos archivos re-cortados: el índice ya tiene la versión del tag,
# el working tree vuelve a ser de los otros workstreams.
cp "$SCRATCH/schema-working.prisma" backend/prisma/schema.prisma; RESTORE_SCHEMA=0
cp "$SCRATCH/pkg-working.json" backend/package.json;              RESTORE_PKG=0
echo "Staged. Working tree restaurado (los otros 4 workstreams intactos)."

# ── GATE 3 (M1 regression guard, RUIDOSO): el schema STAGED ──────────────────
STAGED_SCHEMA="$(git show :backend/prisma/schema.prisma)"
if grep -q "phoneNormalized" <<<"$STAGED_SCHEMA"; then
  echo "############################################################" >&2
  echo "ABORT (M1): el schema STAGED contiene phoneNormalized." >&2
  echo "Su migración 20260715 NO está en el tag → P2022 en CADA" >&2
  echo "default-select de Customer en prod. CI NO lo caza (no corre" >&2
  echo "DB). Es exactamente el fallo del hotfix c97dbda (beta.315)." >&2
  echo "############################################################" >&2
  git reset >/dev/null; exit 1
fi
grep -q "model AdvantageLocationConfig" <<<"$STAGED_SCHEMA" \
  || { echo "ABORT (M1): el schema staged NO tiene AdvantageLocationConfig." >&2; git reset >/dev/null; exit 1; }
grep -q "advantageLocationConfigs" <<<"$STAGED_SCHEMA" \
  || { echo "ABORT (M1): el schema staged NO tiene la relación Tenant.advantageLocationConfigs." >&2; git reset >/dev/null; exit 1; }
# El schema es PURAMENTE additivo vs HEAD: cero líneas borradas.
SCHEMA_DEL="$(git diff --cached backend/prisma/schema.prisma | grep -E '^-[^-]' || true)"
[ -z "$SCHEMA_DEL" ] || { echo "ABORT (M1): el schema staged BORRA líneas vs HEAD:"; echo "$SCHEMA_DEL"; git reset >/dev/null; exit 1; }
echo "GATE 3 OK: schema staged = HEAD + Advantage-only (additivo, sin phoneNormalized)."

# ── GATE 4 (m1 regression guard): el package.json STAGED = UNA línea ─────────
PKG_CHANGED="$(git diff --cached backend/package.json | grep -E '^[+-][^+-]' || true)"
PKG_COUNT="$(printf '%s\n' "$PKG_CHANGED" | grep -c . || true)"
[ "$PKG_COUNT" = "1" ] || { echo "ABORT (m1): package.json staged con $PKG_COUNT líneas cambiadas, esperaba 1:"; echo "$PKG_CHANGED"; git reset >/dev/null; exit 1; }
grep -q 'test:advantage' <<<"$PKG_CHANGED" || { echo "ABORT (m1): la única línea cambiada del package.json no es test:advantage:"; echo "$PKG_CHANGED"; git reset >/dev/null; exit 1; }
echo "GATE 4 OK: package.json staged = +1 línea (test:advantage)."

# ── GATE 5: NADA de otro workstream puede viajar en el tag ───────────────────
# QA clasificó cada uno. Se grepea el DIFF STAGED (no el working tree).
STAGED_NAMES="$(git diff --cached --name-only)"
LEAK="$(printf '%s\n' "$STAGED_NAMES" | grep -E \
  'migrations/20260715_customer_phone_normalized/|^backend/src/lib/prisma\.js$|^backend/src/lib/customer-phone-normalize|^backend/src/modules/customers/customers\.service\.js$|backfill-customer-phone-normalized|^backend/src/modules/reservations/|^backend/src/modules/rental-agreements/|^frontend/src/locales/|^frontend/src/app/reservations/\[id\]/swap/|kiosk|\.fuse_hidden' || true)"
[ -z "$LEAK" ] || { echo "ABORT: archivos de OTRO workstream staged:"; printf '%s\n' "$LEAK"; git reset >/dev/null; exit 1; }
# Solo puede entrar UNA migración: la de Advantage.
MIGS="$(printf '%s\n' "$STAGED_NAMES" | grep 'prisma/migrations/' || true)"
[ "$MIGS" = "backend/prisma/migrations/20260716_advantage_integration/migration.sql" ] \
  || { echo "ABORT: set de migraciones staged inesperado:"; printf '%s\n' "$MIGS"; git reset >/dev/null; exit 1; }
echo "GATE 5 OK: staged diff = Advantage-only (sin customers-phone / swap / rental-agreements / locales / kiosk / FUSE)."

# ── GATE 6: IMPORT-RESOLVE sobre el ÁRBOL STAGED (el gate del boot) ──────────
# NO se asume la cadena: se materializa el índice ENTERO (= exactamente el árbol
# que tendrá el tag) y se camina cada import relativo, estático Y dinámico, desde
# main.js y worker.js. Un import top-level a un archivo que no entró al tag = el
# backend no bootea. Esto lo PRUEBA.
STAGED_TREE="$SCRATCH/staged-tree"; mkdir -p "$STAGED_TREE"
git checkout-index -a --prefix="$STAGED_TREE/"
cat > "$SCRATCH/resolve-chain.mjs" <<'RESOLVER_EOF'
import fs from 'node:fs';
import path from 'node:path';
const roots = process.argv.slice(2);
const seen = new Set(); const missing = []; let count = 0;
const RE = /(?:\bfrom\s*|\bimport\s*|\bexport\s+\*\s*from\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
// Los JSDoc de lib/queue/index.js y lib/storage/index.js traen EJEMPLOS DE USO
// (`* import { enqueueJob } from '../lib/queue/index.js';`) cuya ruta relativa está
// escrita desde el directorio del CALLER → matchearlos da falsos `lib/lib/...`.
// Se anclan imports REALES, no texto en comentarios.
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
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // bare → node_modules/builtin
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
# El árbol del tag debe traer los 5 módulos de advantage + las 6 piezas compartidas.
for m in constants service worker scheduler routes; do
  [ -f "$STAGED_TREE/backend/src/modules/integrations/advantage/advantage.$m.js" ] \
    || { echo "ABORT: advantage.$m.js no está en el árbol del tag." >&2; git reset >/dev/null; exit 1; }
done
echo "GATE 6 OK: cadena main.js → advantage/ → booking-source/ resuelve DESDE EL ÁRBOL STAGED."

# ── GATE 7: TESTS ────────────────────────────────────────────────────────────
# test:advantage (68) es DB-free by design. La capa compartida (promotion-matcher)
# la usan CUATRO fuentes vivas → se prueba la regresión de las tres restantes.
( cd backend && npm run test:advantage )      || { echo "ABORT: test:advantage falló" >&2; git reset >/dev/null; exit 1; }
( cd backend && npm run test:booking-source ) || { echo "ABORT: test:booking-source falló" >&2; git reset >/dev/null; exit 1; }
( cd backend && npm run test:nu )             || { echo "ABORT: test:nu falló" >&2; git reset >/dev/null; exit 1; }
( cd backend && npm run test:economy )        || { echo "ABORT: test:economy falló" >&2; git reset >/dev/null; exit 1; }
echo "GATE 7 OK: advantage 68 · booking-source 42 · nu 60 · economy 41."

# test:flexways es DB-BACKED (la 4ta consumidora de la capa compartida). GOTCHA:
# backend/.env apunta a localhost:5433 que está MUERTO; la DB de dev real es
# localhost:5432/fleet_management (5433 da 33/35, 5432 da 35/35). Se corre SOLO si
# hay un postgres escuchando en 5432, apuntado ahí explícitamente; si no, se SALTA
# con aviso — la capa compartida ya quedó cubierta por booking-source/nu/economy
# (DB-free) y flexways consume promotion-matcher por el mismo import.
if nc -z localhost 5432 >/dev/null 2>&1; then
  ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run test:flexways ) \
    || { echo "ABORT: test:flexways falló contra la DB de dev (5432)" >&2; git reset >/dev/null; exit 1; }
  echo "GATE 7b OK: test:flexways 35/35 contra localhost:5432."
else
  echo "GATE 7b SKIP: no hay postgres en localhost:5432 → test:flexways (DB-backed) no corre."
  echo "  Levanta la DB de dev y re-corre este script si quieres la prueba flexways completa."
fi

# ── GATE 8: BUILD DEL FRONTEND ───────────────────────────────────────────────
# Corre sobre el working tree (next necesita node_modules, que el árbol staged no
# tiene). Los archivos frontend del tag son ADITIVOS y el panel no usa i18n → el
# build del working tree es representativo. (Por eso en.json/es.json NO van en
# FILES[]: sus 134 líneas son de otro workstream, cero Advantage.)
( cd frontend && npx next build ) || { echo "ABORT: next build falló" >&2; git reset >/dev/null; exit 1; }
echo "GATE 8 OK: next build limpio."

# ── GATE 9: ENV PARITY (fail-closed, compara contra el DROPLET) ──────────────
# .env.example SÍ va en FILES[] → el working copy ES el del tag (verificado:
# additivo, 11 keys ADVANTAGE_*, cero keys de otro workstream). Así que se chequea
# tal cual. FALLARÁ hasta que las 11 keys estén en el .env del droplet. NO hay
# workaround: se ponen primero. `< /dev/null` porque el SSH de env-diff-check se
# COME el stdin (varios ship scripts se colgaron por esto).
if ! bash scripts/env-diff-check.sh < /dev/null; then
  echo
  echo "############################################################"
  echo "env-diff-check FALLÓ — faltan las keys ADVANTAGE_* en el droplet."
  echo "Esto NO se rodea. HECTOR las añade a mano a backend/.env del"
  echo "droplet (con backup .env.bak-$(date +%F)-advantage-keys) ANTES"
  echo "del deploy — el agente deployer rechaza autorización relayed."
  echo
  echo "Las 11 keys, con sus defaults (ship DARK — el flag va en false):"
  echo "------------------------------------------------------------"
  grep -E '^ADVANTAGE_' backend/.env.example
  echo "------------------------------------------------------------"
  echo "Luego re-corre este script."
  echo "############################################################"
  git reset >/dev/null; exit 1
fi
echo "GATE 9 OK: env parity contra el droplet."

# ── REVIEW ───────────────────────────────────────────────────────────────────
echo; git status --short -- "${FILES[@]}" backend/prisma/schema.prisma backend/package.json; echo
git diff --cached --stat; echo
echo "Revisa el re-corte de M1:  git diff --cached -- backend/prisma/schema.prisma"
echo "Revisa el re-corte de m1:  git diff --cached -- backend/package.json"
echo
# `read < /dev/tty`: NUNCA heredar el stdin (env-diff-check/ssh se lo come y el
# prompt se traga solo → varios scripts colgados hoy).
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Dejado staged (sin commitear). Para desestagear: git reset"; exit 0; }

git commit -m "feat(integrations): Advantage (TSD RezCentral) autonomous booking-source (dark)

Fifth autonomous booking-source (TL -> Economy -> NU -> Flexways ->
Advantage), mounted on the shared booking-source/ scaffolding (promote,
customer-autocreate, scheduler-factory, window, http-common,
promotion-matcher). Advantage lives inside TSD RezCentral, an ASP.NET
WebForms back-office: plain-HTTP login (no CAPTCHA), menu-postback
navigation so TSD's strict single-window session is never broken, and a
report-grid parser. Multi-config keyed by the (tsdNumber, branch) PAIR ->
AdvantageLocationConfig, because the grid echoes the pair back in one
cell (Loc = '61302.MCO'); no tenant/location is hardcoded, every mapping
is data.

Shared layer (used by four live sources): promotion-matcher gains
overrideCustomerId (a caller that just created the customer no longer
re-searches) and isPlaceholderPhone (all-zeros degenerate-phone guard --
~50% of Advantage rows carry no email, and without the guard a
placeholder phone matches the whole pool). Regression: nu 60 / economy 41
/ booking-source 42 green with their tests untouched.

Ships DARK: ADVANTAGE_INTEGRATION_ENABLED=false -> no advantage.sync
handler, no scheduler; routes mounted but inert. Additive + idempotent
AdvantageLocationConfig migration. test:advantage 68 (DB-free).

Packaging (QA FIX-FIRST): schema.prisma and package.json are re-cut to
Advantage-only -- the working tree carried Customer.phoneNormalized from
the untracked VozIA/customers-phone workstream, which would have been a
P2022 on every default-select Customer query in prod (cf. c97dbda, the
beta.315 hotfix for the same mistake)."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"

cat <<EOF

Pushed $TAG.

PRE-DEPLOY (HECTOR, a mano): las 11 keys ADVANTAGE_* en backend/.env del droplet
(flag en "false") + backup del .env. Sin eso env-diff-check falla y el deploy para.

DROPLET:
  git fetch --tags && git checkout $TAG
  docker compose -f docker-compose.prod.yml build backend worker frontend
  docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
  # migración additive por el puerto de SESIÓN 5432, NUNCA pgbouncer 6543:
  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo "\$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'

VERIFICACIÓN (un push verde NO es un deploy verde):
  [ ] 3 contenedores healthy (fleet-backend-prod, fleet-worker-prod, fleet-frontend-prod), 0 restarts
  [ ] boot LIMPIO: sin MODULE_NOT_FOUND ni TypeError (la cadena estática
      main.js -> advantage.routes -> service/worker/scheduler/constants -> booking-source/*
      tiene que resolver aunque el flag esté off)
  [ ] /health 200 (interno y público)
  [ ] migración aplicada por 5432: tabla "AdvantageLocationConfig" existe
  [ ] PRUEBA DE DARK MODE — en el log del worker:
        [advantage] integration disabled (ADVANTAGE_INTEGRATION_ENABLED != true) — scheduler not started
      y NINGÚN "registered handler: advantage.sync"
  [ ] Settings -> Integrations -> Advantage: el panel carga (configurable pero inerte)
  [ ] REGRESIÓN P2022 (lo que M1 previene): abrir /customers y una reserva con
      cliente — si el schema del tag hubiera traído phoneNormalized, CUALQUIER
      query de Customer daría P2022. Debe funcionar normal.
EOF
