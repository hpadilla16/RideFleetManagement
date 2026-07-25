#!/usr/bin/env bash
# PER-LOCATION T&C RIDER + per-branch overrides for the sections a customer initials.
#
# WHY, AND WHY IT IS NOT THE REPLACEMENT WE ALREADY SHIPPED. beta.341 added
# `Location.termsHtml`, which REPLACES the whole agreement. That is the wrong tool
# for the case that actually arrived. Corpusa's LAX source document is Rightcars'
# "Country Level Rental Policies" — a POLICY SHEET (mileage, deposits, driver age,
# fuel, fees). It contains NONE of the canonical agreement's 24 sections: no
# authorized use, no §11 card-on-file pre-authorization — the legal basis the
# tolls and citations modules rely on to bill anything after a rental closes — no
# liability release, no indemnification, no governing law. Loading it as a
# replacement would have had every LAX renter sign a contract that cannot support
# a post-rental charge, and frozen a copy of the canonical text that goes stale
# the next time TC_VERSION moves.
#
# So the branch keeps the canonical base and APPENDS `termsRiderHtml`.
#
# `termsSectionsJson` closes the other half. The acknowledgement sections the
# customer initials on their phone or at the kiosk were HARDCODED, and the same
# text is re-printed inside the agreement PDF beside each captured initial image.
# With a LAX rider stating a $2,000 deposit, one signed PDF would have carried
# "$500 security deposit hold" on the page bearing the renter's own initials.
#
# QA (FIX-FIRST → fixed): all four acknowledgement surfaces now resolve the branch
# from RentalAgreement.pickupLocation, never Reservation.pickupLocation — those two
# fields can diverge (reservations.service.js:1921 moves the reservation's with no
# sync) and the PDF reads the agreement's, so mixing them let ONE signed document
# show two branches' wording. Bad config now logs instead of silently serving
# canonical text. The rider's own 34 tests were not in the `npm test` chain; now
# they are.
#
# MIGRATION: two additive nullable columns. No money code.
#
# ⚠ SHIPPING THIS IS INERT — every branch renders exactly what it renders today
# until someone sets a column. LOADING LAX'S CONTENT IS A SEPARATE STEP with its
# own gate. See GATE 7.
#
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-24-ship-location-terms-rider-betaNNN.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
[ -n "$BRANCH" ] || { echo "Detached HEAD" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"

TERMS="backend/src/lib/terms/index.js"
CONTENT="backend/src/modules/checkout-session/terms-content.js"
SIGNING="backend/src/modules/checkout-session/terms-signing.service.js"
KIOSK="backend/src/modules/kiosk/kiosk-checkout.service.js"
AGREE="backend/src/modules/rental-agreements/rental-agreements.service.js"
LOCSVC="backend/src/modules/locations/locations.service.js"
MIGDIR="backend/prisma/migrations/20260724_location_terms_rider"
SELF=".deploy-notes/2026-07-24-ship-location-terms-rider-betaNNN.sh"
SRC=("$TERMS" "$CONTENT" "$SIGNING" "$KIOSK" "$AGREE" "$LOCSVC")
TESTS=(
  "backend/src/lib/terms/index.test.mjs"
  "backend/src/modules/checkout-session/terms-section-overrides.test.mjs"
  "backend/src/modules/locations/locations-scope.test.mjs"
)
FILES=("${SRC[@]}" "${TESTS[@]}" "backend/prisma/schema.prisma" "$MIGDIR/migration.sql" "backend/package.json" "$SELF")

# ── GATE 1: syntax + boot. The backend does NOT boot if a module imported at the
# top level of main.js is missing from FILES[] — catch that here, not on the droplet.
for F in "${SRC[@]}" "${TESTS[@]}"; do ( cd backend && node --check "${F#backend/}" ); done
echo "GATE 1a OK: node --check limpio."
( cd backend && DATABASE_URL="postgresql://u:p@127.0.0.1:5432/x" \
  JWT_SECRET="ship-gate-smoke-secret-not-a-real-one-000" SKIP_LISTEN=1 \
  node -e "import('./src/main.js').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})" >/dev/null 2>&1 ) \
  || { echo "ABORT: main.js does not boot-import." >&2; exit 1; }
echo "GATE 1b OK: main.js boot-import limpio."

# ── GATE 2: the rider must APPEND, never replace. If withRider is dropped or the
# rider is returned on its own, a branch silently loses the canonical agreement —
# which is the whole reason this ship exists instead of reusing termsHtml.
[ "$(grep -c 'function withRider' "$TERMS")" -eq 1 ] \
  || { echo "ABORT: withRider is gone — the rider would replace instead of append." >&2; exit 1; }
[ "$(grep -c 'withRider(' "$TERMS")" -ge 4 ] \
  || { echo "ABORT: withRider is not applied on every resolver exit (location / tenant / canonical)." >&2; exit 1; }
[ "$(grep -c 'termsRiderHtml: true' "$TERMS")" -eq 1 ] \
  || { echo "ABORT: the resolver no longer reads termsRiderHtml." >&2; exit 1; }
echo "GATE 2 OK: rider appended at every resolver exit."

# ── GATE 2b: THE KEY-SET INVARIANT. sectionKey is persisted to
# AgreementSectionInitial and re-matched when the PDF re-prints the initialled
# pages. If an override could add, rename or drop a key, it would orphan initials
# a customer has already signed. parseSectionOverrides copying ONLY body/label is
# what enforces that — a hostile override carrying `key` must not take effect.
[ "$(grep -c 'export function parseSectionOverrides' "$CONTENT")" -eq 1 ] \
  || { echo "ABORT: parseSectionOverrides is gone." >&2; exit 1; }
if [ "$(grep -cE '^\s*(entry|out)\[?.*\bkey\b\s*=' "$CONTENT")" -ne 0 ]; then
  echo "ABORT: parseSectionOverrides looks like it now copies a key field — that breaks AgreementSectionInitial matching." >&2; exit 1
fi
[ "$(grep -c 'known.has(key)' "$CONTENT")" -eq 1 ] \
  || { echo "ABORT: unknown override keys are no longer filtered against the canonical set." >&2; exit 1; }
echo "GATE 2b OK: overrides cannot touch the key set."

# ── GATE 2c: ONE SOURCE OF TRUTH FOR THE BRANCH. Every acknowledgement surface
# must resolve from RentalAgreement.pickupLocation. Reservation.pickupLocationId is
# mutable (reservations.service.js:1921) with no sync to the agreement, and the PDF
# reads the agreement's — so a surface reading the reservation lets ONE signed
# document show two branches' wording. This is the QA M2 finding.
if [ "$(grep -rcE 'reservation\??\.pickupLocation\??\.termsSectionsJson|resv\.pickupLocation\??\.termsSectionsJson' backend/src || true)" != "" ]; then
  HITS="$(grep -rlE 'reservation\??\.pickupLocation\??\.termsSectionsJson|resv\.pickupLocation\??\.termsSectionsJson' backend/src || true)"
  [ -z "$HITS" ] || { echo "ABORT: an acknowledgement surface reads the RESERVATION's branch, not the agreement's:" >&2; printf '%s\n' "$HITS" >&2; exit 1; }
fi
SITES="$(grep -rc 'sectionOverrides:' "$SIGNING" "$KIOSK" "$AGREE" | awk -F: '{s+=$2} END {print s}')"
[ "$SITES" -eq 7 ] \
  || { echo "ABORT: expected 7 sectionOverrides call sites (signing 4, kiosk 2, PDF 1); found $SITES." >&2; exit 1; }
echo "GATE 2c OK: all 7 surfaces resolve the branch from the agreement."

# ── GATE 2d: bad config must be LOUD. There is no admin UI for these columns and
# PATCH /api/locations/:id validates nothing, so a truncated blob or a typo'd key
# would otherwise leave a branch signing canonical text while ops believes
# otherwise — a wrong legal document with no signal.
[ "$(grep -c 'not valid JSON' "$CONTENT")" -eq 1 ] \
  || { echo "ABORT: a malformed termsSectionsJson no longer logs." >&2; exit 1; }
[ "$(grep -c 'match no acknowledgement section' "$CONTENT")" -eq 1 ] \
  || { echo "ABORT: unknown override keys no longer log." >&2; exit 1; }
[ "$(grep -c 'location override lookup failed' "$TERMS")" -eq 1 ] \
  || { echo "ABORT: the resolver's location lookup no longer logs its failure." >&2; exit 1; }
echo "GATE 2d OK: every silent-wrong-document path logs."

# ── GATE 2e: the generated Prisma client must know both columns, or every read
# throws into a catch and silently serves the wrong text.
[ "$(grep -c 'termsRiderHtml\|termsSectionsJson' backend/node_modules/.prisma/client/schema.prisma 2>/dev/null || echo 0)" -ge 2 ] \
  || { echo "ABORT: the generated Prisma client predates the new columns — run 'npx prisma generate' in backend/." >&2; exit 1; }
echo "GATE 2e OK: generated client knows the new columns."

# ── GATE 2f: ENCODING. `grep -c $'\r'` collapses to an EMPTY pattern in this Git
# Bash and matches every line — `tr -dc` counts real CR bytes (verified against a
# CRLF fixture). ASCII-only in migration SQL: the sibling migration's U+2192 hard-
# fails on a WIN1252 database, and startup-migrate is fail-open so it would retry
# forever with no record.
for F in "${SRC[@]}" "${TESTS[@]}" "$MIGDIR/migration.sql" backend/prisma/schema.prisma backend/package.json; do
  [ "$(tr -dc '\r' < "$F" | wc -c)" -eq 0 ] || { echo "ABORT: $F has CR bytes." >&2; exit 1; }
  [ "$(grep -c 'Â\|â€\|â†\|Ã—' "$F" || true)" -eq 0 ] || { echo "ABORT: $F has mojibake." >&2; exit 1; }
  [ "$(head -c 3 "$F" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ] && { echo "ABORT: $F has a BOM." >&2; exit 1; }
done
echo "GATE 2f OK: no CR, no mojibake, no BOM."

# ── GATE 3: migration additive + idempotent + no drift. TWO statements here (one
# per column) — do NOT copy beta.341's "exactly one ADD COLUMN" assertion.
[ "$(grep -c 'ADD COLUMN IF NOT EXISTS' "$MIGDIR/migration.sql")" -eq 2 ] \
  || { echo "ABORT: expected exactly 2 idempotent ADD COLUMNs." >&2; exit 1; }
if [ "$(grep -cEi '^[[:space:]]*(DROP|UPDATE|DELETE|INSERT|TRUNCATE|ALTER TABLE[^;]*(DROP|ALTER) COLUMN)' "$MIGDIR/migration.sql")" -ne 0 ]; then
  echo "ABORT: migration contains a non-additive statement." >&2; exit 1
fi
[ "$(grep -c 'termsRiderHtml String?' backend/prisma/schema.prisma)" -eq 1 ] \
  && [ "$(grep -c 'termsSectionsJson String?' backend/prisma/schema.prisma)" -eq 1 ] \
  || { echo "ABORT: schema.prisma does not declare both columns (drift)." >&2; exit 1; }
[ "$(git diff HEAD -- backend/prisma/schema.prisma | grep -cE '^[+-][^+-].*(model |Decimal|Boolean|DateTime|@relation)')" -eq 0 ] \
  || { echo "ABORT: schema.prisma changed beyond the two nullable columns." >&2; exit 1; }
echo "GATE 3 OK: migration additive/idempotent, schema matches, no drift."

# ── GATE 4: no lockfile / no dep change; every new test is WIRED. The rider's own
# 34 tests were unwired on the first pass — the primary feature had zero coverage
# in the chain.
[ -z "$(git diff HEAD --name-only -- backend/package-lock.json frontend/package-lock.json 2>/dev/null)" ] \
  || { echo "ABORT: a lockfile changed." >&2; exit 1; }
[ "$(git diff HEAD -- backend/package.json | grep -c '^[+-].*"\(dependencies\|devDependencies\)"')" -eq 0 ] \
  || { echo "ABORT: dependency block changed." >&2; exit 1; }
for S in test:terms test:terms-sections; do
  [ "$(grep -c "\"$S\":" backend/package.json)" -eq 1 ] || { echo "ABORT: $S script missing." >&2; exit 1; }
  [ "$(grep -c "npm run $S" backend/package.json)" -ge 1 ] || { echo "ABORT: $S is not in the npm test chain — it would never run." >&2; exit 1; }
done
echo "GATE 4 OK: no dep change; test:terms and test:terms-sections both wired."

# ── GATE 5: tests. kiosk is included because this ship edits kiosk-checkout.
if command -v nc >/dev/null 2>&1 && nc -z localhost 5432 >/dev/null 2>&1; then
  for T in test:terms test:terms-sections test:locations-scope test:portal \
           test:rental-agreements test:checkout-session test:kiosk test:location-hours; do
    ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run "$T" ) \
      || { echo "ABORT: $T failed." >&2; exit 1; }
  done
  echo "GATE 5 OK: terms + sections + locations + portal + agreements + checkout + kiosk green."
else
  echo "GATE 5 SKIP: no postgres on localhost:5432."
fi

# ── GATE 6: env parity.
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example 2>/dev/null || true
bash scripts/env-diff-check.sh < /dev/null || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example

# ── GATE 7: what this ship does NOT do.
cat <<'SIGNOFF'

  This ship is INERT. Every branch renders exactly what it renders today until
  someone writes Location.termsRiderHtml or Location.termsSectionsJson.

  LOADING LAX'S CONTENT IS A SEPARATE STEP, and it has a real precondition:

    Terms resolve at PRINT time. There is no snapshot. So setting these columns
    RE-RENDERS every already-signed agreement at that branch — new text beside
    initials the customer captured on the old text.

    Before loading, check what is already signed there:

      SELECT ra."agreementNumber", ra."tcSignedAt",
             (SELECT count(*) FROM "AgreementSectionInitial" i
                WHERE i."agreementId" = ra.id) AS initials
      FROM "RentalAgreement" ra
      WHERE ra."pickupLocationId" = '<location id>';

    At the time of writing LAX has exactly one: RA-20260724163421-8314, signed
    2026-07-24 by "Hector Padilla" with 6 initials — a test rental, both customer
    and signer. Treat these two columns as append-only-before-first-real-signature
    until a sign-time snapshot exists (tracked as a follow-up).

SIGNOFF
read -r -p "Understood — ship the mechanism, load content separately? [y/N] " ok1 < /dev/tty
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
git commit -m "feat(terms): per-location T&C rider + per-branch acknowledgement text

beta.341 added Location.termsHtml, which REPLACES the whole agreement. That is
the wrong tool for the case that arrived. Corpusa's LAX source document is
Rightcars' \"Country Level Rental Policies\" — a policy sheet covering mileage,
deposits, driver age, fuel and fees. It contains none of the canonical
agreement's 24 sections: no authorized use, no §11 card-on-file
pre-authorization (the legal basis the tolls and citations modules rely on to
bill after a rental closes), no liability release, no indemnification, no
governing law. Loading it as a replacement would have had every LAX renter sign
a contract that cannot support a post-rental charge, and frozen a copy of the
canonical text that goes stale the next time TC_VERSION moves.

Location.termsRiderHtml is APPENDED to whatever the resolver produced, so the
branch keeps inheriting agreement updates and only its local policies are
branch-specific.

Location.termsSectionsJson closes the other half. The acknowledgement sections
the customer initials on their phone or at the kiosk were HARDCODED, and the
same text is re-printed inside the agreement PDF beside each captured initial.
With a LAX rider stating a \$2,000 deposit, one signed PDF would have carried
\"\$500 security deposit hold\" on the page bearing the renter's own initials.
Overrides replace body/label BY KEY only — sectionKey is persisted to
AgreementSectionInitial, so a branch-specific key would orphan initials already
signed. A test proves a hostile override carrying \`key\` cannot take effect.

QA returned FIX-FIRST; all four must-fixes are in:
- All 7 acknowledgement call sites now resolve the branch from
  RentalAgreement.pickupLocation, never Reservation.pickupLocation. Those fields
  diverge — reservationsService.update moves the reservation's with no sync — and
  the PDF reads the agreement's, so mixing them let ONE signed document show two
  branches' wording.
- A malformed blob or an unknown key now LOGS. There is no admin UI for these
  columns and the PATCH route validates nothing, so silence meant a branch
  signing canonical text while ops believed otherwise.
- test:terms (34 tests, including all 6 rider tests) was in no npm script; the
  primary feature had zero coverage in the chain. Now wired.
- Verified LAX has exactly one signed agreement (a test rental) before content
  load, since terms resolve at print time with no snapshot.

Also: locationsService.list() now omits the three terms columns. They are
documents — the canonical agreement is ~70 KB — and that list is cached in
process and reached again through two more cached reservation endpoints.

Two additive nullable columns. No money code. Inert until a column is set.

Follow-up: snapshot the resolved body at sign time and print from the snapshot,
so editing a branch's terms cannot re-render an already-signed agreement.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo; echo "Pushed $TAG."
echo "Droplet: git fetch --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "MIGRATION: two additive nullable columns, applied by startup-migrate.js on boot (IF NOT EXISTS)."
echo "Verify: 3 containers healthy + /api/health 200 + _app_migrations has 20260724_location_terms_rider,"
echo "  then confirm an existing agreement PDF renders EXACTLY as before (no branch has a rider set yet)."
