#!/usr/bin/env bash
# ops/.agent-patches sweep — fixes #05 #06 #07 #08 (QA SHIP). BACKEND ONLY.
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-17-ship-agent-patches-sweep-betaNNN.sh
#
# WHAT:
#   #05 open-rental 409 — PATCH /api/reservations/:id honored the service's
#       explicit err.statusCode=409 ("Vehicle is still out on open rental…")
#       instead of falling through to next(e) -> 500 (Sentry -1P).
#   #06 updateReservation vehicleChanged status-sync — the LOANER SWAP write
#       path: a PATCH that reassigns vehicleId on a CHECKED_OUT reservation now
#       syncs Vehicle.status (new car ON_RENT, old car released; PRE-patch
#       vehicleId passed so the stale car is the one released). Distinct path
#       from the direct swap-vehicle fix already in HEAD (commit 1a00265).
#   #07 PII redaction — recipient email/phone go in the logger META under keys
#       the Winston redactor masks (`email`/`phone`), never in the message
#       string: emailAgreement async, checkin invoice/receipt, long-term
#       emails, SMS providers.
#   #08 precheckin/staff-complete — same explicit-4xx mapping as #05 (the
#       route re-validates the vehicle on every patch and threw the 409 there).
#
# ⚠️ SURGICAL PACKAGING (the reason this script exists — QA FIX-FIRST):
# Three staged files ALSO carry the UNCOMMITTED swap-photos workstream (tag B),
# and tag B MOVED normalizeSwapInspectionPayload + vehicleDisplayLabel out of
# reservations.service.js into swap-photos.js — the working copy IMPORTS
# ./swap-photos.js, which is NOT in this tag. Staging the working copy = the
# backend does not boot (repo's #1 crash cause; cf. c97dbda / beta.315).
# So for each ⚠ file we cut the staged candidate from `git show HEAD:<file>`
# + ONLY the A hunks (selected by content marker, applied with git apply),
# stage that, and restore the working copy — same trick as the surgical
# package.json in 2026-06-10-ship-swap-vehicle-status-sync.sh, extended to
# source files. The staged candidate KEEPS the local helper definitions and
# carries NO swap-photos import — both are gated below, plus a full
# import-resolve over the materialized staged tree.
#
# package.json: HEAD copy + the test:reservations line rebuilt to add ONLY
# this tag's two new test files, and `--test-force-exit` (QA FIX-FIRST: the
# suite hangs on an open prisma handle — flagged since beta.311). Tag B's
# swap-photos tests are NOT in the line.
#
# SHIP ORDER: this is TAG A. Tag B (2026-07-17-ship-swap-vehicle-photos)
# REQUIRES this tag's hunks in HEAD and gates on them — ship A first.
#
# DEPLOY (BACKEND + WORKER, no migration, no new env keys, frontend untouched):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG:-SET-NEXT-BETA-TAG}"
SELF=".deploy-notes/2026-07-17-ship-agent-patches-sweep-betaNNN.sh"

