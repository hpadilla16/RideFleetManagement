#!/usr/bin/env bash
# v0.9.0-beta.344 — voidByRrn contrato + hueco de re-auth + fix de CI.
#   bash .deploy-notes/2026-07-25-ship-void-contract-reauth-gap-beta344.sh
#
# BACKEND-ONLY. SIN MIGRACIÓN. SIN cambios de schema. MONEY (staff-facing).
# Pipeline: QA SHIP ×2 (gate inicial + re-gate del delta). Diff revisado por Hector (gate #2).
#
# ⚠️ CERO CÓDIGO NUEVO DE GATEWAY. No se añade ninguna llamada al gateway: se
# CORRIGE el cuerpo de una que ya existe y que nunca funcionó. La Fase 2 de B5
# (HPP, poll/webhook, PreAuth, refund) sigue bloqueada esperando al rep:
# "¿Están habilitados Void y Refund a nivel de TPN para el 816026739983 en Transact?"
#
# ── QUÉ ──────────────────────────────────────────────────────────────────────
# 1. FIX DE CONTRATO en `voidByRrn` (MONEY, staff-facing). El cuerpo del request
#    violaba el contrato publicado de iPOS Transact en DOS puntos:
#      · la llave iba en MAYÚSCULA `RRN`; todos los samples y todos los strings de
#        validación usan `transactionRequest.rrn` en minúscula → el binding muy
#        probablemente la descartaba ("RRN cannot be empty");
#      · `amount: '0'` — el ÚNICO valor que los docs señalan explícitamente como
#        incorrecto ("Leave empty to void the original transaction amount. Do not
#        set to 0."). Ahora va `amount: ''`.
#    `transactionType: 2` se CONFIRMÓ correcto contra la tabla numérica completa
#    de la API (1=Sale, 2=Void, 3=Refund, 5=PreAuth, 9=Open Batch, 10=ACH,
#    12=Gift — el 11 NO EXISTE). Un resumen de búsqueda afirmaba "void=11", pero
#    en la misma frase afirmaba "sale=10", contradiciendo esa misma tabla → se
#    descartó como alucinación, no como doc. Fuente:
#    https://uatdocs.ipospays.tech/ipos-transact/apidocs
#    `applySteamSettingTipFeeTax:false` se CONSERVA: no está documentado para
#    void, pero `preAuthDeposit` lo manda idéntico y SÍ funciona en prod (383
#    holds emitidos por gateway) → menor varianza que quitarlo a ciegas.
#
#    ⚠️ ESTE PATH NUNCA SE HABÍA EJECUTADO CON ÉXITO. Verificado en prod
#    (read-only, 2026-07-25): CERO filas de auditoría de release y CERO de
#    re-auth, jamás — contra 588 agreements con `depositHoldId` (383 de gateway).
#    O sea: el botón "Release Deposit Hold" que el staff SÍ puede presionar nunca
#    ha liberado nada. No hay comportamiento bueno que romper; el peor caso es
#    que siga fallando igual que hoy. Es la forma exacta del bug de beta.155
#    (refund de Authorize.Net roto por orden de campos, invisible por años).
#    NO se puede probar de verdad: no hay sandbox. La PRIMERA ejecución real debe
#    tratarse como la prueba que es → vigilarla y reconciliarla contra el portal
#    de iPOSpays.
#
# 2. CIERRE DEL HUECO que el fix #1 destapa (QA MAJOR 1). `spinReauthDepositHold`
#    es: anular-el-hold-viejo → pre-autorizar-el-nuevo → persistir. Mientras el
#    void nunca funcionaba, una re-auth declinada era INOFENSIVA (el hold viejo
#    seguía vivo, el merchant cubierto). Con el void funcionando eso se INVIERTE:
#    void OK → re-auth declinada (evento rutinario de tarjeta) → el throw dispara
#    ANTES de persistir → el agreement queda apuntando a un hold que ya no existe
#    con `depositHoldVoidedAt` en null. La base Y el panel de staff
#    (`depositHoldActive = depositHoldId && !depositHoldVoidedAt`) dicen que hay
#    un hold vivo mientras la tarjeta no tiene nada. Merchant descubierto EN
#    SILENCIO.
#    Ahora, antes de que el error propague: se persiste la verdad del hold viejo
#    (`depositHoldVoidedAt` + `securityDepositReleasedAt` + `securityDepositCaptured:false`
#    — el MISMO triple que escribe `spinReleaseDepositHold` tras un void exitoso)
#    y se levanta un `PaymentOpsFlag` accionable. El `depositHoldId` se RETIENE
#    como rastro de auditoría. El error ORIGINAL se relanza intacto (el test
#    asserta identidad del objeto, no el mensaje) — el agente debe ver el fallo
#    real del gateway, nunca un fallo de contabilidad ocurrido al registrarlo.
#
#    `securityDepositCaptured:false` NO es opcional: hay TRES sitios que leen
#    `captured` sin guard de `releasedAt` — payments/page.js:644 y
#    reservations/[id]/page.js:3264 renderizan "Authorized", y payments/page.js:654
#    conmuta el BOTÓN de acción → sin ese flag el agente vería "Release Hold"
#    (que el gateway rechazaría) en vez de "Authorize Hold", que es exactamente
#    la recuperación que el texto del flag le indica.
#
#    Enum `ROLLBACK_FAILED` + status `GATEWAY_FAILED` a propósito, para que el
#    ship quede SIN MIGRACIÓN. `STRANDED_DEPOSIT_HOLD` es el problema OPUESTO
#    ("el hold sigue vivo en la tarjeta") y además COLISIONA en la llave de
#    dedupe de la cola `(tenantId, kind, gatewayRef)` con una fila levantada por
#    el sweep para el mismo RRN — la habría sobreescrito en sitio, perdiendo la
#    distinción. Verificado contra la implementación de `raise()`.
#
#    Doble guard contra el falso sello: `gatewayVoidedRef` se asigna SOLO dentro
#    de `if (voidNorm.approved)` (nunca en el atajo `MANUAL-`, nunca en el catch
#    que traga), y el helper hace `if (!voidedRef) return`. Marcar por suposición
#    es EXACTAMENTE el bug que beta.343 le quitó al sweep nocturno.
#
# 3. FIX DE CI (regresión introducida por beta.343). El step nuevo de money-path
#    fallaba: dos asserts de índices DB-backed construían `PrismaClient` con
#    `DATABASE_URL` undefined y eso tira EN LA CONSTRUCCIÓN, antes del try/catch
#    de connect. En la Mac no se veía porque `backend/.env` da una URL a un puerto
#    muerto → construye y falla al conectar (capturado → skip). Ahora se chequea
#    `process.env.DATABASE_URL` ANTES del import dinámico. Los DOS guards de
#    drift M2 (los que de verdad sostienen el piso de idempotencia) SÍ corren sin
#    DB; solo los dos asserts de existencia física del índice hacen skip, y lo
#    anuncian ruidosamente.
#
# ── LO QUE SE DIFIERE A PROPÓSITO (registrado contra la Fase 2 de B5) ─────────
# · `spinReleaseDepositHold` (~:4519) tiene una ventana espejo: void aprobado en
#   :4543, persistido en :4554. Si ese update falla, el void pasó y no quedó
#   registrado. NO se arregla aquí: esa ventana solo puede fallar si la BASE está
#   caída, y en ese estado el write compensatorio y el insert del flag fallan
#   también → un registro compensatorio es estructuralmente incapaz de cerrarla.
#   Además falla RUIDOSO (el call entero tira) y a favor del cliente (su dinero
#   sí se liberó). El cierre real cuando aterrice el brazo de gateway:
#   **tratar una respuesta "already voided" del gateway como ÉXITO y sellar** —
#   eso cierra la ventana sin necesitar write compensatorio.
# · Al hacer un void real, RESOLVER automáticamente cualquier
#   `STRANDED_DEPOSIT_HOLD` abierto para ese `gatewayRef` (hoy queda huérfano y
#   el staff descubre que anularlo es un no-op). No bloqueante.
#
# ── COORDINACIÓN — package.json (lección beta.315) ───────────────────────────
# El working tree trae `backend/package.json` con el trabajo NO COMMITEADO de la
# sesión task_b78075c0 (`--test-force-exit` en ~11 entradas: test:vehicles,
# test:fees, test:public-booking, test:terms, test:incident, test:issues,
# test:email, test:precheckin-invite, test:correct-readings, test:void-payment,
# test:post-payment-closed). NADA de eso es de este tag.
# → Este script NO stagea el archivo del working tree. Reconstruye el
#   package.json QUIRÚRGICAMENTE desde HEAD aplicando UNA sola edición (añadir
#   spin-reauth-deposit-hold.test.mjs a test:rental-agreements), lo mete al index
#   como blob SIN tocar el working tree, y un guard exige que el diff stageado
#   sea exactamente 1 línea. El working tree de la otra sesión queda intacto.
#
# ── SUITES (verificadas por QA y re-verificadas a mano 2026-07-25) ───────────
#   rental-agreements 43/43 (era 33, +10 nuevos) · payments 11/11 ·
#   stale-preauth 4/4 · kiosk 148/148 · ipos-transact-client 16/16 ·
#   payment-refs 6/6 con DB y 4 pass / 2 skip / exit 0 SIN DB ·
#   spin-reauth-deposit-hold 10/10 sin DB, 0 skips · node --check + import walk OK.
#
# ── DEPLOY (BACKEND ONLY; sin migración, sin frontend) ───────────────────────
#   bash scripts/env-diff-check.sh
#   git fetch --tags && git checkout v0.9.0-beta.344
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#   # NO hay migración que correr.
#   # Post-deploy: 3 contenedores healthy + boot limpio + /api/health 200.
#
# ── POST-DEPLOY (ops) ────────────────────────────────────────────────────────
# · La PRIMERA vez que alguien presione "Release Deposit Hold" es la prueba real
#   del contrato. Vigilarla y reconciliar contra el portal de iPOSpays.
# · Si en vez de aprobar da error, NO es una regresión: es el mismo fallo de
#   siempre, ahora con el cuerpo correcto → escalar al rep con la respuesta cruda.
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.344"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-list -n1 v0.9.0-beta.343)" ] || { echo "HEAD is not beta.343 — rebase/verify before shipping" >&2; exit 1; }

