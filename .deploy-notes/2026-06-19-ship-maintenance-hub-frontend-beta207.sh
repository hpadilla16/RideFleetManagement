#!/usr/bin/env bash
# v0.9.0-beta.207 — Maintenance Module Fase 3 (frontend): Maintenance Hub + RO editor + Due.
#   bash .deploy-notes/2026-06-19-ship-maintenance-hub-frontend-beta207.sh
#
# Frontend-only, SIN migración. Consume la API de beta.206. ZERO charge logic.
#
# QUE ENTRA:
#   - Página /maintenance (Maintenance Hub): KPIs (Open ROs · Due/overdue · Vehicles down ·
#     Fleet down % · Cost MTD), selector de LOCATION, tabs "Repair orders" / "Maintenance due".
#   - Board de repair orders (RO# · vehículo · source · location · estado · costo · antigüedad) →
#     click abre el editor (modal): líneas multi-tipo con total corrido, daños vinculados,
#     add/eliminar línea, Complete (→ daños FIXED) / Cancel.
#   - "New repair order" (vehículo + source + vendor). "Maintenance due": intervalos overdue/soon
#     con el gap de odómetro en vivo + "Create RO".
#   - Nav link "Maintenance" (módulo vehicles) + labels en en/es.
#
# PENDIENTE Fase 3 (próximo push, menor): sección "Maintenance history" en el perfil del vehículo
# (GET /api/repair-orders/vehicle/:id) + botón "Roll into RO" desde el Damage History.
# Fase 4: Vehicle.status IN_MAINTENANCE al abrir RO + tile dashboard + migrar MaintenanceJob.
#
# Verificado: JSON de i18n válido; balance de llaves/parens del page OK; styled-jsx scopeado por
# clase (.maint-table) para no chocar con el scoping de children. El 'next build' del docker valida
# el JSX (no se puede correr next build en el sandbox).
#
# Deploy: build FRONTEND + force-recreate. SIN migración, SIN backend.
#
# FILES:
#   frontend/src/app/maintenance/page.js
#   frontend/src/components/AppShell.jsx
#   frontend/src/locales/en.json
#   frontend/src/locales/es.json
#   .deploy-notes/2026-06-19-ship-maintenance-hub-frontend-beta207.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.207"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/maintenance/page.js"
  "frontend/src/components/AppShell.jsx"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  ".deploy-notes/2026-06-19-ship-maintenance-hub-frontend-beta207.sh"
)

# ── SANITY GATES ──
[ -f frontend/src/app/maintenance/page.js ] || { echo "ABORT: falta el page de maintenance" >&2; exit 1; }
node -e "JSON.parse(require('fs').readFileSync('frontend/src/locales/en.json','utf8'))" || { echo "ABORT: en.json inválido" >&2; exit 1; }
node -e "JSON.parse(require('fs').readFileSync('frontend/src/locales/es.json','utf8'))" || { echo "ABORT: es.json inválido" >&2; exit 1; }
grep -q "href: '/maintenance'" frontend/src/components/AppShell.jsx || { echo "ABORT: nav sin el link de maintenance" >&2; exit 1; }
node -e "const s=require('fs').readFileSync('frontend/src/app/maintenance/page.js','utf8'); const b=(s.match(/{/g)||[]).length-(s.match(/}/g)||[]).length, p=(s.match(/\(/g)||[]).length-(s.match(/\)/g)||[]).length; if(b||p){console.error('unbalanced braces/parens',b,p);process.exit(1)}" || { echo "ABORT: page desbalanceado" >&2; exit 1; }
echo "Guards OK. (El 'next build' del docker valida el JSX completo.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(maintenance): Maintenance Hub frontend (Fase 3)

New /maintenance page: KPIs by location (open ROs, due/overdue, vehicles down, fleet
down %, cost MTD), location selector, Repair-orders board + RO editor modal (multi-type
lines with running total, linked damages, add/remove line, Complete→damages FIXED,
Cancel), New repair order, and a Maintenance-due tab (overdue/soon intervals with the
live odometer gap + Create RO). Nav link + en/es labels. Consumes the beta.206 API.
Vehicle-profile maintenance history + Damage→RO button are a small follow-on. No
migration; no charge logic."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build frontend → force-recreate. Sin migración."