[ -n "$BRANCH" ] || { echo "ABORT: detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "ABORT: must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
# TAG sentinel: 302 and 312-316 are kiosk's; beta.317 was the last shipped.
# A and B ship consecutively — pick the next free beta for A, the one after for B.
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "ABORT: set TAG=v0.9.0-beta.NNN (next free beta; 302/312-316 are kiosk-taken, 317 already shipped)." >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: tag $TAG already exists." >&2; exit 1; }
echo "Shipping TAG A ($TAG) from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

# ── Idempotency: if the A hunks are already in HEAD this ship already landed ──
if git show HEAD:backend/src/modules/reservations/reservations.service.js | grep -q "const vehicleChanged"; then
  echo "ABORT: HEAD already contains the #06 vehicleChanged hunk — tag A appears already shipped. Nothing to do (proceed to tag B)." >&2; exit 1
fi

# ── SCRATCH + TRAP: every working-tree file we temporarily rewrite is saved ──
# first and restored on EXIT no matter what. The script never leaves the
# working tree modified (tag B's uncommitted hunks stay intact).
SCRATCH="$(mktemp -d)"
save_working() {  # save_working <repo-relative-path>
  mkdir -p "$SCRATCH/wt/$(dirname "$1")"
  cp "$1" "$SCRATCH/wt/$1"
  printf '%s\n' "$1" >> "$SCRATCH/restore-list"
}
restore_working() {
  if [ -f "$SCRATCH/restore-list" ]; then
    while IFS= read -r p; do [ -f "$SCRATCH/wt/$p" ] && cp "$SCRATCH/wt/$p" "$p" || true; done < "$SCRATCH/restore-list"
  fi
  rm -rf "$SCRATCH" || true
}
trap restore_working EXIT

# ── The three ⚠ surgical files: marker selects the A hunk(s), count is exact ──
SURGICAL_FILES=(
  "backend/src/modules/reservations/reservations.service.js"
  "backend/src/modules/reservations/reservations.routes.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
)
SURGICAL_MARKERS=(
  "vehicleChanged"            # #06 hunk only (statusChanged||vehicleChanged + PRE-patch vehicleId)
  "sendExplicitStatusError"   # helper def + the 2 call sites (#05 + #08) — 3 hunks
  "email-agreement"           # the ~3610 PII meta-object hunk only (#07)
)
SURGICAL_EXPECT=( 1 3 1 )

# Whole-file A members (working copies are pure A — verified by QA + the
# contamination gate below re-proves it on the staged diff).
FILES=(
  "backend/src/modules/rental-agreements/checkin-emails.service.js"
  "backend/src/modules/rental-agreements/rental-agreements-email-async.test.mjs"
  "backend/src/modules/long-term/long-term-emails.js"
  "backend/src/modules/sms/sms-providers.js"
  "backend/src/lib/logger-redact.test.mjs"
  "backend/src/modules/reservations/update-vehicle-change-status-sync.test.mjs"
  "backend/src/modules/reservations/open-rental-409.test.mjs"
  "$SELF"
)
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "ABORT: FILES[] member missing from working tree: $f" >&2; exit 1; }
done

# Hunk filter: keep only diff hunks whose body matches the A marker.
cat > "$SCRATCH/filter-hunks.awk" <<'AWK_EOF'
/^@@/ { if (h != "" && keep) printf "%s", h; h = $0 "\n"; keep = 0; inhunk = 1; next }
!inhunk { print; next }
{ h = h $0 "\n"; if ($0 ~ WANT) keep = 1 }
END { if (h != "" && keep) printf "%s", h }
AWK_EOF

# ── STEP 1: compute all three A patches BEFORE touching the working tree ─────
i=0
for F in "${SURGICAL_FILES[@]}"; do
  M="${SURGICAL_MARKERS[$i]}"; EXP="${SURGICAL_EXPECT[$i]}"
  base="$SCRATCH/surg$i"
  git diff -U3 HEAD -- "$F" > "$base.full.patch"
  [ -s "$base.full.patch" ] || { echo "ABORT: $F has no working-tree diff vs HEAD — expected A+B hunks. Wrong tree state." >&2; exit 1; }
  awk -v WANT="$M" -f "$SCRATCH/filter-hunks.awk" "$base.full.patch" > "$base.A.patch"
  n="$(grep -c '^@@' "$base.A.patch" || true)"
  [ "$n" = "$EXP" ] || { echo "ABORT: $F — A-hunk filter (marker '$M') selected $n hunks, expected $EXP. The working diff changed shape — re-verify by hand." >&2; exit 1; }
  i=$((i+1))
done
echo "STEP 1 OK: A hunks isolated (1 + 3 + 1) from the three shared files."

