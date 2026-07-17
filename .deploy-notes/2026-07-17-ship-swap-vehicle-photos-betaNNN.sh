#!/usr/bin/env bash
# Mandatory swap photos (16) + ADMIN override + loaner swap UI — TAG B (QA SHIP).
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-17-ship-swap-vehicle-photos-betaNNN.sh
#
# WHAT: swapVehicle now HARD-REQUIRES the app's standard 8-photo set for BOTH
# cars (16 total), enforced in the SERVICE (nobody swaps over the API without
# evidence). Photos upload to Supabase Storage; swap rows persist REFS only
# (never base64 — beta.310 lesson) and the inspection report signs them back.
# The ONLY escape is an ADMIN override (canDoAdminCorrections gate, computed by
# the ROUTE from the authenticated user, never from the payload) with a
# mandatory reason + its own ADMIN_OVERRIDE AuditLog row in the SAME
# transaction. Dealership-loaner swap gets the same gate + a real swap modal
# (LoanerVehicleSwapModal / SwapInspectionCard / SwapPhotoOverridePanel);
# swap wizard rebuilt around the 16-photo capture; en/es i18n (pure insertions).
#
# ⚠️ SHIP ORDER — RUNS AFTER TAG A IS COMMITTED:
# (.deploy-notes/2026-07-17-ship-agent-patches-sweep-betaNNN.sh). Tag A carved
# its hunks (#06 vehicleChanged sync, sendExplicitStatusError, PII log hunk)
# out of the SAME three shared files. Once A is in HEAD, the remaining
# working-tree diff on those files is pure B — GATED below, not assumed. If A
# has not landed, this script ABORTS at GATE 0.
#
# WHY the working files are now safe to stage whole: reservations.service.js's
# working copy imports ./swap-photos.js — tag B SHIPS swap-photos.js, so the
# chain closes (proven by import-resolve over the materialized staged tree).
#
# package.json: HEAD(+A) copy + the test:reservations line gaining B's three
# new test files (swap-photos / swap-vehicle-photos / swap-photo-override;
# swap-vehicle-status-sync is already in the line), KEEPING --test-force-exit,
# still excluding test:advantage / test:customers-phone / kiosk / flexways-worker
# (their files are untracked foreign workstreams).
#
# DEPLOY (BACKEND + WORKER + FRONTEND, NO migration, NO new env keys):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG:-SET-NEXT-BETA-TAG}"
SELF=".deploy-notes/2026-07-17-ship-swap-vehicle-photos-betaNNN.sh"

