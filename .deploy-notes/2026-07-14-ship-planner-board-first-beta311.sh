#!/usr/bin/env bash
# PLANNER REIMAGINADO — board-first (mockup aprobado por Hector 2026-07-14).
#   bash .deploy-notes/2026-07-14-ship-planner-board-first-beta311.sh
#
# QUÉ ES (plan doc/planner-reimagined-mockups-2026-07-14.html, 3 pantallas):
# el board ES la página. Header de 5 KPIs accionables (reemplaza ~20 tiles) +
# dock fijo de sin-asignar + timeline full-viewport con virtualización + dark
# mode + i18n en/es. Drag con preview de celdas legales (verde/rojo + porqué);
# el drop va por POST /api/planner/assign (transaccional, reusa las validaciones
# de apply-plan: OCCUPIED/LOCKED_STATUS/TYPE_MISMATCH/TURNAROUND/CROSS_LOCATION,
# force solo bypasea reglas de tipo/location, NUNCA ocupación) con optimistic
# update + Undo 10s + force-retry. Side-panel con sugerencias rankeadas del
# motor (POST /api/planner/suggest, score + porqués). El frontend consume
# tracks/counters del snapshot (se BORRÓ el doble cómputo cliente;
# usePlannerBoard.js eliminado). Rules/Copilot/Recommendations en slide-overs.
#
# PIPELINE: mockup aprobado por Hector · Innovation OK (2 must-change aplicados:
# shortageToday shape + CROSS_LOCATION server-side) · Graphic Design OK (1
# must-change aplicado: vars --pl-* a :root) · QA SHIP (2 majors resueltos:
# candidatos de bulk-clear espejan ASSIGNABLE_STATUSES + loop tolerante a 409;
# split quirúrgico del package.json — ver GATES). Tests: backend test:planner
# 13/13 · frontend planner 19/19 · next build OK · test:vehicles 31/31.
#
# ⚠ STAGING QUIRÚRGICO (QA MAJOR-2): el working tree tiene ADEMÁS el workstream
# de kiosk (schema.prisma, migración 20260705_kiosk_core, hunk test:kiosk en
# package.json, kiosk-*.js). NADA de eso va en este tag. backend/package.json
# se stagea SOLO con el hunk de test:planner (HEAD + esa línea).
#
# SIN migración. BACKEND + FRONTEND (worker NO — Flexways vivo no se toca).
# DEPLOY:
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend frontend
#   # hard refresh del browser tras el deploy.
#
# SMOKE (Hector): /planner carga en segundos (beta.310) con el board nuevo;
# KPIs correctos; drag de una card del dock a un carro legal (verde) asigna;
# drop en fila roja → toast con porqué (+ Forzar si es regla); Undo restaura;
# click en barra → panel con sugerencias y score; dark mode; ES.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.311}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  # backend planner
  "backend/src/modules/planner/planner.routes.js"
  "backend/src/modules/planner/planner.actions.service.js"
  "backend/src/modules/planner/planner.recommendation.service.js"
  "backend/src/modules/planner/planner.service.js"
  "backend/src/modules/planner/planner.assign.test.mjs"
  # frontend planner (board-first)
  "frontend/src/app/planner/page.js"
  "frontend/src/app/planner/PlannerHeader.jsx"
  "frontend/src/app/planner/PlannerDock.jsx"
  "frontend/src/app/planner/PlannerBoard.jsx"
  "frontend/src/app/planner/PlannerSuggestPanel.jsx"
  "frontend/src/app/planner/PlannerSlideOver.jsx"
  "frontend/src/app/planner/PlannerToolbar.jsx"
  "frontend/src/app/planner/usePlannerData.js"
  "frontend/src/app/planner/usePlannerActions.js"
  "frontend/src/app/planner/usePlannerBoard.js"
  "frontend/src/app/planner/planner-board-helpers.mjs"
  "frontend/src/app/planner/planner-action-helpers.mjs"
  "frontend/src/app/planner/planner-utils.mjs"
  "frontend/src/app/planner/planner-board.test.mjs"
  "frontend/src/app/planner/planner-actions.test.mjs"
  # theme + i18n + mockup + ship
  "frontend/src/app/globals.css"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  "doc/planner-reimagined-mockups-2026-07-14.html"
  ".deploy-notes/2026-07-14-ship-planner-board-first-beta311.sh"
)