# ── STEP 2: stage HEAD + A-hunks for each ⚠ file, then restore working copy ──
git reset >/dev/null
i=0
for F in "${SURGICAL_FILES[@]}"; do
  base="$SCRATCH/surg$i"
  save_working "$F"
  git show "HEAD:$F" > "$F"                      # working tree = HEAD, temporarily
  git apply --whitespace=nowarn "$base.A.patch" \
    || { echo "ABORT: A patch did not apply onto HEAD copy of $F." >&2; exit 1; }
  node --check "$F" || { echo "ABORT: node --check failed on staged candidate $F." >&2; exit 1; }
  # The candidate must NOT reference tag B's module in any form.
  grep -q "swap-photos" "$F" && { echo "ABORT: staged candidate $F references swap-photos — B leaked into the A cut." >&2; exit 1; }
  git add -- "$F"
  cp "$SCRATCH/wt/$F" "$F"                       # working tree back to A+B immediately
  i=$((i+1))
done
# reservations.service.js candidate must KEEP the local helper definitions that
# tag B moves into swap-photos.js — without them the A tree throws at boot.
git show :backend/src/modules/reservations/reservations.service.js > "$SCRATCH/staged-res-service.js"
grep -q "^function vehicleDisplayLabel"          "$SCRATCH/staged-res-service.js" || { echo "ABORT: staged reservations.service.js lost the local vehicleDisplayLabel definition." >&2; git reset >/dev/null; exit 1; }
grep -q "^function normalizeSwapInspectionPayload" "$SCRATCH/staged-res-service.js" || { echo "ABORT: staged reservations.service.js lost the local normalizeSwapInspectionPayload definition." >&2; git reset >/dev/null; exit 1; }
echo "STEP 2 OK: three surgical files staged (HEAD + A hunks; local helpers kept; zero swap-photos refs). Working tree restored."

# ── STEP 3: SURGICAL package.json (HEAD copy + rebuilt test:reservations) ────
save_working "backend/package.json"
git show HEAD:backend/package.json > "$SCRATCH/pkg-head.json"
HEAD_LINE="$(grep '"test:reservations"' "$SCRATCH/pkg-head.json")"
[ -n "$HEAD_LINE" ] || { echo "ABORT: no test:reservations line in HEAD package.json." >&2; exit 1; }
grep -q -- '--test-force-exit' <<<"$HEAD_LINE" && { echo "ABORT: HEAD test:reservations already has --test-force-exit — tag A appears already shipped." >&2; exit 1; }
grep -q 'swap-vehicle-status-sync.test.mjs"' <<<"$HEAD_LINE" || { echo "ABORT: HEAD test:reservations line lost its expected tail anchor." >&2; exit 1; }
NEW_LINE="$(printf '%s' "$HEAD_LINE" \
  | sed 's|node --test |node --test --test-force-exit |' \
  | sed 's|swap-vehicle-status-sync.test.mjs"|swap-vehicle-status-sync.test.mjs src/modules/reservations/update-vehicle-change-status-sync.test.mjs src/modules/reservations/open-rental-409.test.mjs"|')"
awk -v repl="$NEW_LINE" '{ if ($0 ~ /"test:reservations"/) print repl; else print }' "$SCRATCH/pkg-head.json" > "$SCRATCH/pkg-A.json"
node -e "JSON.parse(require('fs').readFileSync('$SCRATCH/pkg-A.json','utf8'))" \
  || { echo "ABORT: re-cut package.json is not valid JSON." >&2; exit 1; }
cp "$SCRATCH/pkg-A.json" backend/package.json
git add -- backend/package.json
cp "$SCRATCH/wt/backend/package.json" backend/package.json
echo "STEP 3 OK: package.json = HEAD + test:reservations(A tests only, --test-force-exit)."

# ── STEP 4: stage the whole-file members ─────────────────────────────────────
git add -- "${FILES[@]}"