[ -n "$BRANCH" ] || { echo "ABORT: detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "ABORT: must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
# TAG sentinel: 302 and 312-316 are kiosk's; 317 was the last shipped; tag A
# takes the next free one — this tag is the one AFTER tag A's.
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "ABORT: set TAG=v0.9.0-beta.NNN (the beta right after tag A's; 302/312-316 kiosk-taken, 317 shipped)." >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: tag $TAG already exists." >&2; exit 1; }
echo "Shipping TAG B ($TAG) from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

# ── GATE 0: TAG A MUST BE IN HEAD (ship order) ───────────────────────────────
# NOTE: grep -c (not -q) — with pipefail, grep -q exiting on first match SIGPIPEs
# git show and fails the pipeline even when the marker IS present.
git show HEAD:backend/src/modules/reservations/reservations.service.js | grep -c "const vehicleChanged" >/dev/null \
  || { echo "ABORT: HEAD is missing tag A's #06 hunk (vehicleChanged sync) in reservations.service.js." >&2;
       echo "SHIP TAG A FIRST: TAG=<beta> bash .deploy-notes/2026-07-17-ship-agent-patches-sweep-betaNNN.sh" >&2; exit 1; }
git show HEAD:backend/src/modules/reservations/reservations.routes.js | grep -c "function sendExplicitStatusError" >/dev/null \
  || { echo "ABORT: HEAD is missing tag A's sendExplicitStatusError in reservations.routes.js — ship tag A first." >&2; exit 1; }
git show HEAD:backend/src/modules/rental-agreements/rental-agreements.service.js | grep -cF "log?.info?.('[email-agreement] sent'" >/dev/null \
  || { echo "ABORT: HEAD is missing tag A's PII hunk in rental-agreements.service.js — ship tag A first." >&2; exit 1; }
git show HEAD:backend/package.json | grep '"test:reservations"' | grep -c -- '--test-force-exit' >/dev/null \
  || { echo "ABORT: HEAD test:reservations lacks --test-force-exit — ship tag A first." >&2; exit 1; }
echo "GATE 0 OK: tag A's hunks are in HEAD."

# ── GATE 0b: remaining diff on the three shared files is PURE B — verify ─────
# (a) tag A's hunks must NOT reappear in the remaining diff (they're in HEAD);
# (b) no third workstream's content may ride; (c) the expected B markers exist.
for F in backend/src/modules/reservations/reservations.service.js \
         backend/src/modules/reservations/reservations.routes.js \
         backend/src/modules/rental-agreements/rental-agreements.service.js; do
  CH="$(git diff HEAD -- "$F" | grep -E '^[+-][^+-]' || true)"
  printf '%s\n' "$CH" | grep -qE '^\+.*const vehicleChanged|^\+.*function sendExplicitStatusError' \
    && { echo "ABORT: $F still re-adds tag A hunks — HEAD/working-tree state is inconsistent, inspect by hand." >&2; exit 1; }
  FOREIGN="$(printf '%s\n' "$CH" | grep -iE 'advantage|kiosk|phoneNormalized|PendingFranchiseImports|flexways|\.fuse_hidden' || true)"
  [ -z "$FOREIGN" ] || { echo "ABORT: foreign-workstream content in the remaining diff of $F:"; printf '%s\n' "$FOREIGN" | head; exit 1; }
done
git diff HEAD -- backend/src/modules/reservations/reservations.service.js | grep -c "from './swap-photos.js'" >/dev/null \
  || { echo "ABORT: reservations.service.js remaining diff lacks the swap-photos import — not the expected B state." >&2; exit 1; }
git diff HEAD -- backend/src/modules/reservations/reservations.routes.js | grep -c "isAdminRole" >/dev/null \
  || { echo "ABORT: reservations.routes.js remaining diff lacks isAdminRole — not the expected B state." >&2; exit 1; }
git diff HEAD -- backend/src/modules/rental-agreements/rental-agreements.service.js | grep -c "photoStorageRefs" >/dev/null \
  || { echo "ABORT: rental-agreements.service.js remaining diff lacks photoStorageRefs — not the expected B state." >&2; exit 1; }
echo "GATE 0b OK: remaining shared-file diff is pure B (verified, not assumed)."

# ── SCRATCH + TRAP: restore every temporarily rewritten working file on EXIT ─
SCRATCH="$(mktemp -d)"
save_working() {
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

# ── FILES[]: the EXPLICIT list (never `git add -A`) ──────────────────────────
# frontend/src/lib/swap-photos.js(+test) were NOT on QA's original list but the
# swap wizard, SwapInspectionCard and LoanerVehicleSwapModal all import
# '../../lib/swap-photos' — without them the frontend build of the TAG breaks
# (verify-don't-assume: existence is re-gated on the staged tree below).
FILES=(
  # backend — the three shared files (now pure-B on top of HEAD+A)
  "backend/src/modules/reservations/reservations.service.js"
  "backend/src/modules/reservations/reservations.routes.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  # backend — new module + tests
  "backend/src/modules/reservations/swap-photos.js"
  "backend/src/modules/reservations/swap-photos.test.mjs"
  "backend/src/modules/reservations/swap-vehicle-photos.test.mjs"
  "backend/src/modules/reservations/swap-photo-override.test.mjs"
  "backend/src/modules/reservations/swap-vehicle-status-sync.test.mjs"
  # backend — loaner swap path
  "backend/src/modules/dealership-loaner/dealership-loaner.service.js"
  "backend/src/modules/dealership-loaner/dealership-loaner.routes.js"
  # frontend
  "frontend/src/lib/swap-photos.js"
  "frontend/src/lib/swap-photos.test.mjs"
  "frontend/src/components/reservations/LoanerVehicleSwapModal.jsx"
  "frontend/src/components/reservations/SwapInspectionCard.jsx"
  "frontend/src/components/reservations/SwapPhotoOverridePanel.jsx"
  "frontend/src/app/reservations/[id]/swap/page.js"
  "frontend/src/app/reservations/[id]/page.js"
  "frontend/src/app/globals.css"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  "frontend/package.json"
  "$SELF"
)
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "ABORT: FILES[] member missing from working tree: $f" >&2; exit 1; }
done

# ── GATE 1: node --check on every backend .js that ships ─────────────────────
for f in backend/src/modules/reservations/reservations.service.js \
         backend/src/modules/reservations/reservations.routes.js \
         backend/src/modules/rental-agreements/rental-agreements.service.js \
         backend/src/modules/reservations/swap-photos.js \
         backend/src/modules/dealership-loaner/dealership-loaner.service.js \
         backend/src/modules/dealership-loaner/dealership-loaner.routes.js; do
  node --check "$f" || { echo "ABORT: node --check failed: $f" >&2; exit 1; }
done
echo "GATE 1 OK: node --check clean on the 6 backend files."

# ── GATE 2: wiring — anchored on CALL SITES, never on definitions ────────────
grep -q "prepareSwapPhotos({" backend/src/modules/reservations/reservations.service.js \
  || { echo "ABORT: swapVehicle does not CALL prepareSwapPhotos (photo gate absent)." >&2; exit 1; }
grep -q "resolveSwapPhotoOverride({" backend/src/modules/reservations/reservations.service.js \
  || { echo "ABORT: swapVehicle does not CALL resolveSwapPhotoOverride." >&2; exit 1; }
grep -q "buildSwapPhotoOverrideAudit({" backend/src/modules/reservations/reservations.service.js \
  || { echo "ABORT: swapVehicle does not WRITE the ADMIN_OVERRIDE audit row (call site absent)." >&2; exit 1; }
grep -q "isAdmin: canDoAdminCorrections(req)" backend/src/modules/reservations/reservations.routes.js \
  || { echo "ABORT: swap-vehicle route does not PASS isAdmin from the authenticated user." >&2; exit 1; }
grep -q "normalizeVehicleSwapRowAsync" backend/src/modules/rental-agreements/rental-agreements.service.js \
  || { echo "ABORT: inspection report does not resolve swap photo refs (normalizeVehicleSwapRowAsync absent)." >&2; exit 1; }
grep -q "from '../reservations/swap-photos.js'" backend/src/modules/dealership-loaner/dealership-loaner.service.js \
  || { echo "ABORT: dealership-loaner does not import the shared swap-photos gate." >&2; exit 1; }
echo "GATE 2 OK: photo gate + override + audit + loaner wiring anchored on call sites."

# ── STEP: SURGICAL backend/package.json (HEAD+A copy + B's three test files) ─
save_working "backend/package.json"
git show HEAD:backend/package.json > "$SCRATCH/pkg-head.json"
HEAD_LINE="$(grep '"test:reservations"' "$SCRATCH/pkg-head.json")"
[ -n "$HEAD_LINE" ] || { echo "ABORT: no test:reservations line in HEAD package.json." >&2; exit 1; }
grep -q -- '--test-force-exit' <<<"$HEAD_LINE" || { echo "ABORT: HEAD test:reservations lacks --test-force-exit — ship tag A first." >&2; exit 1; }
grep -q 'open-rental-409.test.mjs"' <<<"$HEAD_LINE" || { echo "ABORT: HEAD test:reservations lacks the tag-A tail anchor (open-rental-409.test.mjs)." >&2; exit 1; }
grep -qE 'swap-photos' <<<"$HEAD_LINE" && { echo "ABORT: HEAD test:reservations already has swap-photos tests — tag B appears already shipped." >&2; exit 1; }
NEW_LINE="$(printf '%s' "$HEAD_LINE" \
  | sed 's|open-rental-409.test.mjs"|open-rental-409.test.mjs src/modules/reservations/swap-photos.test.mjs src/modules/reservations/swap-vehicle-photos.test.mjs src/modules/reservations/swap-photo-override.test.mjs"|')"
awk -v repl="$NEW_LINE" '{ if ($0 ~ /"test:reservations"/) print repl; else print }' "$SCRATCH/pkg-head.json" > "$SCRATCH/pkg-B.json"
node -e "JSON.parse(require('fs').readFileSync('$SCRATCH/pkg-B.json','utf8'))" \
  || { echo "ABORT: re-cut package.json is not valid JSON." >&2; exit 1; }
git reset >/dev/null
cp "$SCRATCH/pkg-B.json" backend/package.json
git add -- backend/package.json
cp "$SCRATCH/wt/backend/package.json" backend/package.json
echo "package.json staged = HEAD(+A) + B's three test files on test:reservations (working copy restored)."

# ── STAGE FILES[] ────────────────────────────────────────────────────────────
git add -- "${FILES[@]}"

# ── GATE 3: staged backend package.json = ONE line pair, the right one ───────
PKG_CHANGED="$(git diff --cached backend/package.json | grep -E '^[+-][^+-]' || true)"
PKG_COUNT="$(printf '%s\n' "$PKG_CHANGED" | grep -c . || true)"
[ "$PKG_COUNT" = "2" ] || { echo "ABORT: backend/package.json staged with $PKG_COUNT changed lines, expected 2:"; echo "$PKG_CHANGED"; git reset >/dev/null; exit 1; }
printf '%s\n' "$PKG_CHANGED" | grep -v 'test:reservations' | grep -q . && { echo "ABORT: backend/package.json staged beyond test:reservations:"; echo "$PKG_CHANGED"; git reset >/dev/null; exit 1; }
PKG_PLUS="$(printf '%s\n' "$PKG_CHANGED" | grep '^+')"
grep -q -- '--test-force-exit' <<<"$PKG_PLUS" || { echo "ABORT: staged test:reservations line LOST --test-force-exit." >&2; git reset >/dev/null; exit 1; }
for t in swap-photos.test.mjs swap-vehicle-photos.test.mjs swap-photo-override.test.mjs; do
  grep -q "src/modules/reservations/$t" <<<"$PKG_PLUS" || { echo "ABORT: staged line missing $t." >&2; git reset >/dev/null; exit 1; }
done
grep -qE 'advantage|customers-phone|kiosk-name-update|flexways-worker' <<<"$PKG_CHANGED" \
  && { echo "ABORT: foreign-workstream test entries leaked into staged package.json." >&2; git reset >/dev/null; exit 1; }
echo "GATE 3 OK: backend/package.json staged = the test:reservations line only (+3 B tests, force-exit kept)."

# ── GATE 4: frontend/package.json staged = the swap-photos test wiring only ──
FPKG_CHANGED="$(git diff --cached frontend/package.json | grep -E '^[+-][^+-]' || true)"
FPKG_COUNT="$(printf '%s\n' "$FPKG_CHANGED" | grep -c . || true)"
[ "$FPKG_COUNT" = "3" ] || { echo "ABORT: frontend/package.json staged with $FPKG_COUNT changed lines, expected 3 (-test, +test, +test:swap-photos):"; echo "$FPKG_CHANGED"; git reset >/dev/null; exit 1; }
BAD_FPKG="$(printf '%s\n' "$FPKG_CHANGED" | grep -vE 'swap-photos|"test":' || true)"
[ -z "$BAD_FPKG" ] || { echo "ABORT: unexpected frontend/package.json staged lines:"; echo "$BAD_FPKG"; git reset >/dev/null; exit 1; }
echo "GATE 4 OK: frontend/package.json staged = test aggregate + test:swap-photos only."

# ── GATE 5: locales are PURE INSERTIONS (no other workstream's keys ride) ────
for L in frontend/src/locales/en.json frontend/src/locales/es.json; do
  DEL="$(git diff --cached "$L" | grep -cE '^-[^-]' || true)"
  [ "$DEL" = "0" ] || { echo "ABORT: $L staged diff DELETES $DEL lines — must be pure insertions."; git reset >/dev/null; exit 1; }
  FOREIGN="$(git diff --cached "$L" | grep -E '^\+[^+]' | grep -iE 'advantage|kiosk|flexways|franchise|phoneNormalized' || true)"
  [ -z "$FOREIGN" ] || { echo "ABORT: foreign-workstream keys in $L:"; printf '%s\n' "$FOREIGN" | head; git reset >/dev/null; exit 1; }
done
echo "GATE 5 OK: en/es locale diffs are pure B insertions."

# ── GATE 6: CONTAMINATION — staged names + content ───────────────────────────
STAGED_NAMES="$(git diff --cached --name-only)"
LEAK="$(printf '%s\n' "$STAGED_NAMES" | grep -E \
  'advantage|kiosk|schema\.prisma|migrations/|PendingFranchiseImportsTray|settings/page\.js|^frontend/src/app/reservations/page\.js$|^backend/src/lib/prisma\.js$|customers\.service\.js|\.env\.example|\.fuse_hidden' || true)"
[ -z "$LEAK" ] || { echo "ABORT: foreign workstream files staged:"; printf '%s\n' "$LEAK"; git reset >/dev/null; exit 1; }
# Content sweep (SELF excluded — this script names the markers in its gates).
# NOTE 'override'/'planner' are NOT markers here: B's own code legitimately says
# photoOverride and cites planner-force semantics in a comment.
CONTENT_LEAK="$(git diff --cached -- backend/ frontend/ | grep -E '^[+-][^+-]' | grep -iE \
  'advantage|kiosk|phoneNormalized|PendingFranchiseImports|\.fuse_hidden' || true)"
[ -z "$CONTENT_LEAK" ] || { echo "ABORT: foreign workstream CONTENT in the staged diff:"; printf '%s\n' "$CONTENT_LEAK" | head -20; git reset >/dev/null; exit 1; }
echo "GATE 6 OK: staged diff carries no advantage/kiosk/phoneNormalized/schema/migrations/tray/FUSE."

# ── GATE 7: IMPORT-RESOLVE over the STAGED TREE (the boot gate) ──────────────
STAGED_TREE="$SCRATCH/staged-tree"; mkdir -p "$STAGED_TREE"
git checkout-index -a --prefix="$STAGED_TREE/"
[ -f "$STAGED_TREE/backend/src/modules/reservations/swap-photos.js" ] \
  || { echo "ABORT: swap-photos.js missing from the staged tree — the backend would not boot." >&2; git reset >/dev/null; exit 1; }
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
  console.error('The backend would NOT BOOT. Fix FILES[].');
  process.exit(1);
}
console.log(`CHAIN RESOLVES OK — ${count} modules reachable from ${roots.length} entrypoints.`);
RESOLVER_EOF
node "$SCRATCH/resolve-chain.mjs" "$STAGED_TREE/backend/src/main.js" "$STAGED_TREE/backend/src/worker.js" \
  || { echo "ABORT: staged-tree import chain broken (repo's #1 boot-crash cause)." >&2; git reset >/dev/null; exit 1; }