# ── SANITY GATES (código) ──
grep -q "isPlannerAssignableReservation" frontend/src/app/planner/planner-utils.mjs || { echo "ABORT: falta isPlannerAssignableReservation" >&2; exit 1; }
grep -q "CROSS_LOCATION" backend/src/modules/planner/planner.actions.service.js || { echo "ABORT: falta CROSS_LOCATION en assignVehicle" >&2; exit 1; }
grep -q "clearedPartial" frontend/src/locales/es.json || { echo "ABORT: falta i18n clearedPartial" >&2; exit 1; }
node --check backend/src/modules/planner/planner.actions.service.js || exit 1
node --check backend/src/modules/planner/planner.service.js || exit 1
node --check backend/src/modules/planner/planner.routes.js || exit 1

# ── STAGE: empezar con el index limpio (re-runs idempotentes) ──
git reset >/dev/null

# ── STAGE: package.json QUIRÚRGICO (solo el hunk de test:planner) ──
SCRATCH="$(mktemp -d)"
cp backend/package.json "$SCRATCH/pkg-working.json"
git show HEAD:backend/package.json > "$SCRATCH/pkg-head.json"
PLANNER_LINE="$(grep '"test:planner"' "$SCRATCH/pkg-working.json")"
[ -n "$PLANNER_LINE" ] || { echo "ABORT: no encuentro la línea test:planner en el working package.json" >&2; exit 1; }
awk -v repl="$PLANNER_LINE" '{ if ($0 ~ /"test:planner"/) print repl; else print }' "$SCRATCH/pkg-head.json" > backend/package.json
git add backend/package.json
# restaurar el working tree (los hunks de kiosk quedan SIN stagear)
cp "$SCRATCH/pkg-working.json" backend/package.json

# -A maneja también la deleción de usePlannerBoard.js aunque ya no exista en disco.
git add -A -- "${FILES[@]}"

# ── GATES DE QA sobre el diff STAGED (condiciones duras del SHIP) ──
# 1) package.json staged = SOLO la línea test:planner.
EXTRA_PKG="$(git diff --cached backend/package.json | grep -E '^[+-][^+-]' | grep -v 'test:planner' || true)"
[ -z "$EXTRA_PKG" ] || { echo "ABORT (QA gate 1): package.json staged trae más que test:planner:"; echo "$EXTRA_PKG"; git reset >/dev/null; exit 1; }
# 2) nada del workstream de kiosk en el tag.
KIOSK_LEAK="$(git diff --cached --name-only | grep -E 'schema\.prisma|20260705_kiosk_core|kiosk' || true)"
[ -z "$KIOSK_LEAK" ] || { echo "ABORT (QA gate 2): archivos de kiosk staged:"; echo "$KIOSK_LEAK"; git reset >/dev/null; exit 1; }
echo "Guards OK (código + QA gates 1-2 sobre el staged diff)."

echo; git diff --cached --stat | tail -30; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git reset"; exit 0; }
git commit -m "feat(planner): board-first rebuild — the board IS the page

Hector-approved reimagining (mockups doc/planner-reimagined-mockups-2026-07-14
.html). 5 actionable KPI pills replace ~20 tiles; always-visible unassigned
dock; full-viewport virtualized timeline; dark mode; en/es. Drag shows legal
lanes (green ghost / red + why); drops go through the new transactional
POST /api/planner/assign (reuses apply-plan validation; OCCUPIED/LOCKED_STATUS/
TYPE_MISMATCH/TURNAROUND/CROSS_LOCATION; force bypasses rule conflicts only,
never occupancy) with optimistic update + 10s undo + force-retry. Side panel
shows ranked suggestions from POST /api/planner/suggest (score + reasons).
Frontend now consumes the authoritative snapshot tracks/counters — the
client-side recompute (usePlannerBoard.js and friends) is deleted. Rules/
Copilot/Recommendations become slide-overs. 5 new snapshot counters (legacy
preserved).

Pipeline: Innovation OK (shortageToday shape, CROSS_LOCATION server-side) ·
Graphic Design OK (--pl-* vars to :root) · QA SHIP (bulk-clear candidates
mirror ASSIGNABLE_STATUSES + 409-tolerant loop; kiosk workstream surgically
excluded from this tag). Tests: backend planner 13/13, frontend planner 19/19,
next build clean, vehicles 31/31. No migration.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"
echo "Pushed $TAG. Deploy: build + force-recreate backend frontend (NO worker, no migration)."
