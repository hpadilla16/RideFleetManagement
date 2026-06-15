#!/usr/bin/env bash
# v0.9.0-beta.175 — Citations OCR mail intake, Fase B (vision-LLM worker) +
#   credenciales de AI POR-TENANT en Settings.
#   bash .deploy-notes/2026-06-15-ship-citation-ocr-worker-beta175.sh
#
# BACKEND + WORKER + FRONTEND, code-only (SIN migración — usa CitationDocument de beta.174).
# NO money, NO scraping. Plan: doc/citations-ocr-mail-intake-plan-2026-06-15.md
# REQUIERE beta.174 (CitationDocument + endpoint /documents + botón Upload) deployado.
#
# QUÉ ENTRA:
#   - citation-ocr.extract.js (NUEVO): extractor vision-LLM provider-agnostic
#     (default Anthropic/Claude, PDF nativo) → JSON de campos + confianza. La key/
#     provider/model llegan por parámetro (del tenant), con fallback a env.
#   - citation-ocr.scheduler.js (NUEVO): poll en el worker. Itera tenants con
#     citationsEnabled, resuelve la AI key de CADA tenant (Settings, fallback env
#     ANTHROPIC_API_KEY), procesa sus CitationDocument PENDING → ingestBatch
#     (source MAIL_OCR) → matching existente. Confianza baja → NEEDS_REVIEW.
#     Tenants sin key → se saltan (sus docs quedan PENDING). PII: no loguea OCR.
#   - citations.service.js: VALID_SOURCES += 'MAIL_OCR'.
#   - settings.service.js: getCitationOcrConfig (masked) / updateCitationOcrConfig
#     (key ENCRIPTADA con integration-crypto) / getCitationOcrResolved (interno, worker).
#   - settings.routes.js: GET /api/settings/citation-ocr · PUT (ADMIN).
#   - frontend settings: sección "Citations OCR (AI)" — provider, model, API key
#     (password, se guarda encriptada; "Remove key").
#   - worker.js: arranca/para el scheduler (dynamic import, no rompe boot).
#
# GATING: el scheduler corre si storage está ON. Por tenant procesa solo si:
#   (1) Tenant.citationsEnabled, (2) hay AI key resoluble: la del tenant en Settings
#   O env ANTHROPIC_API_KEY como fallback. Sin key → idle para ese tenant.
#   INTEGRATION_ENC_KEY (ya seteado para TL) es necesario para guardar la key.
#   ANTHROPIC_API_KEY en el .env es OPCIONAL (fallback). Recomendado: cada tenant
#   pone su propia key en Settings → Citations OCR (AI). NO bloquea deploy/env-diff.
#   Pre-req runtime: storage ON (INSPECTION_PHOTOS_STORAGE_ENABLED=true, ya ON).
#
# IMPORTS nuevos: worker.js usa DYNAMIC import del scheduler; el scheduler importa
#   settings.service.js + citation-ocr.extract.js (ambos en el FILES[] / ya trackeados)
#   → sin riesgo de MODULE_NOT_FOUND en boot.
#
# Deploy: build backend + worker + FRONTEND + force-recreate. Hard refresh del front.
#   Verificar 3 healthy + boot limpio + /health 200. Log del worker:
#   "[citation-ocr] started" (storage ON). Smoke: Settings → Citations OCR (AI) →
#   pegar API key → Save; subir un aviso en /citations → en <5min aparece como Citation.
#
# FILES:
#   backend/src/modules/citations/citation-ocr.extract.js
#   backend/src/modules/citations/citation-ocr.scheduler.js
#   backend/src/modules/citations/citations.service.js
#   backend/src/modules/settings/settings.service.js
#   backend/src/modules/settings/settings.routes.js
#   backend/src/worker.js
#   frontend/src/app/settings/page.js
#   .deploy-notes/2026-06-15-ship-citation-ocr-worker-beta175.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.175"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/citations/citation-ocr.extract.js"
  "backend/src/modules/citations/citation-ocr.scheduler.js"
  "backend/src/modules/citations/citations.service.js"
  "backend/src/modules/settings/settings.service.js"
  "backend/src/modules/settings/settings.routes.js"
  "backend/src/worker.js"
  "frontend/src/app/settings/page.js"
  ".deploy-notes/2026-06-15-ship-citation-ocr-worker-beta175.sh"
)

# ── GATES
node --check backend/src/modules/citations/citation-ocr.extract.js
node --check backend/src/modules/citations/citation-ocr.scheduler.js
node --check backend/src/modules/citations/citations.service.js
node --check backend/src/modules/settings/settings.service.js
node --check backend/src/modules/settings/settings.routes.js
node --check backend/src/worker.js
grep -nq "startCitationOcrScheduler" backend/src/worker.js || { echo "ABORT: worker no arranca el scheduler." >&2; exit 1; }
grep -nq "'MAIL_OCR'" backend/src/modules/citations/citations.service.js || { echo "ABORT: MAIL_OCR no está en VALID_SOURCES." >&2; exit 1; }
grep -nq "export async function extractCitationFields" backend/src/modules/citations/citation-ocr.extract.js || { echo "ABORT: extractor falta." >&2; exit 1; }
grep -nq "getCitationOcrResolved" backend/src/modules/settings/settings.service.js || { echo "ABORT: settings OCR resolver falta." >&2; exit 1; }
grep -nq "/citation-ocr" backend/src/modules/settings/settings.routes.js || { echo "ABORT: ruta settings citation-ocr falta." >&2; exit 1; }
grep -nq "Citations OCR (AI)" frontend/src/app/settings/page.js || { echo "ABORT: sección de Settings OCR falta en el front." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): OCR mail intake Fase B — vision-LLM worker + per-tenant AI key

Worker turns CitationDocument(PENDING) scans into Citations via vision-LLM (default
Anthropic/Claude) + the existing ingestBatch (source MAIL_OCR) + plate->vehicle->
reservation matching; low confidence forces NEEDS_REVIEW. Each tenant supplies its own
AI key in Settings (stored encrypted via integration-crypto); env ANTHROPIC_API_KEY is
an optional fallback. Code-only (uses beta.174's CitationDocument). No money.
Plan: doc/citations-ocr-mail-intake-plan-2026-06-15.md"
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh, verify health + worker log."