# Frontend side of the same idea: every NEW import target must be IN the tag.
for f in "frontend/src/lib/swap-photos.js" \
         "frontend/src/components/reservations/SwapInspectionCard.jsx" \
         "frontend/src/components/reservations/SwapPhotoOverridePanel.jsx" \
         "frontend/src/components/reservations/LoanerVehicleSwapModal.jsx"; do
  [ -f "$STAGED_TREE/$f" ] || { echo "ABORT: $f missing from the staged tree — frontend build of the tag would break." >&2; git reset >/dev/null; exit 1; }
done
echo "GATE 7 OK: backend chain resolves WITH swap-photos.js; all new frontend imports exist in the tag."

# ── GATE 8: BACKEND TESTS ────────────────────────────────────────────────────
# swap-photos unit suite (15) is DB-free — always runs.
( cd backend && node --test --test-force-exit src/modules/reservations/swap-photos.test.mjs ) \
  || { echo "ABORT: swap-photos unit tests failed." >&2; git reset >/dev/null; exit 1; }
echo "GATE 8a OK: swap-photos unit suite green."
# DB-backed suites (override 14 · vehicle-photos + status-sync 13) vs the REAL
# dev DB. GOTCHA: backend/.env points at dead localhost:5433 — dev DB is
# localhost:5432/fleet_management.
if nc -z localhost 5432 >/dev/null 2>&1; then
  for T in src/modules/reservations/swap-photo-override.test.mjs \
           src/modules/reservations/swap-vehicle-photos.test.mjs \
           src/modules/reservations/swap-vehicle-status-sync.test.mjs; do
    ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" \
        node --test --test-force-exit "$T" ) \
      || { echo "ABORT: $T failed against localhost:5432." >&2; git reset >/dev/null; exit 1; }
  done
  echo "GATE 8b OK: swap-photo-override + swap-vehicle-photos + swap-vehicle-status-sync green vs 5432."