# ── GATE 1: staged package.json = exactly ONE changed line, the right one ────
PKG_CHANGED="$(git diff --cached backend/package.json | grep -E '^[+-][^+-]' || true)"
PKG_COUNT="$(printf '%s\n' "$PKG_CHANGED" | grep -c . || true)"
[ "$PKG_COUNT" = "2" ] || { echo "ABORT: package.json staged with $PKG_COUNT changed lines, expected 2 (-old/+new test:reservations):"; echo "$PKG_CHANGED"; git reset >/dev/null; exit 1; }
printf '%s\n' "$PKG_CHANGED" | grep -v 'test:reservations' | grep -q . && { echo "ABORT: package.json staged beyond test:reservations:"; echo "$PKG_CHANGED"; git reset >/dev/null; exit 1; }
PKG_PLUS="$(printf '%s\n' "$PKG_CHANGED" | grep '^+' )"
grep -q -- '--test-force-exit' <<<"$PKG_PLUS" || { echo "ABORT: new test:reservations line lacks --test-force-exit (QA FIX-FIRST)." >&2; git reset >/dev/null; exit 1; }
grep -q 'update-vehicle-change-status-sync.test.mjs' <<<"$PKG_PLUS" || { echo "ABORT: new line missing update-vehicle-change-status-sync.test.mjs" >&2; git reset >/dev/null; exit 1; }
grep -q 'open-rental-409.test.mjs' <<<"$PKG_PLUS" || { echo "ABORT: new line missing open-rental-409.test.mjs" >&2; git reset >/dev/null; exit 1; }
grep -qE 'swap-photos|swap-vehicle-photos|swap-photo-override' <<<"$PKG_PLUS" && { echo "ABORT: tag B's test files leaked into the A test:reservations line." >&2; git reset >/dev/null; exit 1; }
echo "GATE 1 OK: package.json staged = the rebuilt test:reservations line only."

# ── GATE 2: CONTAMINATION — nothing from another workstream rides this tag ───
STAGED_NAMES="$(git diff --cached --name-only)"
LEAK="$(printf '%s\n' "$STAGED_NAMES" | grep -E \
  'schema\.prisma|migrations/|locales|kiosk|advantage|swap-photos|^frontend/|PendingFranchiseImportsTray|settings/page\.js|^backend/src/lib/prisma\.js$|customers\.service\.js|\.fuse_hidden' || true)"
[ -z "$LEAK" ] || { echo "ABORT: foreign workstream files staged:"; printf '%s\n' "$LEAK"; git reset >/dev/null; exit 1; }
# Content sweep over the staged BACKEND diff (SELF excluded — this script names
# the markers in its own gates). NOTE: photoStorageRefs/SwapInspection exist in
# HEAD since beta.310 — that's why we grep the DIFF, never the whole files.
CONTENT_LEAK="$(git diff --cached -- backend/ | grep -E '^[+-][^+-]' | grep -iE \
  'swap-photos|SwapInspection|LoanerVehicleSwap|override|advantage|kiosk|phoneNormalized' || true)"
[ -z "$CONTENT_LEAK" ] || { echo "ABORT: foreign workstream CONTENT in the staged diff:"; printf '%s\n' "$CONTENT_LEAK" | head -20; git reset >/dev/null; exit 1; }
echo "GATE 2 OK: staged diff is A-only (no swap-photos/override/advantage/kiosk/phoneNormalized/schema/migrations/locales/FUSE)."

# ── GATE 3: IMPORT-RESOLVE over the STAGED TREE (the boot gate) ──────────────
# Materialize the index (= exactly the tag's tree) and walk every relative
# import from main.js + worker.js. This PROVES reservations.service.js resolves
# WITHOUT swap-photos.js present. (Dry-verified 2026-07-17: 317 modules OK.)
STAGED_TREE="$SCRATCH/staged-tree"; mkdir -p "$STAGED_TREE"
git checkout-index -a --prefix="$STAGED_TREE/"
[ -f "$STAGED_TREE/backend/src/modules/reservations/swap-photos.js" ] \
  && { echo "ABORT: swap-photos.js is in the staged tree — it must NOT ship in tag A." >&2; git reset >/dev/null; exit 1; }
