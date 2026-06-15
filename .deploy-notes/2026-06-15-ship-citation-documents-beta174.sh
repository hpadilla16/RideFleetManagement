#!/usr/bin/env bash
# v0.9.0-beta.174 — Citations OCR mail intake, Fase A (document plumbing)
#   bash .deploy-notes/2026-06-15-ship-citation-documents-beta174.sh
#
# BACKEND + MIGRACIÓN ADITIVA. NO money, NO matching nuevo, NO access control.
# Plan: doc/citations-ocr-mail-intake-plan-2026-06-15.md
#
# QUÉ ENTRA:
#   - enum CitationSource += MAIL_OCR (para distinguir las multas OCR'd del correo).
#   - modelo/tabla CitationDocument: un aviso escaneado/emailed ANTES de volverse
#     Citation (status PENDING→EXTRACTED→INGESTED/REVIEW/FAILED). Scalar-only en
#     Prisma; los FK viven en la migración.
#   - citations.service.js: saveDocument (sube data URL a Supabase + crea doc),
#     listDocuments, getDocumentSignedUrl. Reusa el bucket/flag de storage que ya
#     usan los registration docs (isStorageEnabled / inventory bucket) — SIN env nuevo.
#   - citations.routes.js: POST /api/citations/documents, GET /api/citations/documents,
#     GET /api/citations/documents/:id/download. Registradas ANTES de GET /:id para
#     que "/documents" no caiga como :id.
#   - frontend /citations: botón "Upload notice" (sube image/PDF como data URL al
#     endpoint nuevo → queda PENDING para el OCR de Fase B).
#   La Fase B (worker OCR que extrae campos y llama ingestBatch) es OTRO ship.
#
# IMPORTS nuevos en service: '../../lib/storage/index.js' y
#   '../rental-agreements/inspection-photos.js' — AMBOS ya existen y están deployados
#   (no hay archivo nuevo que trackear → sin riesgo de boot crash por MODULE_NOT_FOUND).
#
# MIGRACIÓN (additive, puerto 5432): aplica `20260615_citation_documents`.
#   Caveat enum: `ALTER TYPE ... ADD VALUE IF NOT EXISTS` corre OK en PG12+ (Supabase
#   es PG15) y no usamos el valor en la misma migración. Si `prisma migrate deploy`
#   se quejara del enum en transacción, correr el .sql por el SQL editor de Supabase
#   (autocommit). Comando estándar del repo:
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#
# Pre-req runtime: storage habilitado (INSPECTION_PHOTOS_STORAGE_ENABLED=true) — ya ON en prod.
# Deploy: build backend + worker + FRONTEND + force-recreate. Hard refresh del front.
#   Verificar 3 healthy + boot limpio + /health 200, y el botón "Upload notice" en /citations.
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260615_citation_documents/migration.sql
#   backend/src/modules/citations/citations.service.js
#   backend/src/modules/citations/citations.routes.js
#   .deploy-notes/2026-06-15-ship-citation-documents-beta174.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.174"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260615_citation_documents/migration.sql"
  "backend/src/modules/citations/citations.service.js"
  "backend/src/modules/citations/citations.routes.js"
  "frontend/src/app/citations/page.js"
  ".deploy-notes/2026-06-15-ship-citation-documents-beta174.sh"
)

# ── GATES
node --check backend/src/modules/citations/citations.service.js
node --check backend/src/modules/citations/citations.routes.js
( cd backend && npx prisma validate >/dev/null ) && echo "prisma schema valid"
grep -nq "MAIL_OCR" backend/prisma/schema.prisma || { echo "ABORT: MAIL_OCR no está en schema." >&2; exit 1; }
grep -nq "MAIL_OCR" backend/prisma/migrations/20260615_citation_documents/migration.sql || { echo "ABORT: MAIL_OCR no está en la migración." >&2; exit 1; }
grep -nq "async saveDocument" backend/src/modules/citations/citations.service.js || { echo "ABORT: saveDocument falta." >&2; exit 1; }
grep -nq "citationsRouter.post('/documents'" backend/src/modules/citations/citations.routes.js || { echo "ABORT: ruta /documents falta." >&2; exit 1; }
grep -nq "Upload notice" frontend/src/app/citations/page.js || { echo "ABORT: botón Upload notice falta en el front." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): OCR mail intake Fase A — CitationDocument plumbing

Adds MAIL_OCR source + CitationDocument table and the upload/list/download
endpoints so scanned/emailed citation notices can be stored (Supabase, reusing
the existing registration-doc storage pattern) ahead of the Fase B OCR worker.
Additive migration; no money, no matching changes, no new env.
Plan: doc/citations-ocr-mail-intake-plan-2026-06-15.md"
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Apply migration via 5432, build backend+worker, force-recreate, verify health."