else
  echo "############################################################"
  echo "GATE 8b SKIP: no postgres on localhost:5432 — the DB-backed"
  echo "swap suites did NOT run. Bring up the dev DB and re-run for"
  echo "the full proof (QA's numbers: 14 + 13)."
  echo "############################################################"
fi

# ── GATE 9: FRONTEND TESTS + BUILD ───────────────────────────────────────────
( cd frontend && npm run test:swap-photos ) \
  || { echo "ABORT: frontend test:swap-photos failed." >&2; git reset >/dev/null; exit 1; }
( cd frontend && npx next build ) \
  || { echo "ABORT: next build failed." >&2; git reset >/dev/null; exit 1; }
echo "GATE 9 OK: frontend swap-photos suite (18) + next build clean."

# ── GATE 10: ENV PARITY via HEAD's .env.example ──────────────────────────────
# This tag ships NO env keys; the working .env.example still carries the
# unshipped ADVANTAGE_* keys — check against HEAD's copy (the tag's actual
# copy) and restore. `< /dev/null`: env-diff's ssh eats stdin.
save_working "backend/.env.example"
git checkout HEAD -- backend/.env.example
if ! bash scripts/env-diff-check.sh < /dev/null; then
  cp "$SCRATCH/wt/backend/.env.example" backend/.env.example
  echo "ABORT: env-diff-check failed against HEAD's .env.example — resolve before deploy." >&2
  git reset >/dev/null; exit 1
