#!/usr/bin/env bash
# PER-LOCATION Terms & Conditions, falling back to the tenant's, then canonical.
#
# WHY. `Tenant.termsHtml` already replaces the canonical agreement for a whole
# tenant, but a multi-branch tenant can operate under DIFFERENT terms per branch.
# Corpusa's LAX runs on Rightcars' California agreement (9.5% local tax, a
# 150 mi/day cap, a $2,000 deposit for California-licensed renters) while its
# Orlando, Miami and Fort Lauderdale branches do not. With one slot per tenant,
# loading LAX's terms would have silently rebound the other three to it.
#
# WHAT SHIPS. `Location.termsHtml` + a resolver that reads location → tenant →
# canonical, wired into BOTH surfaces that show the customer the agreement:
# the printed/emailed contract AND the customer-portal signature page. Plus two
# defects QA found while reviewing it:
#   * the portal served CANONICAL terms while the contract printed the tenant's
#     override — the customer accepted one document and received another. That
#     was already true before this change; the branch axis would have widened it.
#   * `locationsService.update` filtered by tenantId only, so a branch-scoped
#     ADMIN (a role live since beta.338) could rewrite ANOTHER branch's terms —
#     i.e. its entire rental agreement body.
#
# NOT VERSIONED PER BRANCH, deliberately: TC_VERSION stays global and is what
# gets stamped, exactly as it already is for the tenant-level override. A
# per-branch version would make `autochargeBlocked` mean something different
# depending on where a car was picked up, and that flag gates money.
#
# ⚠ DO NOT LOAD LAX'S TERMS ON THE BACK OF THIS SHIP. See GATE 7. This ship is
# safe and inert on its own — every branch renders exactly what it renders today
# until someone sets a termsHtml — but the LAX rollout has an unresolved
# blocker of its own.
#
# MIGRATION: one additive nullable column. No money code.
#
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-24-ship-per-location-terms-betaNNN.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
[ -n "$BRANCH" ] || { echo "Detached HEAD" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"

TERMS="backend/src/lib/terms/index.js"
PORTAL="backend/src/modules/customer-portal/customer-portal.routes.js"
LOCSVC="backend/src/modules/locations/locations.service.js"
AGREE="backend/src/modules/rental-agreements/rental-agreements.service.js"
MIGDIR="backend/prisma/migrations/20260724_location_terms_html"
NEWTEST="backend/src/modules/locations/locations-scope.test.mjs"
SELF=".deploy-notes/2026-07-24-ship-per-location-terms-betaNNN.sh"
SRC=("$TERMS" "$PORTAL" "$LOCSVC" "$AGREE" "backend/src/lib/terms/index.test.mjs" "backend/src/modules/settings/settings.service.js")
FILES=("${SRC[@]}" "$NEWTEST" "backend/prisma/schema.prisma" "$MIGDIR/migration.sql" "backend/package.json" "$SELF")

# ── GATE 1: syntax + boot.
for F in "${SRC[@]}" "$NEWTEST"; do ( cd backend && node --check "${F#backend/}" ); done
echo "GATE 1a OK: node --check limpio."
( cd backend && DATABASE_URL="postgresql://u:p@127.0.0.1:5432/x" \
  JWT_SECRET="ship-gate-smoke-secret-not-a-real-one-000" SKIP_LISTEN=1 \
  node -e "import('./src/main.js').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})" >/dev/null 2>&1 ) \
  || { echo "ABORT: main.js does not boot-import." >&2; exit 1; }
echo "GATE 1b OK: main.js boot-import limpio."

# ── GATE 2: the resolver resolves in the right ORDER and BOTH surfaces use it.
# Serving different bodies from the two is the defect this ship exists to close;
# it is invisible in tests because each surface passes on its own.
[ "$(grep -c 'export async function getEffectiveTermsHtml' "$TERMS")" -eq 1 ] \
  || { echo "ABORT: getEffectiveTermsHtml is not exported exactly once." >&2; exit 1; }
LOC_LINE="$(grep -n 'prisma.location.findUnique' "$TERMS" | head -1 | cut -d: -f1)"
TEN_LINE="$(grep -n 'prisma.tenant.findUnique' "$TERMS" | head -1 | cut -d: -f1)"
[ -n "$LOC_LINE" ] && [ -n "$TEN_LINE" ] && [ "$LOC_LINE" -lt "$TEN_LINE" ] \
  || { echo "ABORT: the location lookup must come BEFORE the tenant lookup — otherwise the branch override never wins." >&2; exit 1; }
[ "$(grep -c 'getEffectiveTermsHtml(' "$AGREE")" -ge 1 ] \
  || { echo "ABORT: the printed agreement no longer uses the resolver." >&2; exit 1; }
[ "$(grep -c 'getEffectiveTermsHtml(' "$PORTAL")" -ge 1 ] \
  || { echo "ABORT: the portal signature page no longer uses the resolver — the customer would accept a different document than the one printed." >&2; exit 1; }
[ "$(grep -c 'getCanonicalTermsHtml()' "$PORTAL")" -eq 0 ] \
  || { echo "ABORT: the portal is serving canonical terms again." >&2; exit 1; }
# Both surfaces must key on the PICKUP location — the branch the customer signs at.
[ "$(grep -c 'pickupLocationId' "$AGREE")" -ge 1 ] && [ "$(grep -c 'pickupLocationId' "$PORTAL")" -ge 1 ] \
  || { echo "ABORT: a surface stopped passing pickupLocationId." >&2; exit 1; }
echo "GATE 2 OK: resolver ordered location→tenant, both surfaces wired to it."

# ── GATE 2b: the swallowed-error log. Without it a stale Prisma client, a failed
# migration and a branch with no override are BYTE-IDENTICAL — a wrong legal
# document with no signal anywhere. QA reproduced exactly that on this tree.
[ "$(grep -c 'location override lookup failed' "$TERMS")" -eq 1 ] \
  || { echo "ABORT: the location catch no longer logs — a wrong-terms bug would be undetectable." >&2; exit 1; }
# And the generated client must actually know the column, or every lookup throws
# into that catch and silently serves the tenant's terms.
[ "$(grep -c 'termsHtml' backend/node_modules/.prisma/client/schema.prisma 2>/dev/null || echo 0)" -ge 2 ] \
  || { echo "ABORT: the generated Prisma client predates Location.termsHtml — run 'npx prisma generate' in backend/." >&2; exit 1; }
echo "GATE 2b OK: failure is logged, generated client knows the column."

# ── GATE 2c: the branch-admin guard, and its SHAPE. The first version of this
# fix spread the allowed ids into the Prisma `where` as a second `id` key, which
# silently overwrites the first — turning "this location, if allowed" into "any
# allowed location". Both forms compile and one is a security hole.
[ "$(grep -c 'scopeAllowedLocationIds' "$LOCSVC")" -ge 1 ] \
  || { echo "ABORT: locationsService.update no longer honors the caller's locations." >&2; exit 1; }
[ "$(grep -c 'allowed.includes(String(id))' "$LOCSVC")" -eq 1 ] \
  || { echo "ABORT: the branch guard is not the explicit pre-query membership check." >&2; exit 1; }
if [ "$(grep -c 'id: { in: allowed }' "$LOCSVC")" -ne 0 ]; then
  echo "ABORT: allowed ids are back inside the where clause — a second 'id' key overwrites the first and the guard matches the WRONG row." >&2; exit 1
fi
echo "GATE 2c OK: branch guard present and in the safe shape."

# ── GATE 2d: ENCODING. `grep -c $'\r'` collapses to an EMPTY pattern in Git Bash
# and matches every line — use tr, verified against a CRLF fixture.
for F in "${SRC[@]}" "$NEWTEST" "$MIGDIR/migration.sql" backend/prisma/schema.prisma backend/package.json; do
  if [ "$(tr -dc '\r' < "$F" | wc -c)" -ne 0 ]; then echo "ABORT: $F has CR bytes." >&2; exit 1; fi
  if [ "$(grep -c 'Â\|â€\|â†\|Ã—' "$F" || true)" -ne 0 ]; then echo "ABORT: $F has mojibake." >&2; exit 1; fi
done
# NOTE: settings.service.js carries a UTF-8 BOM at HEAD already — pre-existing,
# not introduced here, so the BOM check deliberately skips it.
for F in "$TERMS" "$PORTAL" "$LOCSVC" "$NEWTEST"; do
  [ "$(head -c 3 "$F" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ] && { echo "ABORT: $F has a BOM." >&2; exit 1; }
done
echo "GATE 2d OK: no CRLF, no mojibake, no new BOM."

# ── GATE 3: migration additive + idempotent + no drift.
[ "$(grep -c 'ADD COLUMN IF NOT EXISTS' "$MIGDIR/migration.sql")" -eq 1 ] \
  || { echo "ABORT: migration is not a single idempotent ADD COLUMN." >&2; exit 1; }
if [ "$(grep -cEi '^[[:space:]]*(DROP|UPDATE|DELETE|INSERT|TRUNCATE)' "$MIGDIR/migration.sql")" -ne 0 ]; then
  echo "ABORT: migration contains a non-additive statement." >&2; exit 1
fi
[ "$(grep -c 'termsHtml      String?' backend/prisma/schema.prisma)" -eq 1 ] \
  || { echo "ABORT: schema.prisma does not declare Location.termsHtml (drift)." >&2; exit 1; }
[ "$(git diff HEAD -- backend/prisma/schema.prisma | grep -cE '^[+-][^+-].*(model |Decimal|Boolean|DateTime)')" -eq 0 ] \
  || { echo "ABORT: schema.prisma changed beyond the one nullable column." >&2; exit 1; }
echo "GATE 3 OK: migration additive/idempotent, schema matches."

# ── GATE 4: no lockfile / no dependency change; every new test is wired.
[ -z "$(git diff HEAD --name-only -- backend/package-lock.json frontend/package-lock.json 2>/dev/null)" ] \
  || { echo "ABORT: a lockfile changed." >&2; exit 1; }
[ "$(git diff HEAD -- backend/package.json | grep -c '^[+-].*"\(dependencies\|devDependencies\)"')" -eq 0 ] \
  || { echo "ABORT: dependency block changed." >&2; exit 1; }
[ -f "$NEWTEST" ] && [ "$(grep -c 'locations-scope' backend/package.json)" -eq 2 ] \
  || { echo "ABORT: locations-scope test missing or not wired (expected the script + the chain)." >&2; exit 1; }
echo "GATE 4 OK: no dep change; new test ships and runs."

# ── GATE 5: tests.
if command -v nc >/dev/null 2>&1 && nc -z localhost 5432 >/dev/null 2>&1; then
  for T in test:locations-scope test:portal test:rental-agreements test:location-hours test:checkout-session; do
    ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run "$T" ) \
      || { echo "ABORT: $T failed." >&2; exit 1; }
  done
  ( cd backend && node --test src/lib/terms/index.test.mjs ) || { echo "ABORT: terms tests failed." >&2; exit 1; }
  echo "GATE 5 OK: locations-scope + portal + rental-agreements + location-hours + checkout-session + terms green."
else
  echo "GATE 5 SKIP: no postgres on localhost:5432."
fi

# ── GATE 6: env parity.
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example 2>/dev/null || true
bash scripts/env-diff-check.sh < /dev/null || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example

# ── GATE 7: the rollout warning. This ship is inert; the LAX LOAD is not.
cat <<'SIGNOFF'

  ⚠  SHIPPING THIS IS SAFE. LOADING LAX'S TERMS ON TOP OF IT IS NOT — YET.

  Every branch renders exactly what it renders today until someone sets a
  Location.termsHtml. But the moment Rightcars' California agreement is loaded
  onto LAX, ONE signed PDF will contradict itself:

    · the BODY will say $2,000 deposit / 150 mi per day (branch terms), while
    · the ACKNOWLEDGEMENT PAGES bound into the same PDF, carrying the renter's
      own initials, still say "$500 security deposit hold" — that text is
      HARDCODED in backend/src/modules/checkout-session/terms-content.js and is
      what the wizard-v2 phone flow and the kiosk capture initials against.
    · the Flutter guest app independently asserts $300 deposit, $0.45/mi and a
      $50/hour late fee, and never shows the document at all.

  Reconcile terms-content.js (and public-booking.service.js _deriveKeyTerms)
  with the branch body — or gate those flows off for any location that has
  termsHtml set — BEFORE loading LAX. Tracked separately.

  Also known and accepted for now: terms resolve at PRINT time, so editing a
  branch's termsHtml later silently rewrites what already-signed agreements
  print and re-email, under an unchanged signature and termsVersion.

SIGNOFF
read -r -p "Understood — ship the mechanism now, do NOT load LAX terms yet? [y/N] " ok1 < /dev/tty
[ "$ok1" = "y" ] || { echo "Stopped."; exit 0; }

# ── STAGE + guard
git reset >/dev/null
git add -- "${FILES[@]}"
EXPECTED="$(printf '%s\n' "${FILES[@]}" | sort)"; STAGED="$(git diff --cached --name-only | sort)"
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
git commit -m "feat(terms): per-location Terms & Conditions with tenant fallback

Tenant.termsHtml replaces the canonical agreement for a whole tenant, but a
multi-branch tenant can operate under different terms per branch. Corpusa's
LAX runs on Rightcars' California agreement — 9.5% local tax, a 150 mi/day
cap, a \$2,000 deposit for California-licensed renters — while its Orlando,
Miami and Fort Lauderdale branches do not. With one slot per tenant, loading
LAX's terms would have silently rebound the other three to it.

Adds Location.termsHtml and getEffectiveTermsHtml(), which resolves
location → tenant → canonical. NULL everywhere today, so every branch renders
exactly what it renders now. getEffectiveTermsHtmlForTenant is kept as a
delegating wrapper so existing callers and tests are untouched.

Fixes two defects QA surfaced while reviewing it:

- The customer portal's signature page served CANONICAL terms while the
  printed agreement served the tenant's override, so the customer accepted
  one document and received another. Already true before this change; the
  branch axis would have widened it. Both surfaces now share one resolver and
  key on the PICKUP location — the branch whose counter the customer signs at.
- locationsService.update filtered by tenantId alone, so a branch-scoped
  ADMIN (live since beta.338) could rewrite ANOTHER branch's terms, i.e. its
  whole agreement body. The membership check is deliberately BEFORE the query,
  not spread into the where: a second 'id' key silently overwrites the first
  and matches the wrong row. A test pins that shape.

The failed-lookup path now logs. Without it a stale Prisma client, a failed
migration and a branch with no override produce byte-identical output — a
wrong legal document with no signal.

TC_VERSION stays GLOBAL on purpose, as it already is for the tenant-level
override: a per-branch version would make autochargeBlocked mean something
different depending on where a car was picked up, and that flag gates money.

One additive nullable column. No money code. QA FIX-FIRST → fixes applied.

Follow-ups before LAX's terms are actually loaded: terms-content.js hardcodes
a \$500 deposit into the initialled acknowledgement pages bound into the same
PDF, and the Flutter guest app asserts its own \$300/\$0.45/\$50 figures — both
would contradict a branch body. Also, terms resolve at print time, so a later
edit silently rewrites already-signed agreements.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo; echo "Pushed $TAG."
echo "Droplet: git fetch --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "MIGRATION: additive nullable column, applied by startup-migrate.js on boot (IF NOT EXISTS)."
echo "Verify: 3 containers healthy + /api/health 200, and confirm _app_migrations has 20260724_location_terms_html."
echo "Then: agreements must render EXACTLY as before — no branch has termsHtml set yet."
