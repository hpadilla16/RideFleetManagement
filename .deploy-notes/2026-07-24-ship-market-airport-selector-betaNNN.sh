#!/usr/bin/env bash
# Market Intelligence: make the airport picker real.
#
# THE BUG. Every airport picker in the MI UI was built from the tenant's
# `Location` rows, but every /api/market/* endpoint keys on
# `MarketScrapeProfile.locationCode` — which is ALSO the code the scraper puts in
# the Kayak URL, so it has to be a real IATA code. A tenant's `Location.code` is a
# free-form label and frequently isn't one: Corpusa's LAX branch is coded
# `LAXA01` (a Rightcars station code). The dashboard card therefore asked for
# `?airport=LAXA01`, matched no profile, and rendered empty — while 1,249 rows of
# LAX market data sat in RateOffer. It only ever worked for International Rental
# Corp because they happened to name their location `SJU`.
#
# On top of that the /market page hardcoded `useState('SJU')` behind a <select>
# whose onChange was a literal no-op ("V1: only SJU is active"), and
# /market/[sipp] hardcoded `const airport = 'SJU'` — so opening any class from a
# non-SJU dashboard showed San Juan's numbers under it.
#
# THE FIX. New GET /api/market/airports lists the tenant's ACTIVE scrape profiles,
# so the picker is fed by what actually has data and the LAXA01/LAX mismatch
# cannot occur. All three surfaces read it. Selection persists per tenant under
# the key the dashboard card already used, so card and page stay in sync.
#
# Deliberately NOT renaming Corpusa's Location.code LAXA01 → LAX: sourcing the
# picker from profiles makes the rename unnecessary, and renaming would only have
# papered over the same class of bug for the next tenant.
#
# FRONTEND + BACKEND. Both containers rebuild. NO migration, NO schema change,
# NO env keys, NO money/charge code. Read-only endpoint.
#
# ORDER: run this AFTER the location-scoping ship. Both workstreams edit
# backend/package.json; that one owns the bulk of it, this one appends a single
# test script line. GATE 3 below enforces that this ship's package.json diff
# touches ONLY its own line — it will abort if run first.
#
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-24-ship-market-airport-selector-betaNNN.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
[ -n "$BRANCH" ] || { echo "Detached HEAD" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"

SVC="backend/src/modules/market-observations/market-observations.service.js"
ROUTES="backend/src/modules/market-observations/market-observations.routes.js"
NEWTEST="backend/src/modules/market-observations/market-airports.test.mjs"
PAGE="frontend/src/app/market/page.js"
DETAIL="frontend/src/app/market/[sipp]/page.js"
CARD="frontend/src/components/MarketIntelligenceCard.jsx"
SELF=".deploy-notes/2026-07-24-ship-market-airport-selector-betaNNN.sh"
FILES=(
  "$SVC"
  "$ROUTES"
  "$NEWTEST"
  "$PAGE"
  "$DETAIL"
  "$CARD"
  "backend/package.json"
  "$SELF"
)

# ── GATE 1: syntax. Backend only — the frontend files are JSX, which node cannot
# parse; `next build` in GATE 4 is their syntax gate.
( cd backend && node --check "${SVC#backend/}" && node --check "${ROUTES#backend/}" )
echo "GATE 1 OK: node --check limpio (backend)."

# ── GATE 2: the endpoint exists and is wired.
[ "$(grep -c 'export async function listMarketAirports' "$SVC")" -eq 1 ] \
  || { echo "ABORT: listMarketAirports is not exported exactly once." >&2; exit 1; }
[ "$(grep -c 'listMarketAirports,' "$SVC")" -ge 1 ] \
  || { echo "ABORT: listMarketAirports is not on the marketObservationsService object." >&2; exit 1; }
[ "$(grep -c "get('/airports'" "$ROUTES")" -eq 1 ] \
  || { echo "ABORT: GET /airports is not registered on the router." >&2; exit 1; }
# The endpoint MUST read profiles, not Location — that IS the fix.
[ "$(grep -c 'marketScrapeProfile.findMany' "$SVC")" -ge 1 ] \
  || { echo "ABORT: listMarketAirports no longer sources airports from scrape profiles." >&2; exit 1; }
echo "GATE 2 OK: /api/market/airports registered and profile-sourced."

# ── GATE 2b: THE REGRESSION GUARD. Re-introducing a hardcoded 'SJU' in any of the
# three surfaces silently restores the original bug for every non-SJU tenant, and
# nothing else here would catch it: the tests pass, the build passes, and the page
# renders perfectly — just against the wrong airport. Comments mentioning SJU are
# fine; a string literal assigned to airport state is not.
if [ "$(grep -cE "useState\('SJU'\)|airport = 'SJU'|value=\"SJU\"" "$PAGE" "$DETAIL" "$CARD" | grep -v ':0$' | wc -l)" -ne 0 ]; then
  echo "ABORT: a hardcoded 'SJU' airport is back in the MI frontend — that is the whole bug." >&2
  grep -nE "useState\('SJU'\)|airport = 'SJU'|value=\"SJU\"" "$PAGE" "$DETAIL" "$CARD" >&2 || true
  exit 1
fi
# The card must not go back to /api/locations (the LAXA01 source of the bug).
[ "$(grep -c "api('/api/locations'" "$CARD")" -eq 0 ] \
  || { echo "ABORT: the MI card is reading /api/locations again — Location.code is not the airport code." >&2; exit 1; }
[ "$(grep -c "api('/api/market/airports'" "$CARD")" -eq 1 ] \
  || { echo "ABORT: the MI card is not reading /api/market/airports." >&2; exit 1; }
[ "$(grep -c "api('/api/market/airports'" "$PAGE")" -eq 1 ] \
  || { echo "ABORT: the /market page is not reading /api/market/airports." >&2; exit 1; }
# The detail page must take the airport from the URL, not a literal.
[ "$(grep -c "searchParams?.get('airport')" "$DETAIL")" -eq 1 ] \
  || { echo "ABORT: /market/[sipp] no longer reads ?airport= from the URL." >&2; exit 1; }
# ...and the dashboard must actually pass it.
[ "$(grep -c 'airport=\${encodeURIComponent(airport)}' "$PAGE")" -ge 1 ] \
  || { echo "ABORT: the dashboard cards no longer pass ?airport= to the detail page." >&2; exit 1; }
echo "GATE 2b OK: no hardcoded SJU, all three surfaces on the new endpoint."

# ── GATE 2c: ENCODING. A PowerShell round-trip once rewrote a shipped file as
# CP1252→UTF-8+BOM and corrupted every non-ASCII char. These files carry em
# dashes and · separators in user-visible strings. Cheap permanent guard.
for F in "$SVC" "$ROUTES" "$NEWTEST" "$PAGE" "$DETAIL" "$CARD"; do
  if [ "$(head -c 3 "$F" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
    echo "ABORT: $F has a UTF-8 BOM — it must not." >&2; exit 1
  fi
  if [ "$(grep -c 'Â\|â€\|â†\|Ã—\|âœ' "$F" || true)" -ne 0 ]; then
    echo "ABORT: $F contains mojibake (double-encoded UTF-8)." >&2; exit 1
  fi
done
echo "GATE 2c OK: no BOM, no mojibake."

# ── GATE 3: no schema / no migration / no lockfile. package.json MAY change, but
# ONLY on lines mentioning market-airports — the location-scoping ship owns the
# rest of that file and its test files are NOT in this FILES[]. Shipping its
# script lines without its test files makes `npm test` die on ERR_MODULE_NOT_FOUND.
[ -z "$(git diff HEAD --name-only -- backend/prisma/schema.prisma backend/prisma/migrations 2>/dev/null)" ] \
  || { echo "ABORT: unexpected schema/migration change in a no-migration ship." >&2; exit 1; }
[ -z "$(git diff HEAD --name-only -- package-lock.json backend/package-lock.json frontend/package-lock.json 2>/dev/null)" ] \
  || { echo "ABORT: a lockfile changed — this ship adds no dependency." >&2; exit 1; }
# The wiring must actually be present. Without this, a package.json with ZERO
# market-airports lines makes the equality below 0 == 0 and the gate waves the
# ship through with the test file present but never run by `npm test`. The
# location-scoping ship deliberately strips these two lines, so re-adding them
# here is a real step someone can forget.
[ "$(grep -c '"test:market-airports"' backend/package.json)" -eq 1 ] \
  || { echo "ABORT: backend/package.json is missing the test:market-airports script." >&2; exit 1; }
[ "$(grep -c 'npm run test:market-airports' backend/package.json)" -eq 1 ] \
  || { echo "ABORT: test:market-airports is not wired into the npm test chain." >&2; exit 1; }
# Compare the SCRIPT KEY SET between HEAD and the working tree. A raw line count
# does not work: editing the `test` chain produces a removed line that does NOT
# mention market-airports (it is the old chain) alongside the added one that
# does. The key-set delta is the invariant we actually care about — this ship may
# add exactly one script and remove none.
KEYDIFF="$(
  { git show HEAD:backend/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>Object.keys(JSON.parse(s).scripts).forEach(k=>console.log("OLD "+k)))'
    node -e 'const s=require("./backend/package.json");Object.keys(s.scripts).forEach(k=>console.log("NEW "+k))'
  } | sort -k2 | uniq -f1 -u
)"
[ "$KEYDIFF" = "NEW test:market-airports" ] || {
  echo "ABORT: backend/package.json script keys differ from HEAD by more than this ship's one addition." >&2
  echo "       Run the location-scoping ship FIRST — it owns the other scripts and their test files." >&2
  printf '%s\n' "$KEYDIFF" >&2
  exit 1
}
# And the chain edit must be the only other change (1 removed + 1 added chain line
# + 1 added script line = 3).
PKG_TOTAL="$(git diff HEAD -- backend/package.json | grep -c '^[+-][^+-]' || true)"
[ "$PKG_TOTAL" -eq 3 ] || {
  echo "ABORT: backend/package.json changed on $PKG_TOTAL lines; expected exactly 3." >&2
  git diff HEAD -- backend/package.json | grep '^[+-][^+-]' >&2 || true
  exit 1
}
[ "$(git diff HEAD -- backend/package.json | grep -c '^[+-].*"\(dependencies\|devDependencies\)"')" -eq 0 ] \
  || { echo "ABORT: backend/package.json dependency block changed." >&2; exit 1; }
[ -f "$NEWTEST" ] || { echo "ABORT: $NEWTEST is missing but package.json references it." >&2; exit 1; }
echo "GATE 3 OK: no schema/migration/lockfile; package.json limited to this ship's line."

# ── GATE 4: tests. The frontend build doubles as the JSX syntax gate.
if command -v nc >/dev/null 2>&1 && nc -z localhost 5432 >/dev/null 2>&1; then
  for T in test:market-airports test:market-scraper; do
    ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run "$T" ) \
      || { echo "ABORT: $T failed." >&2; exit 1; }
  done
  echo "GATE 4a OK: market-airports + market-scraper green."
else
  echo "GATE 4a SKIP: no postgres on localhost:5432 — backend tests did NOT run."
fi
( cd frontend && npx next build >/dev/null ) || { echo "ABORT: next build failed." >&2; exit 1; }
echo "GATE 4b OK: next build clean (this is the JSX syntax gate)."
# frontend `npm test` is deliberately NOT run here: test/i18n.test.js asserts
# "EN nav has 17 items" while the committed en.json has 27. It fails on a clean
# checkout of any recent tag — a stale test, unrelated to this change. Including
# it would abort every ship. Fix separately.

# ── GATE 5: env parity (no new keys).
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example 2>/dev/null || true
bash scripts/env-diff-check.sh < /dev/null || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example

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
echo "GATE 6 OK: staged set = FILES[] exactly."

echo; git diff --cached --stat; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Left staged (not committed)."; exit 0; }
git commit -m "feat(market-intelligence): real airport selector, sourced from scrape profiles

Every airport picker in Market Intelligence was built from the tenant's
Location rows, while every /api/market/* endpoint keys on
MarketScrapeProfile.locationCode — which is also what the scraper puts in
the Kayak URL, so it must be a real IATA code. Location.code is a free-form
label and often isn't one: Corpusa's LAX branch is coded LAXA01, a
Rightcars station code. The dashboard card asked for ?airport=LAXA01,
matched no profile, and rendered empty while 1,249 rows of LAX data sat in
RateOffer. It only worked for the first tenant because they had named their
location SJU.

The /market page compounded it with useState('SJU') behind a <select> whose
onChange was a literal no-op, and /market/[sipp] with const airport = 'SJU'
— so opening a class from a non-SJU dashboard showed San Juan's numbers
under it.

New GET /api/market/airports lists the tenant's ACTIVE scrape profiles, so
the picker is fed by what actually has data behind it and the LAXA01/LAX
mismatch cannot recur. All three surfaces read it; selection persists per
tenant under the key the card already used, so card and page stay in sync.
'+ Add airport' now routes to profile creation instead of being a no-op.

Deliberately did NOT rename Corpusa's Location.code to LAX: sourcing from
profiles makes the rename unnecessary, and it would only have hidden the
same bug from the next tenant.

Read-only endpoint, no migration, no money code. QA SHIP.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo; echo "Pushed $TAG. Droplet: git fetch --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "FRONTEND container must rebuild too — three of the six files are frontend."
echo "No migration. Verify: 3 containers healthy + /api/health 200 +"
echo "  curl -H \"Authorization: Bearer <jwt>\" https://ridefleetmanager.com/api/market/airports  → Corpusa: LAX; IRC: SJU"
echo "  then open /market as a Corpusa admin — the dashboard must show LAX data, not an empty state."