fi
cp "$SCRATCH/wt/backend/.env.example" backend/.env.example
echo "GATE 10 OK: env parity (checked against HEAD's .env.example — the tag's actual copy)."

# ── REVIEW + CONFIRM ─────────────────────────────────────────────────────────
echo; git diff --cached --stat; echo
echo "############ ⚠ QA: EYEBALL THESE TWO BEFORE CONFIRMING ############"
echo "── staged diff: frontend/src/app/reservations/[id]/page.js (swap modal wiring ONLY):"
git diff --cached -- "frontend/src/app/reservations/[id]/page.js" | sed 's/^/    /'
echo
echo "── staged diff: frontend/src/app/globals.css (swap classes ONLY — no kiosk/planner css):"
git diff --cached -- frontend/src/app/globals.css | sed 's/^/    /'
echo "###################################################################"
echo
echo "Also worth a look: git diff --cached -- backend/src/modules/reservations/reservations.service.js"
echo
# read < /dev/tty — never inherit stdin (env-diff/ssh eats it; scripts have hung on this).
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git reset"; exit 0; }

git commit -m "feat(reservations): mandatory 16-photo swap evidence + ADMIN override + loaner swap UI

swapVehicle now hard-requires the standard 8-photo set for BOTH cars (16
total), enforced in the service — nobody swaps a car over the API without
the evidence. Photos upload to Supabase Storage; the swap row and AuditLog
persist slim REFS only (never base64 — beta.310 lesson) and the inspection
report signs them back for viewing. The only escape is an ADMIN override
(canDoAdminCorrections, computed by the route from the authenticated user,
never from the payload) with a mandatory reason, written as its own
ADMIN_OVERRIDE AuditLog row in the same transaction as the swap it
authorized. Override bypasses the PHOTO requirement and nothing else
(planner-force semantics: bypass rules, never occupancy).

