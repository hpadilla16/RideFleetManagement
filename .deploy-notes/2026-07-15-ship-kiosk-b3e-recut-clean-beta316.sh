#!/usr/bin/env bash
# v0.9.0-beta.316 — RE-CORTE LIMPIO de B3e: quita la contaminación cruzada que tumbó prod.
#   bash .deploy-notes/2026-07-15-ship-kiosk-b3e-recut-clean-beta316.sh
#
# BACKEND schema-only (1 archivo). SIN migración nueva (las 3 columnas de B3e ya están en
# prod desde el deploy 315 revertido).
#
# INCIDENTE (2026-07-15): el commit de beta.315 (5c4a78e) metió en schema.prisma un campo
# de OTRO workstream sin commitear — `Customer.phoneNormalized` (VozIA gap #4) — cuya
# migración nunca corrió. El cliente Prisma del build lo pedía → TODA query de
# reservation/rentalAgreement/customer/inspection daba 500 ("column Customer.phoneNormalized
# does not exist"). Causa: `git add -- schema.prisma` stagea el ARCHIVO completo, no solo
# el hunk del kiosk — el FILES[] de los ship scripts protege QUÉ archivos, no QUÉ hunks
# dentro de un archivo compartido. beta.314 (rollback) restauró el servicio.
#
# ESTE SHIP: beta.316 = beta.315 con el hunk phoneNormalized REMOVIDO de schema.prisma.
# Neto vs beta.314 = SOLO las 3 columnas de KioskSession de B3e. Todo el código B3e
# (matcher L1, self-service L2, staff L3) ya estaba correcto en 315 — solo se limpia el
# schema. Las 3 columnas B3e YA existen en la DB de prod (se pegaron en el deploy 315),
# así que NO hay migración que correr.
#
# ── RE-TEST de Hector tras deploy (el mismo de B3e, ahora sin romper nada) ──
#   Verificar PRIMERO que print agreements / view inspections / start-rental sirven (las
#   que rompió 315). Luego el flujo kiosk: L1 (tu licencia pasa silenciosa), L2 (código),
#   L3 (staff PIN).
#
# DEPLOY (BACKEND + FRONTEND, SIN migración):
#   git fetch --tags && git checkout v0.9.0-beta.316
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   # SIN migración (las columnas B3e ya están). Verificar post-deploy: 0 errores de
#   # "phoneNormalized", 0 status:500 en reservation/agreement/inspection, /health 200.
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.316"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }

FILES=(
  backend/prisma/schema.prisma
  .deploy-notes/2026-07-15-ship-kiosk-b3e-recut-clean-beta316.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"

# GUARD NUEVO (la lección del incidente): el schema.prisma STAGEADO, comparado con el
# último tag bueno, NO puede añadir NADA fuera de las 3 columnas de B3e. Cualquier campo
# de otro workstream (phoneNormalized u otro) aborta el ship.
STAGED_SCHEMA_ADDS="$(git diff --cached v0.9.0-beta.314 -- backend/prisma/schema.prisma | grep -E '^\+' | grep -vE '^\+\+\+' | grep -viE 'nameMismatchAt|nameUpdateCodeHash|nameUpdateCodeExpiresAt|B3e|NAME_MISMATCH|possession code|single-use|10-min|hashed at rest|^\+$' || true)"
if [ -n "$STAGED_SCHEMA_ADDS" ]; then
  echo "ABORT: staged schema.prisma adds lines outside the B3e KioskSession columns:" >&2
  echo "$STAGED_SCHEMA_ADDS" >&2
  echo "→ another workstream's hunk contaminated schema.prisma. Isolate it before shipping." >&2
  git reset -q -- "${FILES[@]}"
  exit 1
fi
echo "GUARD OK: staged schema.prisma adds only the B3e KioskSession columns."
echo "Shipping $TAG from $BRANCH"

git commit -m "fix(kiosk): re-cut B3e schema without cross-workstream phoneNormalized (beta.315 hotfix)

beta.315 (5c4a78e) accidentally committed Customer.phoneNormalized from the
uncommitted customers-phone/VozIA workstream via git add of the whole
schema.prisma — the migration never ran, so the generated Prisma client
queried a non-existent column and every reservation/agreement/customer/
inspection query 500'd in prod. Rolled back to beta.314; this re-cut drops
the foreign field so schema == DB. Net vs beta.314 is only the 3 B3e
KioskSession columns (already applied to the prod DB in the 315 deploy) — no
migration. Adds a ship-script guard rejecting foreign schema.prisma hunks.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG. Push with: git push origin $BRANCH --tags"
