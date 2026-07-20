#!/usr/bin/env bash
# v0.9.0-beta.330 — Kiosk B3g: smart confirmation lookup (kiosk side). SHIP DARK en variantes.
#   bash .deploy-notes/2026-07-19-ship-kiosk-smart-lookup-beta330.sh
#
# BACKEND + FRONTEND, SIN migración. Pipeline: Innovation + Graphic Design + QA SHIP.
# test:kiosk 127/127 · frontend build limpio · import walk OK.
#
# ⚠️⚠️ PRECONDICIÓN DE STAGING (MAJOR del QA, lección incidente-315): el working tree
# tiene trabajo SIN COMMITEAR de OTRO workstream (S30/VozIA) entremezclado —
# `backend/src/modules/reservations/reservations.routes.js` (modificado, con IMPORT
# ESTÁTICO de `backend/src/lib/reservation-smart-match.js`) + `reservation-smart-match.js`
# + `service-account-allowlist.js`. Si esos viajan en ESTE tag SIN el lib, prod
# boot-crashea (MODULE_NOT_FOUND — causa #1). Por eso el FILES[] es EXPLÍCITO y SOLO-kiosk,
# y hay guards que ABORTAN si (a) se stagea un archivo de S30, o (b) algún archivo stageado
# importa estáticamente reservation-smart-match.js. El seam del kiosk (kiosk-smart-match.js)
# NO importa el lib — usa runtime injection, boot-safe (verificado).
#
# QUÉ: el `find_reservation` del kiosk deja de morir por exact-match. El guest teclea el
# código que le dio la OTA; si no es exact → (variante: DARK hasta el lib de S30) →
# fallback por apellido + FECHA DE PICKUP (date-first; el phone suele faltar). Varios
# candidatos → pide UN dato más (NEEDS_MORE_INFO, jamás una lista). Match no-exact = solo
# datos ENMASCARADOS pre-verify. Anti-enum: lockout per-device de B1 (5 misses). Telemetría
# matchType. Get Help cae al overlay de VozIA (B3f) si está configurado. El matcher lo
# entrega S30 (`reservation-smart-match.js`) — el kiosk NO forkea el normalizador; wire-in
# de un one-liner cuando el lib esté commiteado.
#
# LIVE-NOW: fallback apellido+fecha, desambiguación, masking, Get Help, tz-aware (compara
#   el día en la tz de la location, no UTC — fix del review).
# DARK hasta el lib de S30: el matching de variantes de código (ZE... vs TL-ZE...). Hoy un
#   guest con el código pelado de la OTA aún cae a 404 (esperado; se prende con el wire-in).
# Acks de Hector 2026-07-19: lookup por apellido+fecha (sin phone) APROBADO; el oráculo de
#   multiplicidad de apellido se queda v1.
#
# DEPLOY (BACKEND + FRONTEND, SIN migración):
#   git fetch --tags && git checkout v0.9.0-beta.330
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   # Post-deploy: 3 contenedores healthy + boot limpio (sin MODULE_NOT_FOUND) + /health 200.
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.330"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }

FILES=(
  backend/src/modules/kiosk/kiosk-session.service.js
  backend/src/modules/kiosk/kiosk-smart-match.js
  backend/src/modules/kiosk/kiosk.routes.js
  backend/src/modules/kiosk/kiosk.test.mjs
  frontend/src/app/kiosk/page.js
  frontend/src/locales/en.json
  frontend/src/locales/es.json
  doc/kiosk-e2e-spec-2026-07-04.md
  doc/kiosk-smart-match-contract-needs-2026-07-19.md
  .deploy-notes/2026-07-19-ship-kiosk-smart-lookup-beta330.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

# GUARD 1: NINGÚN archivo de S30 en el FILES[] (defensa por si alguien edita la lista).
for FORBIDDEN in \
  backend/src/modules/reservations/reservations.routes.js \
  backend/src/lib/reservation-smart-match.js \
  backend/src/lib/reservation-smart-match.test.mjs \
  backend/src/lib/service-account-allowlist.js ; do
  for f in "${FILES[@]}"; do
    [ "$f" = "$FORBIDDEN" ] && { echo "ABORT: $FORBIDDEN es de S30 — NO va en el tag del kiosk" >&2; exit 1; }
  done
done

git add -- "${FILES[@]}"

# GUARD 2 (boot-safety): ningún archivo STAGEADO puede tener un IMPORT ESTÁTICO real del
# lib de S30 (comentarios/TODO ok — el seam los tiene). Si alguno lo importa de verdad y
# el lib no viaja, prod muere en boot.
for f in "${FILES[@]}"; do
  case "$f" in *.js|*.mjs)
    if git show ":$f" | grep -qE '^[[:space:]]*import[[:space:]].*reservation-smart-match'; then
      echo "ABORT: $f importa estáticamente reservation-smart-match.js (lib de S30 no en el tag) → boot-crash" >&2
      git reset -q -- "${FILES[@]}"; exit 1
    fi ;;
  esac
done

# GUARD 3: locales stageados solo añaden keys lookup*/kiosk/pickup/ok (no hunks ajenos).
for LOC in frontend/src/locales/en.json frontend/src/locales/es.json; do
  FOREIGN="$(diff <(git show HEAD:"$LOC" | grep -oE '"[A-Za-z0-9_.]+":' | sort -u) <(git show ":$LOC" | grep -oE '"[A-Za-z0-9_.]+":' | sort -u) | grep '^>' | grep -viE '"(lookup[A-Za-z]*|kiosk[A-Za-z]*|pickup[A-Za-z]*|ok)":' || true)"
  [ -n "$FOREIGN" ] && { echo "ABORT: $LOC añade keys no-B3g:" >&2; echo "$FOREIGN" >&2; git reset -q; exit 1; }
done
echo "GUARDS OK (sin archivos S30, sin import estático del lib, locales limpios)"
echo "Shipping $TAG from $BRANCH"

git commit -m "feat(kiosk): B3g smart confirmation lookup — variant seam (dark) + name+date fallback + disambiguation

find_reservation no longer dead-ends on exact-match: the guest types the OTA
code; non-exact routes through a runtime-injected matcher seam (variant matching
DARK until S30's shared reservation-smart-match lib is committed — the kiosk does
NOT fork the normalizer) then a name + pickup-DATE fallback (phone often absent),
with calm one-more-datum disambiguation (never a list), masked-stub-only for
non-exact matches, the per-device lookup lockout, matchType telemetry, and
VozIA-aware Get Help. pickupDate compares in the location timezone, not UTC.
lastName+pickupDate lookup acked by Hector. Ships DARK on variant matching.

Pipeline: Innovation + Graphic Design + QA SHIP. Contract-needs for S30 freeze:
doc/kiosk-smart-match-contract-needs-2026-07-19.md.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG. Push with: git push origin $BRANCH --tags"
