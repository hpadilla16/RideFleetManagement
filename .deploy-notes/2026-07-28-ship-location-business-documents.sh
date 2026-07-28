#!/usr/bin/env bash
# ============================================================================
# SHIP: business documents per LOCATION. 2026-07-28.
# First change under the new SOP: own branch (feat/location-business-documents),
# merged to main.
#
# WHY (Hector): a branch must keep paperwork current to trade legally —
# operating permits, vehicle registrations, insurance certificates, licences.
# Today they live in someone's inbox and the first sign one lapsed is usually
# an inspector. Operators need them filed against the location, with the date
# each stops being valid, a warning 30 days ahead on the dashboard, and the
# ability to pull the file up whenever they need it.
#
# Design decisions worth keeping:
#  - Expiry is DERIVED from expiresAt on every read, never stored. A cached
#    "valid/expired" flag goes stale the moment a day passes without a sweep,
#    and a document that merely LOOKS valid is worse than no record at all.
#  - expiresAt NULL means perpetual (some registrations never expire) and such
#    a row is never chased. Guarded carefully: new Date(null) is the 1970 epoch,
#    so an unguarded parse reported "expired 20,000 days ago" — caught by a test
#    and fixed in startOfUtcDay.
#  - Date-only, UTC arithmetic: a permit is valid for the WHOLE of its final
#    day, so "expires today" is 0 days left, not a fraction that rounds to
#    expired.
#  - Archive, never hard-delete: an audit may still need to see what was on file
#    on a given date.
#  - Files live in a PRIVATE bucket; reads are 5-minute signed URLs, never
#    permanent links. A failed storage write records NOTHING, so there is never
#    a row pointing at a missing file.
#  - Location scoping is fail-CLOSED and answers 404 (not 403) for a branch
#    outside the caller's scope, so the API never confirms a branch they cannot
#    see exists.
#
# Routes live on /api/locations (already ADMIN/OPS + settings module).
# /documents/expiring is declared BEFORE /:id/documents so Express cannot match
# "documents" as a location id.
#
# No new env required (SUPABASE_STORAGE_LOCATION_DOCS_BUCKET and
# LOCATION_DOCS_WARN_DAYS are code-defaulted).
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260728_location_documents/migration.sql"
  "backend/src/modules/locations/location-documents.js"
  "backend/src/modules/locations/location-documents.service.js"
  "backend/src/modules/locations/location-documents.test.mjs"
  "backend/src/modules/locations/location-documents.service.test.mjs"
  "backend/src/modules/locations/locations.routes.js"
  "backend/package.json"
  "frontend/src/components/settings/LocationDocumentsPanel.jsx"
  "frontend/src/app/settings/page.js"
  "frontend/src/app/page.js"
  ".deploy-notes/2026-07-28-ship-location-business-documents.sh"
)

echo "== GATE 1: syntax + schema + boot + JSX =="
node --check backend/src/modules/locations/location-documents.js
node --check backend/src/modules/locations/location-documents.service.js
node --check backend/src/modules/locations/locations.routes.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npx prisma validate )
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )
( cd frontend && for f in src/components/settings/LocationDocumentsPanel.jsx src/app/settings/page.js src/app/page.js; do
  node -e "
const { transformSync } = require('next/dist/build/swc');
const fs = require('fs');
transformSync(fs.readFileSync('$f','utf8'), { jsc: { parser: { syntax: 'ecmascript', jsx: true } } });
console.log('JSX OK $f');
"
done )

echo "== GATE 2: structural greps =="
c1=$(grep -c "userAllowedLocationIds" backend/src/modules/locations/location-documents.service.js); echo "location scoping (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "throw err('Location not found', 404)" backend/src/modules/locations/location-documents.service.js); echo "404 not 403 — no existence oracle (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "status: 'ARCHIVED'" backend/src/modules/locations/location-documents.service.js); echo "archive not delete (1): $c3"; [ "$c3" -ge 1 ]
c4=$( (grep -c "locationDocument.delete" backend/src/modules/locations/location-documents.service.js || true) ); echo "NO hard delete (0): $c4"; [ "$c4" -eq 0 ]
c5=$(grep -c "expiresIn: 300" backend/src/modules/locations/location-documents.service.js); echo "short-lived signed url (1): $c5"; [ "$c5" -ge 1 ]
# /documents/expiring must precede /:id/documents or Express eats it as an id.
a=$(grep -n "'/documents/expiring'" backend/src/modules/locations/locations.routes.js | cut -d: -f1)
b=$(grep -n "'/:id/documents'" backend/src/modules/locations/locations.routes.js | head -1 | cut -d: -f1)
echo "route order expiring($a) before :id/documents($b)"; [ "$a" -lt "$b" ]
c6=$(grep -c "locations/documents/expiring" frontend/src/app/page.js); echo "dashboard reads the feed (1): $c6"; [ "$c6" -ge 1 ]

echo "== GATE 3: encoding =="
for f in location-documents.js location-documents.service.js location-documents.test.mjs location-documents.service.test.mjs; do
  n=$(tr -dc '\r' < "backend/src/modules/locations/$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR in $f: $n"; exit 1; }
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260728_location_documents/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "NON-ASCII in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:location-docs )
( cd frontend && npm test )
# NOT run here: test:locations-scope is DB-backed (needs a real Postgres, not
# the dummy URL these gates use) and already fails without one on a clean
# checkout — pre-existing, verified by stashing this change and re-running.
# The new document scoping is covered by location-documents.service.test.mjs,
# which stubs prisma and asserts the fail-closed 404 behaviour directly.

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
