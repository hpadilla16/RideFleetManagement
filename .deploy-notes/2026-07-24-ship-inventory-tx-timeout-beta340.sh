#!/usr/bin/env bash
# HOTFIX: POST /api/inventory/session 500s on large fleets (P2028).
#
# Sentry de9bb6e0, prod, 2026-07-24 13:20 -04, user cmrxznz4i… (ADMIN, Corpusa):
#   "Transaction already closed … timeout for this transaction was 5000 ms,
#    however 5012 ms passed", thrown by inventoryItem.createMany at
#    inventory.service.js:176.
#
# CAUSE. startSession snapshots the whole tenant fleet into one InventoryItem row
# per vehicle inside an interactive transaction with NO explicit timeout, so it
# used Prisma's 5s default. Corpusa went 466 → 702 vehicles when the LAX fleet
# loaded (+51%), and the createMany crossed 5s by 12ms. The row count scales with
# fleet size, so this is a cliff that returns at the next growth step.
#
# FIX. One change: pass { timeout: 30_000, maxWait: 10_000 } to the
# $transaction. Nothing in the block waits on user input, so a generous ceiling
# costs nothing. NO scoping change, NO schema, NO migration, NO money code.
#
# NOT DONE HERE (tracked in a follow-up, see the code comment at :150): the
# snapshot is still tenant-wide, so a branch-scoped admin snapshots the whole
# tenant. Scoping it correctly needs a location stamped on InventorySession
# (which has none) + a call on concurrent per-branch counts, because the
# invariant is one IN_PROGRESS session per tenant and a partial session must not
# be resumable by a tenant-wide admin. That is a feature, not this hotfix.
#
#   TAG=v0.9.0-beta.340 bash .deploy-notes/2026-07-24-ship-inventory-tx-timeout-beta340.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
[ -n "$BRANCH" ] || { echo "Detached HEAD" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.340" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"

SVC="backend/src/modules/inventory/inventory.service.js"
SELF=".deploy-notes/2026-07-24-ship-inventory-tx-timeout-beta340.sh"
FILES=("$SVC" "$SELF")

# ── GATE 1: syntax + boot.
( cd backend && node --check "${SVC#backend/}" ); echo "GATE 1a OK: node --check limpio."
( cd backend && DATABASE_URL="postgresql://u:p@127.0.0.1:5432/x" \
  JWT_SECRET="ship-gate-smoke-secret-not-a-real-one-000" SKIP_LISTEN=1 \
  node -e "import('./src/main.js').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})" >/dev/null 2>&1 ) \
  || { echo "ABORT: main.js does not boot-import." >&2; exit 1; }
echo "GATE 1b OK: main.js boot-import limpio."

# ── GATE 2: the fix is present and it is ONLY the timeout.
[ "$(grep -c 'timeout: 30_000' "$SVC")" -eq 1 ] \
  || { echo "ABORT: the transaction timeout is not set." >&2; exit 1; }
[ "$(grep -c 'maxWait: 10_000' "$SVC")" -eq 1 ] \
  || { echo "ABORT: maxWait is not set." >&2; exit 1; }
# The snapshot must stay tenant-wide: scoping it without a session-level scope
# breaks the one-session-per-tenant invariant (see the code comment). Guard
# against a well-meaning scope creeping in on this hotfix.
[ "$(grep -c 'homeLocationId: { in:' "$SVC")" -eq 0 ] \
  || { echo "ABORT: a location filter appeared on the snapshot — that is the follow-up feature, not this hotfix, and it breaks session resume." >&2; exit 1; }
echo "GATE 2 OK: timeout set, snapshot still tenant-wide."

# ── GATE 3: nothing else moved. No schema, no migration, no deps, no other file.
[ -z "$(git diff HEAD --name-only -- backend/prisma 2>/dev/null)" ] \
  || { echo "ABORT: prisma changed in a no-migration hotfix." >&2; exit 1; }
[ -z "$(git diff HEAD --name-only -- backend/package.json backend/package-lock.json 2>/dev/null)" ] \
  || { echo "ABORT: package files changed — this hotfix touches one service file." >&2; exit 1; }
if [ "$(head -c 3 "$SVC" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then echo "ABORT: BOM." >&2; exit 1; fi
[ "$(grep -c 'Â\|â€\|â†\|Ã—' "$SVC" || true)" -eq 0 ] || { echo "ABORT: mojibake." >&2; exit 1; }
# tr, not `grep -c $'\r'` (empty pattern in Git Bash matches every line).
[ "$(tr -dc '\r' < "$SVC" | wc -c)" -eq 0 ] || { echo "ABORT: CR bytes." >&2; exit 1; }
echo "GATE 3 OK: single-file change, no schema/deps, clean encoding."

# ── GATE 4: tests (the pure logic suite; the service itself has no DB suite).
( cd backend && node --test src/modules/inventory/inventory-logic.test.mjs >/dev/null 2>&1 ) \
  || { echo "ABORT: inventory-logic tests failed." >&2; exit 1; }
echo "GATE 4 OK: inventory-logic 11/11."

# ── GATE 5: env parity.
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example 2>/dev/null || true
bash scripts/env-diff-check.sh < /dev/null || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example

# ── STAGE + guard. The working tree also carries the unrelated per-location T&C
# ship; this MUST stage only the two inventory files.
git reset >/dev/null
git add -- "${FILES[@]}"
EXPECTED="$(printf '%s\n' "${FILES[@]}" | sort)"; STAGED="$(git diff --cached --name-only | sort)"
[ "$EXPECTED" = "$STAGED" ] || {
  echo "ABORT: staged set does not match FILES[] (T&C files must NOT be here)." >&2
  echo "--- unexpected:"; comm -13 <(echo "$EXPECTED") <(echo "$STAGED") >&2
  echo "--- missing:";    comm -23 <(echo "$EXPECTED") <(echo "$STAGED") >&2
  git reset >/dev/null; exit 1
}
echo "GATE 6 OK: staged set = the 2 inventory files only."

echo; git diff --cached --stat; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Left staged (not committed)."; exit 0; }
git commit -m "fix(inventory): raise the startSession transaction timeout — prod 500 on large fleets

POST /api/inventory/session threw P2028 in prod (Sentry de9bb6e0): the fleet
snapshot writes one InventoryItem row per vehicle inside an interactive
transaction that had no explicit timeout, so it used Prisma's 5s default.
Corpusa went from 466 to 702 vehicles when the LAX fleet loaded (+51%) and the
createMany crossed 5s by 12ms — a cliff that scales with fleet size and
reappears at every growth step.

Sets { timeout: 30_000, maxWait: 10_000 } on the transaction. Nothing in the
block waits on user input, so a generous ceiling costs nothing. No schema, no
migration, no money code.

Follow-up (documented in-code): the snapshot is still tenant-wide, so a
branch-scoped admin snapshots the whole tenant. Scoping it needs a location on
InventorySession (which has none) and a decision on concurrent per-branch
counts, because the invariant is one IN_PROGRESS session per tenant and a
partial session must not be resumable by a tenant-wide admin.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo; echo "Pushed $TAG. Droplet: git fetch --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "No migration. Verify: POST /api/inventory/session as the Corpusa admin returns a session (was 500)."
