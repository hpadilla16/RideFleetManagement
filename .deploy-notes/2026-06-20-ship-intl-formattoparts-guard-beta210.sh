#!/usr/bin/env bash
# v0.9.0-beta.210 — Blindar Intl.formatToParts contra navegadores/extensiones que lo rompen.
#   bash .deploy-notes/2026-06-20-ship-intl-formattoparts-guard-beta210.sh
#
# Frontend-only, SIN migración. ZERO charge logic.
#
# BUG (Sentry JAVASCRIPT-NEXTJSFRONTEND-T): "Intl.DateTimeFormat.prototype.formatToParts called on
# incompatible receiver" — un tercero (extensión/polyfill) monkeypatchea Intl y rompe formatToParts.
# wallClockDate() del dashboard corre en useState/useMemo (durante el RENDER), así que la excepción
# no atrapada CRASHEABA el dashboard (pantalla blanca al entrar). El mismo patrón sin try/catch estaba
# repetido en 4 reportes más.
#
# FIX:
#   - Nuevo helper compartido tenant-time.js `tenantDayKey(value, tz)` → "YYYY-MM-DD" en la TZ del
#     tenant, RESILIENTE: try/catch + fallback a la fecha UTC (no Intl) para que un Intl roto no
#     tumbe la página. Devuelve null para valor inválido/vacío (mismo contrato que wallClockDate).
#   - Reemplazadas las 4 copias inline idénticas (dashboard wallClockDate, reports-v2 reservations-by-day
#     / payments-by-day / availability-forecast) por tenantDayKey.
#   - pre-paid-reservations (formato datetime distinto): wrap local en try/catch (return '-').
#   - store-board ya tenía try/catch — sin cambios.
#
# Verificado: node --check tenant-time.js; smoke del helper (conversión AST correcta + null/bad → null
# + Intl roto monkeypatcheado → fallback UTC SIN crash); balance de llaves/parens de los 5 archivos OK;
# 0 formatToParts inline sin protección en los day-key. El 'next build' del docker valida el JSX.
#
# Deploy: build FRONTEND + force-recreate. SIN migración, SIN backend.
#
# FILES:
#   frontend/src/lib/tenant-time.js
#   frontend/src/app/page.js
#   frontend/src/app/reports-v2/reservations-by-day/page.js
#   frontend/src/app/reports-v2/payments-by-day/page.js
#   frontend/src/app/reports-v2/availability-forecast/page.js
#   frontend/src/app/reports-v2/pre-paid-reservations/page.js
#   .deploy-notes/2026-06-20-ship-intl-formattoparts-guard-beta210.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.210"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/lib/tenant-time.js"
  "frontend/src/app/page.js"
  "frontend/src/app/reports-v2/reservations-by-day/page.js"
  "frontend/src/app/reports-v2/payments-by-day/page.js"
  "frontend/src/app/reports-v2/availability-forecast/page.js"
  "frontend/src/app/reports-v2/pre-paid-reservations/page.js"
  ".deploy-notes/2026-06-20-ship-intl-formattoparts-guard-beta210.sh"
)

# ── SANITY GATES ──
node --check frontend/src/lib/tenant-time.js || { echo "ABORT: node --check tenant-time" >&2; exit 1; }
grep -q "export function tenantDayKey" frontend/src/lib/tenant-time.js || { echo "ABORT: falta tenantDayKey." >&2; exit 1; }
for f in \
  frontend/src/app/page.js \
  frontend/src/app/reports-v2/reservations-by-day/page.js \
  frontend/src/app/reports-v2/payments-by-day/page.js \
  frontend/src/app/reports-v2/availability-forecast/page.js; do
  grep -q "tenantDayKey" "$f" || { echo "ABORT: $f no usa tenantDayKey." >&2; exit 1; }
  node -e "const s=require('fs').readFileSync('$f','utf8'); const b=(s.match(/{/g)||[]).length-(s.match(/}/g)||[]).length,p=(s.match(/\(/g)||[]).length-(s.match(/\)/g)||[]).length; if(b||p){console.error('unbalanced',b,p);process.exit(1)}" || { echo "ABORT: $f desbalanceado." >&2; exit 1; }
done
node -e "const s=require('fs').readFileSync('frontend/src/app/reports-v2/pre-paid-reservations/page.js','utf8'); const b=(s.match(/{/g)||[]).length-(s.match(/}/g)||[]).length; if(b){console.error('unbalanced',b);process.exit(1)}" || { echo "ABORT: pre-paid desbalanceado." >&2; exit 1; }
echo "Guards OK. (El 'next build' del docker valida el JSX.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(frontend): guard Intl.formatToParts so a broken Intl can't crash the dashboard

Some browsers/extensions monkeypatch Intl.DateTimeFormat and break formatToParts
('called on incompatible receiver', Sentry NEXTJSFRONTEND-T). wallClockDate() runs in
the dashboard's useState/useMemo (during render), so the uncaught TypeError crashed the
whole page. New shared tenantDayKey(value, tz) in tenant-time.js does the tenant-TZ
YYYY-MM-DD with a try/catch + non-Intl UTC fallback; the 4 identical inline copies
(dashboard + reservations-by-day / payments-by-day / availability-forecast) now delegate
to it, and pre-paid-reservations gets a local try/catch (store-board was already safe).
Frontend-only; no migration; no charge logic."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build frontend → force-recreate. Sin migración."