cat > "$SCRATCH/resolve-chain.mjs" <<'RESOLVER_EOF'
import fs from 'node:fs';
import path from 'node:path';
const roots = process.argv.slice(2);
const seen = new Set(); const missing = []; let count = 0;
const RE = /(?:\bfrom\s*|\bimport\s*|\bexport\s+\*\s*from\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}
function resolveFile(p) {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  for (const ext of ['.js', '.mjs', '.json']) if (fs.existsSync(p + ext)) return p + ext;
  for (const idx of ['/index.js', '/index.mjs']) if (fs.existsSync(p + idx)) return p + idx;
  return null;
}
function walk(file, from) {
  const real = resolveFile(file);
  if (!real) { missing.push(`${from || '(entry)'}  ->  ${file}`); return; }
  if (seen.has(real)) return;
  seen.add(real); count++;
  for (const m of stripComments(fs.readFileSync(real, 'utf8')).matchAll(RE)) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    walk(path.resolve(path.dirname(real), spec), real);
  }
}
for (const r of roots) walk(path.resolve(r), null);
if (missing.length) {
  console.error(`CHAIN BROKEN — ${missing.length} import(s) unresolved IN THE TAG TREE:`);
  for (const m of missing) console.error('  ' + m);
  console.error('The backend would NOT BOOT. Fix the staged cut / FILES[].');
  process.exit(1);
}
console.log(`CHAIN RESOLVES OK — ${count} modules reachable from ${roots.length} entrypoints.`);
RESOLVER_EOF
node "$SCRATCH/resolve-chain.mjs" "$STAGED_TREE/backend/src/main.js" "$STAGED_TREE/backend/src/worker.js" \
  || { echo "ABORT: staged-tree import chain broken (repo's #1 boot-crash cause)." >&2; git reset >/dev/null; exit 1; }
echo "GATE 3 OK: staged tree boots on paper — resolves WITHOUT swap-photos.js."

# ── GATE 4: TESTS ────────────────────────────────────────────────────────────
( cd backend && npm run test:logger ) || { echo "ABORT: test:logger failed (PII redaction contract)." >&2; git reset >/dev/null; exit 1; }
echo "GATE 4a OK: test:logger green."
# DB-backed A tests, individually, against the REAL dev DB. GOTCHA: backend/.env
# points at dead localhost:5433 — dev DB is localhost:5432/fleet_management.
if nc -z localhost 5432 >/dev/null 2>&1; then
  for T in src/modules/reservations/update-vehicle-change-status-sync.test.mjs \
           src/modules/reservations/open-rental-409.test.mjs \
           src/modules/rental-agreements/rental-agreements-email-async.test.mjs; do
    ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" \
        node --test --test-force-exit "$T" ) \
      || { echo "ABORT: $T failed against localhost:5432." >&2; git reset >/dev/null; exit 1; }
  done
  echo "GATE 4b OK: update-vehicle-change-status-sync + open-rental-409 + rental-agreements-email-async green vs 5432."
else
  echo "############################################################"
  echo "GATE 4b SKIP: no postgres on localhost:5432 — the DB-backed"
  echo "A tests did NOT run. Bring up the dev DB (brew postgres,"
  echo "db fleet_management) and re-run for the full proof."
  echo "############################################################"
fi

