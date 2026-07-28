#!/usr/bin/env bash
# ============================================================================
# SHIP: Incidents HUB. 2026-07-28. (Hector's ask: "a hub that tenants can see
# all the incident reports in one location with what reservation it belongs
# to, customer info, ability to print it or email it to somebody".)
#
# Backend (module: incident-report — no schema/env/deps changes):
# - GET /api/incident-reports — tenant-wide hub list joined with reservation +
#   customer + vehicle + pickup sede. Filters status/type/severity + free-text
#   q (report #, reservation #, customer name/email, plate), paginated.
#   Location-scoped users only see incidents whose reservation picked up at
#   one of their sedes (fail-closed via userAllowedLocationIds — same
#   convention as tolls/citations). Payload is light: NO evidence blobs.
# - POST /api/incident-reports/:id/email {to, note?} — renders the SAME print
#   HTML and emails it (inline + .html attachment) via lib/mailer. DRAFTs are
#   409 (not a final document); invalid recipient 400. Content never logged.
#
# Frontend:
# - New /incidents page: filters, chips (type+severity / status), reservation
#   link, customer info (name/email/phone), vehicle plate, sede; Print (same
#   fetch+window.open pattern the per-reservation panel uses) + Email dialog
#   (pre-filled with the customer's email, editable to anybody).
# - AppShell nav 'nav.incidents' gated with moduleKey 'reservations' (incident
#   reports are reservation documents; no new module key -> no drift).
# - en/es locale keys (nav.incidents + incidents.*).
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/incident-report/incident-report.service.js"
  "backend/src/modules/incident-report/incident-report.routes.js"
  "backend/src/modules/incident-report/incident-report.service.test.mjs"
  "frontend/src/app/incidents/page.js"
  "frontend/src/components/AppShell.jsx"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  "frontend/test/i18n.test.js"
  ".deploy-notes/2026-07-28-ship-incidents-hub.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/incident-report/incident-report.service.js
node --check backend/src/modules/incident-report/incident-report.routes.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )
( cd frontend && node -e "
const { transformSync } = require('next/dist/build/swc');
const fs = require('fs');
transformSync(fs.readFileSync('src/app/incidents/page.js','utf8'), { jsc: { parser: { syntax: 'ecmascript', jsx: true } } });
console.log('JSX PARSE OK');
" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "listForTenant" backend/src/modules/incident-report/incident-report.routes.js); echo "hub route wired (>=1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "userAllowedLocationIds" backend/src/modules/incident-report/incident-report.service.js); echo "location scoping (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "emailReport" backend/src/modules/incident-report/incident-report.routes.js); echo "email route wired (>=1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "cannot be emailed" backend/src/modules/incident-report/incident-report.service.js); echo "DRAFT email 409 guard (1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "nav.incidents" frontend/src/components/AppShell.jsx); echo "nav entry (1): $c5"; [ "$c5" -ge 1 ]
c6=$(node -e "const en=require('./frontend/src/locales/en.json'),es=require('./frontend/src/locales/es.json');process.exit(en.nav.incidents&&es.nav.incidents?0:1)" && echo 1 || echo 0); echo "locales have nav.incidents (1): $c6"; [ "$c6" -eq 1 ]

echo "== GATE 3: encoding =="
for f in incident-report.service.js incident-report.routes.js incident-report.service.test.mjs; do
  n=$(tr -dc '\r' < "backend/src/modules/incident-report/$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR in $f: $n"; exit 1; }
done
n=$(tr -dc '\r' < frontend/src/app/incidents/page.js | wc -c); [ "$n" -eq 0 ] || { echo "CR in page.js: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:incident )
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:module-defaults-drift )
( cd frontend && npm test )

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