Dealership-loaner swap goes through the same shared gate (swap-photos.js:
prepareSwapPhotos / resolveSwapPhotoOverride / isAdminRole — one definition
of admin for corrections, swap override and loaner swap). Frontend: swap
wizard rebuilt around the 16-photo capture (compressed client-side), new
LoanerVehicleSwapModal / SwapInspectionCard / SwapPhotoOverridePanel,
en/es i18n (pure insertions).

Ships on top of the agent-patches sweep tag (gated: its hunks must already
be in HEAD). test:reservations gains the three swap suites (force-exit
kept); frontend gains test:swap-photos. No migration, no new env keys.
Backend suites 15+14+13, frontend 18, next build clean."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"

cat <<EOF

Pushed $TAG.

████████████████████████████████████████████████████████████████████████
██  DEPLOY GATE (HARD): Hector's DEVICE SMOKE of the 16-photo capture ██
██  on a REAL IPAD comes BEFORE this goes live for the floor. The     ██
██  photo gate hard-blocks every swap — if capture fails on the       ██
██  device, every non-admin swap is blocked and the ADMIN override    ██
██  (reason + audit row) is the ONLY escape. Do not deploy on a       ██
██  desktop-browser smoke alone.                                      ██
████████████████████████████████████████████████████████████████████████

DROPLET (backend + worker + frontend, no migration, no env keys):
  git fetch --tags && git checkout $TAG
  docker compose -f docker-compose.prod.yml build backend worker frontend
  docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend

VERIFY (a green push is NOT a green deploy):
  [ ] 3 containers healthy, 0 restarts; clean boot (no MODULE_NOT_FOUND/TypeError
      — main.js -> reservations.service -> swap-photos.js must resolve)
  [ ] /health 200 (internal + public); frontend hard-refresh
  [ ] PROD SMOKES — each path needs ONE real pass:
      [ ] swap on a CHECKED_OUT reservation with 16 photos: succeeds; the
          swapped-out car flips AVAILABLE and the replacement ON_RENT
          immediately; inspection report shows both photo sets (signed URLs)
      [ ] dealership-LOANER swap through the new modal: same gate, same flip
      [ ] ADMIN override: swap with missing photos as ADMIN + reason ->
          succeeds + ADMIN_OVERRIDE AuditLog row with the reason; as
          NON-admin -> 403; empty reason -> 400
EOF
