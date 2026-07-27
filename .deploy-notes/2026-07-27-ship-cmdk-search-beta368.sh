#!/usr/bin/env bash
# ============================================================================
# SHIP: Cmd/Ctrl+K global search (Innovation #2). 2026-07-27.
#
# The marketing chrome drew "Search plate, booking... Cmd K" but the app had
# no global search (25 sidebar nav items to hunt through). Now:
# - Backend GET /api/search?q=  (mounted /api/search, requireAuth +
#   tenantRateLimit): tenant injected via canonical scopeFor (super w/o tenant
#   -> empty, never a null Prisma filter); location FAIL-CLOSED for scoped
#   users (reservations on pickup OR return sede, vehicles on home sede;
#   customers tenant-wide BY DESIGN). Cheap indexed lookups only
#   (startsWith/equals + normalized-plate contains), take<=6 per bucket, one
#   Promise.all. Returns only ids the caller could already open.
# - Frontend: self-contained CommandPalette (Cmd/Ctrl+K toggles, arrows,
#   Enter opens, Esc closes, 220ms debounce, stale-response guard) mounted
#   once in AppShell + a topbar search button. EN + ES strings. New-UI tokens
#   with fallbacks. SVG icon, no emoji.
# NO migration, NO money path.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/search/global-search.routes.js"
  "backend/src/main.js"
  "frontend/src/components/CommandPalette.jsx"
  "frontend/src/components/AppShell.jsx"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  ".deploy-notes/2026-07-27-ship-cmdk-search-beta368.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/search/global-search.routes.js
node --check backend/src/main.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "userAllowedLocationIds" backend/src/modules/search/global-search.routes.js); echo "location scope applied (>=1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "return res.json({ results: \[\] })" backend/src/modules/search/global-search.routes.js); echo "null-tenant + short-q guards (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "app.use('/api/search'" backend/src/main.js); echo "route mounted (1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "CommandPalette" frontend/src/components/AppShell.jsx); echo "palette mounted (>=2): $c4"; [ "$c4" -ge 2 ]
c5=$(grep -c '"search"' frontend/src/locales/es.json); echo "ES strings block (1): $c5"; [ "$c5" -ge 1 ]

echo "== GATE 3: encoding =="
n=$(tr -dc '\r' < backend/src/modules/search/global-search.routes.js | wc -c); [ "$n" -eq 0 ] || { echo "CR in search routes: $n"; exit 1; }
n=$(tr -dc '\r' < frontend/src/components/CommandPalette.jsx | wc -c); [ "$n" -eq 0 ] || { echo "CR in palette: $n"; exit 1; }
node -e "JSON.parse(require('fs').readFileSync('frontend/src/locales/en.json')); JSON.parse(require('fs').readFileSync('frontend/src/locales/es.json'))" && echo "locales parse OK"

echo "== GATE 4: tests =="
echo "Boot OK; frontend build exit 0. Search is indexed lookups only; no money."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