# ── GATE 5: ENV PARITY via HEAD's .env.example ───────────────────────────────
# .env.example is NOT in FILES[] → the tag carries HEAD's copy. The WORKING
# copy holds 11 unshipped ADVANTAGE_* keys that would fail-close the check even
# though this tag doesn't ship them — so we check against HEAD's copy (the
# swap-script trick) and restore. `< /dev/null`: env-diff's ssh eats stdin.
save_working "backend/.env.example"
git checkout HEAD -- backend/.env.example
if ! bash scripts/env-diff-check.sh < /dev/null; then
  cp "$SCRATCH/wt/backend/.env.example" backend/.env.example
  echo "ABORT: env-diff-check failed against HEAD's .env.example — resolve before deploy." >&2
  git reset >/dev/null; exit 1
fi
cp "$SCRATCH/wt/backend/.env.example" backend/.env.example
echo "GATE 5 OK: env parity (checked against HEAD's .env.example — the tag's actual copy)."

# ── REVIEW + CONFIRM ─────────────────────────────────────────────────────────
echo; git diff --cached --stat; echo
echo "Review the surgical cuts (must show ONLY the A hunks):"
echo "  git diff --cached -- backend/src/modules/reservations/reservations.service.js"
echo "  git diff --cached -- backend/src/modules/reservations/reservations.routes.js"
echo "  git diff --cached -- backend/src/modules/rental-agreements/rental-agreements.service.js"
echo "  git diff --cached -- backend/package.json"
echo
# read < /dev/tty — never inherit stdin (env-diff/ssh eats it; scripts have hung on this).
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git reset"; exit 0; }

git commit -m "fix(backend): agent-patches sweep — open-rental 409, vehicleChanged status-sync, PII log redaction (#05-#08)

#05/#08: PATCH /api/reservations/:id and precheckin/staff-complete honor the
service layer's explicit 4xx statusCode (shared sendExplicitStatusError). The
open-rental guard ('Vehicle is still out on open rental…') sets 409 but did
not match the /vehicle conflict/i string test, so both routes 500'd (Sentry
-1P on each).

#06: updateReservation syncs Vehicle.status when a PATCH reassigns vehicleId
(not only on status change) — the dealership-loaner swap write path. Passes
the PRE-patch vehicleId so the swapped-out car is released (locked states
respected). Distinct path from the direct swap-vehicle fix (1a00265).

#07: recipient email/phone moved into logger meta under redacted keys
(email/phone) across emailAgreement async, checkin invoice/receipt emails,
long-term emails and SMS providers — message-string interpolation bypassed
the Winston key-based redactor (PII-in-logs).

Packaging: reservations.service.js / reservations.routes.js /
rental-agreements.service.js staged as HEAD + ONLY these hunks — the working
tree also carries the unshipped swap-photos workstream, whose copy imports
./swap-photos.js (not in this tag) and would not boot. Import chain proven
over the materialized staged tree. test:reservations gains the two new tests
+ --test-force-exit (suite hung on an open prisma handle). No migrations,
no new env keys, no money/gateway code."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"

cat <<EOF

Pushed $TAG.

DROPLET (backend + worker; frontend untouched, no migration, no env keys):
  git fetch --tags && git checkout $TAG
  docker compose -f docker-compose.prod.yml build backend worker
  docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker

VERIFY (a green push is NOT a green deploy):
  [ ] 3 containers healthy, 0 restarts; clean boot (no MODULE_NOT_FOUND / TypeError)
  [ ] /health 200 (internal + public)
  [ ] smoke #06: on a CHECKED_OUT reservation, change the vehicle via the loaner
      swap / admin PATCH — old car flips AVAILABLE, new car ON_RENT immediately
      (no [vehicle-drift-sweep] repair WARN at the next hourly sweep)
  [ ] smoke #05/#08: PATCH a reservation onto a vehicle still out on an open
      rental -> 409 with message (not 500); same via precheckin staff-complete
  [ ] smoke #07: trigger an agreement email + an SMS — log lines show
      email/phone REDACTED in meta, no address/number in the message string

NEXT: ship TAG B (.deploy-notes/2026-07-17-ship-swap-vehicle-photos-betaNNN.sh)
— it gates on this tag's hunks being in HEAD.
EOF