FILES=(
  backend/src/lib/payment-references.test.mjs
  backend/src/modules/payment-gateway/ipos-transact-client.js
  backend/src/modules/payment-gateway/ipos-transact-client.test.mjs
  backend/src/modules/rental-agreements/rental-agreements.service.js
  backend/src/modules/rental-agreements/spin-reauth-deposit-hold.test.mjs
  .deploy-notes/2026-07-25-ship-void-contract-reauth-gap-beta344.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"

# ── package.json QUIRÚRGICO (lección beta.315) ───────────────────────────────
# Reconstruido desde HEAD con UNA edición; el working tree NO se toca, así que
# el trabajo de task_b78075c0 sigue exactamente donde estaba.
PKG_BLOB="$(git show HEAD:backend/package.json | python3 -c '
import sys
s = sys.stdin.read()
old = "src/modules/rental-agreements/null-source-charge-dedup.test.mjs\","
new = "src/modules/rental-agreements/null-source-charge-dedup.test.mjs src/modules/rental-agreements/spin-reauth-deposit-hold.test.mjs\","
if s.count(old) != 1:
    sys.stderr.write("ABORT: expected exactly 1 anchor in package.json, found %d\n" % s.count(old))
    sys.exit(1)
sys.stdout.write(s.replace(old, new))
' | git hash-object -w --stdin)"
git update-index --cacheinfo 100644,"$PKG_BLOB",backend/package.json

# GUARD 1: el package.json stageado difiere de HEAD en EXACTAMENTE 1 línea
# (1 borrada + 1 añadida). Cualquier cosa más = se coló otro workstream.
PKG_LINES="$(git diff --cached HEAD -- backend/package.json | grep -cE '^[+-][^+-]' || true)"
if [ "$PKG_LINES" != "2" ]; then
  echo "ABORT: package.json stageado cambia $PKG_LINES líneas, se esperaban 2 (1 borrada + 1 añadida)" >&2
  git diff --cached HEAD -- backend/package.json >&2
  git reset -q; exit 1
fi
# GUARD 2: y esa línea DEBE ser la de spin-reauth.
if [ "$(git diff --cached HEAD -- backend/package.json | grep -cE '^\+.*spin-reauth-deposit-hold\.test\.mjs' || true)" != "1" ]; then
  echo "ABORT: la línea añadida al package.json no es la de spin-reauth" >&2; git reset -q; exit 1
fi

# GUARD 3 (lección beta.315): este tag NO lleva schema ni migración. Si algo de
# eso aparece stageado, es contaminación de otro workstream.
if [ -n "$(git diff --cached --name-only | grep -E 'prisma/(schema\.prisma|migrations/)' || true)" ]; then
  echo "ABORT: hay schema/migraciones stageadas — beta.344 es migration-free" >&2
  git diff --cached --name-only >&2; git reset -q; exit 1
fi

# GUARD 4: el fix de contrato debe estar realmente en lo stageado, con la forma
# correcta — llave `rrn` en minúscula y amount vacío, nunca '0'.
VOID_SRC="$(git show :backend/src/modules/payment-gateway/ipos-transact-client.js)"
[ "$(printf '%s' "$VOID_SRC" | grep -cE "^\s*rrn: String\(rrn\)," || true)" = "1" ] \
  || { echo "ABORT: falta la llave lowercase 'rrn' en voidByRrn" >&2; git reset -q; exit 1; }
[ "$(printf '%s' "$VOID_SRC" | grep -cE "amount: '0'" || true)" = "0" ] \
  || { echo "ABORT: voidByRrn todavía manda amount '0'" >&2; git reset -q; exit 1; }

# GUARD 5: nada de gateway nuevo. voidByRrn es la ÚNICA llamada tocada.
CHANGED_CALLS="$(git diff --cached HEAD -- backend/src/modules/payment-gateway/ipos-transact-client.js \
  | grep -E '^\+' | grep -cE 'transactRequest\(' || true)"
[ "$CHANGED_CALLS" -le 1 ] \
  || { echo "ABORT: se tocó más de una llamada de gateway ($CHANGED_CALLS)" >&2; git reset -q; exit 1; }

echo "GUARDS OK (package.json quirúrgico 1 línea, sin schema/migración, contrato de void pineado)"
echo "Shipping $TAG from $BRANCH"

git commit -m "fix(payments): correct the iPOS void contract + close the re-auth gap it exposes

MONEY (staff-facing). Reviewed line-by-line by Hector (gate #2). QA SHIP x2.

1) voidByRrn violated the published iPOS Transact contract in two places: the
   key was uppercase RRN (every doc sample and validation string uses lowercase
   transactionRequest.rrn) and amount was '0' — the one value the docs single
   out as wrong ('Leave empty to void the original transaction amount. Do not
   set to 0.'). transactionType 2 was confirmed correct against the full
   numeric table; there is no type 11.

   This path had NEVER succeeded against the gateway: prod shows zero release
   and zero re-auth audit rows, ever, against 588 agreements carrying a
   depositHoldId. The staff-facing 'Release Deposit Hold' button has therefore
   never released anything. No working behavior can regress — worst case it
   fails exactly as it does today. Same shape as beta.155.

2) Making the void work exposes a silent gap in spinReauthDepositHold: void the
   old hold -> pre-auth the new one -> persist. A declined re-auth used to be
   harmless because the void never landed. Now, void OK + decline throws before
   the persist step, leaving the agreement pointing at a hold that no longer
   exists with depositHoldVoidedAt null — DB and staff panel both claim a live
   hold while the card carries none. The merchant is silently unprotected.

   The truth about the old hold is now persisted (the same field triple
   spinReleaseDepositHold writes after a real void) and an actionable
   PaymentOpsFlag is raised, while the original gateway error propagates
   untouched. Stamping only ever happens on an APPROVED gateway void — never on
   the MANUAL- shortcut, never on a swallowed failure — pinned by five negative
   tests.

3) CI regression from beta.343: two DB-backed index assertions constructed
   PrismaClient with DATABASE_URL undefined, which throws at construction,
   before the connect-time guard. Now gated on the env var before the dynamic
   import. The load-bearing drift guards still run without a DB.

No migration, no schema change, no new gateway call. B5 Phase 2 stays blocked
on the rep confirming Void and Refund are enabled at the TPN level.

Deferred to the B5 gateway phase: treat an 'already voided' gateway response as
success and stamp it (closes the mirror window in spinReleaseDepositHold), and
auto-resolve stale STRANDED_DEPOSIT_HOLD rows on a successful void.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG. Push with: git push origin $BRANCH --tags"
