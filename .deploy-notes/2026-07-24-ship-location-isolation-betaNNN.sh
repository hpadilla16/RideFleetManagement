#!/usr/bin/env bash
# LOCATION ISOLATION — a user restricted to one branch was seeing the whole tenant.
#
# THE BUG. `User.locationIds` was honored by reservations/vehicles/planner/reports
# but ignored almost everywhere else, and `userAllowedLocationIds` additionally
# bypassed for ADMIN — so assigning locations to an admin looked applied in the UI
# and did nothing. Reported live: a Corpusa user scoped to LAX saw 4,148
# reservations, 87 citations (all Orlando's), 153 pickups / 48 returns.
#
# WHAT SHIPS. The scoping is now honored across citations (6 reads + the `review`
# mutation + the affidavit, which carries renter name/licence/address, + the
# CitationDocument side door that served the SAME Supabase object), tolls (list,
# dashboard, by-id, mutations), maintenance (`due`, `listSchedules`) and repair
# orders (list/get/vehicleHistory/mutations), plus the reservations dashboard
# `summary()` — the one reservation read path that had no location clause, and
# which also served from a WHOLE-TENANT rollup table. reports-v2 and the
# tenant-wide intake operations (citation import + document upload, toll
# provider/sync/import) fail closed with a 403 rather than serving partial data.
#
# ADMIN semantics (Hector's explicit request): SUPER_ADMIN is never
# location-scoped; ADMIN with NO locationIds stays tenant-wide; ADMIN WITH
# locationIds is a LOCATION admin and is restricted.
#
# MIGRATION: one additive, idempotent index (Vehicle tenantId+homeLocationId).
# No data change, no money code, no env keys, no new dependency.
#
# ORDER: run this BEFORE the market-airport-selector ship. Both workstreams edit
# backend/package.json; this one owns the bulk of it (7 new scope test scripts).
#
# ⚠ DEPLOY-TIME SIGN-OFF REQUIRED — see GATE 7. Three live ADMINs gain a
# restriction and lose whole feature sets. This is intended, not a side effect,
# but it must not be a surprise.
#
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-24-ship-location-isolation-betaNNN.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
[ -n "$BRANCH" ] || { echo "Detached HEAD" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"

SCOPE="backend/src/lib/tenant-scope.js"
MIGDIR="backend/prisma/migrations/20260724_vehicle_home_location_index"
SELF=".deploy-notes/2026-07-24-ship-location-isolation-betaNNN.sh"
SRC=(
  "$SCOPE"
  "backend/src/lib/tenant-scope.test.mjs"
  "backend/src/modules/citations/citations-affidavit.service.js"
  "backend/src/modules/citations/citations.routes.js"
  "backend/src/modules/citations/citations.service.js"
  "backend/src/modules/maintenance/maintenance.service.js"
  "backend/src/modules/maintenance/repair-orders.service.js"
  "backend/src/modules/planner/planner.service.js"
  "backend/src/modules/reports/reports-v2.routes.js"
  "backend/src/modules/reports/reports.service.js"
  "backend/src/modules/reservations/reservations.service.js"
  "backend/src/modules/tolls/tolls.routes.js"
  "backend/src/modules/tolls/tolls.service.js"
)
NEWTESTS=(
  "backend/src/modules/citations/citations-location-scope.test.mjs"
  "backend/src/modules/maintenance/maintenance-location-scope.test.mjs"
  "backend/src/modules/reports/reports-v2-scope-guard.test.mjs"
  "backend/src/modules/reservations/reservations-summary-location-scope.test.mjs"
  "backend/src/modules/tolls/tolls-location-scope.test.mjs"
  "backend/src/modules/tolls/tolls-scope-guard.test.mjs"
)
FILES=(
  "${SRC[@]}"
  "${NEWTESTS[@]}"
  "backend/prisma/schema.prisma"
  "$MIGDIR/migration.sql"
  "backend/package.json"
  "$SELF"
)

# ── GATE 1: syntax + boot. The backend does NOT boot if a module imported at the
# top level of main.js/worker.js is missing from FILES[] — catch it here, not on
# the droplet.
for F in "${SRC[@]}"; do ( cd backend && node --check "${F#backend/}" ); done
echo "GATE 1a OK: node --check limpio en los 13 archivos de src."
( cd backend && DATABASE_URL="postgresql://u:p@127.0.0.1:5432/x" \
  JWT_SECRET="ship-gate-smoke-secret-not-a-real-one-000" SKIP_LISTEN=1 \
  node -e "import('./src/main.js').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})" >/dev/null 2>&1 ) \
  || { echo "ABORT: main.js does not boot-import." >&2; exit 1; }
echo "GATE 1b OK: main.js boot-import limpio."

# ── GATE 2: the ADMIN semantics are THE point of this ship. If someone restores
# the ADMIN bypass, every test below still passes at the unit level but the whole
# fix is silently reverted for the only users it was built for.
# Scoped to the LOCATION function's own body: `userProgramScope` below it keeps
# the `|| role === 'ADMIN'` bypass legitimately, so a file-wide grep would be a
# permanent false positive.
LOCFN="$(sed -n '/^export function userAllowedLocationIds/,/^}/p' "$SCOPE")"
[ "$(printf '%s' "$LOCFN" | grep -c "SUPER_ADMIN")" -eq 1 ] \
  || { echo "ABORT: userAllowedLocationIds no longer has exactly one SUPER_ADMIN bypass." >&2; exit 1; }
[ "$(printf '%s' "$LOCFN" | grep -c "role === 'ADMIN'")" -eq 0 ] \
  || { echo "ABORT: userAllowedLocationIds bypasses for ADMIN again — that IS the bug this ship fixes." >&2; exit 1; }
[ "$(grep -c 'export function scopeAllowedLocationIds' "$SCOPE")" -eq 1 ] \
  || { echo "ABORT: scopeAllowedLocationIds is not exported exactly once." >&2; exit 1; }
[ "$(grep -c 'export function effectiveLocationIds' "$SCOPE")" -eq 1 ] \
  || { echo "ABORT: effectiveLocationIds is not exported exactly once." >&2; exit 1; }
echo "GATE 2 OK: ADMIN bypass gone, both scope helpers exported."

# ── GATE 2b: the fail-closed guards must stay applied. Each of these is a 403 on
# a tenant-wide operation a branch user must not run; dropping one re-opens a
# money path (citation/toll intake auto-posts charges tenant-wide).
[ "$(grep -c 'rejectLocationScopedUsers' backend/src/modules/citations/citations.routes.js)" -ge 3 ] \
  || { echo "ABORT: citations guard missing — expected the definition + BOTH intake doors (/manual-import and /documents)." >&2; exit 1; }
[ "$(grep -c "post('/documents', rejectLocationScopedUsers" backend/src/modules/citations/citations.routes.js)" -eq 1 ] \
  || { echo "ABORT: POST /citations/documents is ungated — the OCR worker feeds it to the same ingestBatch that posts money." >&2; exit 1; }
[ "$(grep -c 'rejectLocationScopedUsers' backend/src/modules/tolls/tolls.routes.js)" -ge 2 ] \
  || { echo "ABORT: tolls guard missing." >&2; exit 1; }
[ "$(grep -c 'userAllowedLocationIds' backend/src/modules/reports/reports-v2.routes.js)" -ge 1 ] \
  || { echo "ABORT: reports-v2 no longer fail-closes on the location axis." >&2; exit 1; }
echo "GATE 2b OK: fail-closed guards applied on citations (both doors), tolls, reports-v2."

# ── GATE 2c: ENCODING. A PowerShell round-trip once rewrote a shipped file as
# CP1252→UTF-8+BOM and corrupted every non-ASCII char. These files are dense with
# em dashes and ∩ in comments; migration.sql has → and — in SQL comments, which a
# non-UTF8 database would reject on EVERY boot (startup-migrate is fail-open and
# never records a failure, so it would retry forever).
for F in "${SRC[@]}" "${NEWTESTS[@]}" "$MIGDIR/migration.sql"; do
  if [ "$(head -c 3 "$F" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
    echo "ABORT: $F has a UTF-8 BOM — it must not." >&2; exit 1
  fi
  if [ "$(grep -c 'Â\|â€\|â†\|Ã—\|âœ' "$F" || true)" -ne 0 ]; then
    echo "ABORT: $F contains mojibake (double-encoded UTF-8)." >&2; exit 1
  fi
  # NOT `grep -c $'\r'`: in this Git Bash the $'\r' escape collapses to an EMPTY
  # pattern, so grep matches every line and the gate aborts on clean LF files.
  # `tr -dc` counts the actual CR bytes and was verified against a CRLF fixture.
  if [ "$(tr -dc '\r' < "$F" | wc -c)" -ne 0 ]; then
    echo "ABORT: $F has CR bytes — this clone is LF-pinned." >&2; exit 1
  fi
done
echo "GATE 2c OK: no BOM, no mojibake, no CRLF."

# ── GATE 3: the migration is additive + idempotent + drift-free.
[ -f "$MIGDIR/migration.sql" ] || { echo "ABORT: migration.sql missing." >&2; exit 1; }
[ "$(grep -c 'CREATE INDEX IF NOT EXISTS' "$MIGDIR/migration.sql")" -eq 1 ] \
  || { echo "ABORT: migration is not a single idempotent CREATE INDEX." >&2; exit 1; }
# CONCURRENTLY is a hard error inside a transaction, and `prisma migrate deploy`
# wraps every migration in one.
[ "$(grep -ci 'CONCURRENTLY' "$MIGDIR/migration.sql")" -eq 0 ] \
  || { echo "ABORT: CONCURRENTLY cannot run inside prisma migrate deploy's transaction." >&2; exit 1; }
# Nothing but the index — no ALTER/DROP/UPDATE/DELETE sneaking in.
if [ "$(grep -cEi '^[[:space:]]*(ALTER|DROP|UPDATE|DELETE|INSERT|TRUNCATE)' "$MIGDIR/migration.sql")" -ne 0 ]; then
  echo "ABORT: migration contains a non-additive statement." >&2; exit 1
fi
# schema.prisma must declare the SAME index or the next `prisma migrate dev`
# generates a spurious migration.
[ "$(grep -c '@@index(\[tenantId, homeLocationId\])' backend/prisma/schema.prisma)" -eq 1 ] \
  || { echo "ABORT: schema.prisma @@index does not match the migration (drift)." >&2; exit 1; }
# The only schema change allowed in this ship is that index.
SCHEMA_CHANGED="$(git diff HEAD -- backend/prisma/schema.prisma | grep -c '^[+-][^+-]' || true)"
[ "$SCHEMA_CHANGED" -le 12 ] \
  || { echo "ABORT: schema.prisma changed on $SCHEMA_CHANGED lines; expected only the index + its comment." >&2; exit 1; }
[ "$(git diff HEAD -- backend/prisma/schema.prisma | grep -cE '^[+-][^+-].*(model |String|Int|Boolean|DateTime|Decimal)')" -eq 0 ] \
  || { echo "ABORT: schema.prisma gained/lost a field or model — this ship is index-only." >&2; exit 1; }
echo "GATE 3 OK: migration additive, idempotent, transaction-safe, no drift."

# ── GATE 4: no lockfile / no dependency change. package.json MAY change, but only
# on test-script lines — and NOT with the market-airports lines, which belong to
# the sibling ship whose test file is not in this FILES[].
[ -z "$(git diff HEAD --name-only -- package-lock.json backend/package-lock.json frontend/package-lock.json 2>/dev/null)" ] \
  || { echo "ABORT: a lockfile changed — this ship adds no dependency." >&2; exit 1; }
[ "$(git diff HEAD -- backend/package.json | grep -c '^[+-].*"\(dependencies\|devDependencies\)"')" -eq 0 ] \
  || { echo "ABORT: backend/package.json dependency block changed." >&2; exit 1; }
[ "$(git diff HEAD -- backend/package.json | grep -c '^[+-][^+-].*market-airports')" -eq 0 ] \
  || { echo "ABORT: the market-airports test lines belong to the sibling ship; its test file is NOT in this FILES[] and npm test would die on ERR_MODULE_NOT_FOUND." >&2; exit 1; }
# Every scope test script this ship adds must point at a file that ships with it.
for T in "${NEWTESTS[@]}"; do
  [ -f "$T" ] || { echo "ABORT: $T is referenced by package.json but missing." >&2; exit 1; }
  [ "$(grep -c "${T#backend/}" backend/package.json)" -ge 1 ] \
    || { echo "ABORT: $T ships but is not wired into any npm script — it would never run." >&2; exit 1; }
done
[ "$(grep -c 'npm run test:tolls-scope' backend/package.json)" -ge 1 ] \
  || { echo "ABORT: the new scope suites are not in the npm test chain." >&2; exit 1; }
echo "GATE 4 OK: no lockfile/dep change; every new test wired; no sibling-ship contamination."

# ── GATE 5: tests.
# test:customers-scope is deliberately EXCLUDED: it carries 2 PRE-EXISTING
# failures caused by the throwaway Postgres initialising as WIN1252 while the
# test's $queryRaw contains a `→` ("character with byte sequence 0xe2 0x86 0x92
# ... has no equivalent in encoding WIN1252"). They fail on an untouched
# checkout. Including it would abort every ship attempt. Unrelated to scoping.
if command -v nc >/dev/null 2>&1 && nc -z localhost 5432 >/dev/null 2>&1; then
  for T in test:scope test:citations-scope test:tolls-scope test:tolls-scope-guard \
           test:maintenance-scope test:reports-scope-guard test:summary-scope \
           test:reservations test:planner test:vehicles test:maintenance test:tolls test:issues; do
    ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run "$T" ) \
      || { echo "ABORT: $T failed." >&2; exit 1; }
  done
  echo "GATE 5 OK: 7 scope suites + 6 regression suites green."
else
  echo "GATE 5 SKIP: no postgres on localhost:5432 — tests did NOT run."
fi

# ── GATE 6: env parity (no new keys).
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example 2>/dev/null || true
bash scripts/env-diff-check.sh < /dev/null || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example

# ── GATE 7: HUMAN SIGN-OFF. This ship REMOVES access from live named users. The
# census was run against prod on 2026-07-24; re-run it if this sits unshipped.
cat <<'SIGNOFF'

  ⚠  THIS SHIP RESTRICTS LIVE USERS — confirm before continuing.

  Becoming LOCATION admins (were tenant-wide):
    hpadilla@ridefleetmanager.com   Corpusa   → LAX only
    lrodriguez@vphmotors.com        VPH       → Ponce only
    snfigueroa@vphmotors.com        VPH       → Mayaguez only

  Those three ALSO lose, by design (fail-closed 403, not a filter):
    · every Reports v2 report + /snapshot
    · toll provider save / health-check / sync / manual-import / bulk-auto-match
    · citation manual-import AND citation document upload

  Location AGENTs (test@test.com, test123@123.com, alex2423245@gmail.com) lose
  Reports v2 the same way.

  The Reports page still LISTS all reports for these users and each click 403s —
  the nav is not yet filtered. Known, tracked, not in this ship.

  Sessions pick this up within 30s (SESSION_CACHE_TTL_MS) — no re-login needed.

SIGNOFF
read -r -p "Hector signed off on the access changes above? [y/N] " signoff < /dev/tty
[ "$signoff" = "y" ] || { echo "Stopped: sign-off required."; exit 0; }

# ── STAGE + guard
git reset >/dev/null
git add -- "${FILES[@]}"
EXPECTED="$(printf '%s\n' "${FILES[@]}" | sort)"
STAGED="$(git diff --cached --name-only | sort)"
[ "$EXPECTED" = "$STAGED" ] || {
  echo "ABORT: staged set does not match FILES[]." >&2
  echo "--- unexpected:"; comm -13 <(echo "$EXPECTED") <(echo "$STAGED") >&2
  echo "--- missing:";    comm -23 <(echo "$EXPECTED") <(echo "$STAGED") >&2
  git reset >/dev/null; exit 1
}
echo "GATE 8 OK: staged set = FILES[] exactly (${#FILES[@]} files)."

echo; git diff --cached --stat; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Left staged (not committed)."; exit 0; }
git commit -m "fix(scoping): honor User.locationIds across citations, tolls, maintenance and the dashboard

A user restricted to one branch was seeing the whole tenant. locationIds was
honored by reservations/vehicles/planner/reports and ignored nearly
everywhere else, and userAllowedLocationIds additionally bypassed for ADMIN
— so assigning locations to an admin looked applied in the UI and did
nothing. Reported live: a Corpusa user scoped to LAX saw 4,148 reservations,
87 citations (all Orlando's), 153 pickups / 48 returns.

ADMIN semantics (Hector's call): SUPER_ADMIN is never location-scoped; ADMIN
with no locationIds stays tenant-wide; ADMIN WITH locationIds is a LOCATION
admin and is restricted.

Scoped: citations (6 reads, the review mutation, the affidavit — which
carries renter name/licence/address — and the CitationDocument routes, which
served the SAME Supabase object the citation route protects); tolls (list,
dashboard, by-id, mutations); maintenance due/listSchedules and repair
orders; and reservations summary(), the one reservation read with no
location clause, which also served counts from a whole-tenant rollup table.
Citations have no Location FK, so they scope through
vehicle.homeLocationId; an unmatched citation is invisible to a branch user
(fail-closed) and stays with the tenant admin who triages it.

Fail-closed rather than filtered where the operation is inherently
tenant-wide: reports-v2 (its data paths receive only tenantId, and the
utilization report caches per query.locationId, not per caller), and the
citation/toll intake paths, which auto-post charges across the tenant.

Location fragments hoisted into lib/tenant-scope.js — effectiveLocationIds
(allowed ∩ requested; a locationId outside the caller's set never widens the
scope) and scopeAllowedLocationIds — replacing five inline copies that had
already begun to drift.

One additive, idempotent index (Vehicle tenantId+homeLocationId) for the
direct filters. It does NOT serve the relation-hop filters, which ride the
PK; recorded in the migration so nobody widens it expecting otherwise.

112 new scoping tests. No money code changed. QA SHIP.
Follow-ups: reservation-pricing.service.js gates by tenant only, so a
location admin can still void a charge on a reservation whose detail page
404s for them (pre-existing); the Reports nav is not filtered, so the 403s
are reachable from the UI; six inline location fragments remain in
reservations/vehicles.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo; echo "Pushed $TAG."
echo "Droplet: git fetch --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "MIGRATION: additive index. startup-migrate.js applies it on boot; it is IF NOT EXISTS so a second runner is a no-op."
echo "Verify: 3 containers healthy + clean boot + /api/health 200, then log in as a LOCATION admin and confirm"
echo "  the dashboard counts, citations, tolls and maintenance all show ONE branch — and Reports v2 returns 403."
