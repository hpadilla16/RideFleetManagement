#!/usr/bin/env bash
# HOTFIX (incident): beta.335 awaited the confirmation-email SMTP send inside
# reservationsService.create → quote-convert took ~4-5s → VozIA re-reserved →
# DUPLICATE reservations. Make the send fire-and-forget so create/convert respond
# <1s and the email goes out in the background. The confirmationEmailSentAt stamp
# still lives inside the unchanged maybeSendConfirmationEmailOnCreate and still
# prevents double-email. Backend-only, NO migration, no env keys, no charge code.
#
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-21-ship-confirmation-email-fireandforget-betaNNN.sh
#
# Next free: v0.9.0-beta.336.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
[ -n "$BRANCH" ] || { echo "Detached HEAD" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN (336 next)." >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"

MODULE="backend/src/modules/reservations/reservation-confirmation-email.js"
SVC="backend/src/modules/reservations/reservations.service.js"
FILES=(
  "$SVC"
  "$MODULE"
  "backend/src/modules/reservations/confirmation-email-on-create.test.mjs"
  ".deploy-notes/2026-07-21-ship-confirmation-email-fireandforget-betaNNN.sh"
)

# ── GATE 1: syntax
( cd backend && node --check "${SVC#backend/}" && node --check "${MODULE#backend/}" )
echo "GATE 1 OK: node --check limpio."

# ── GATE 2: create must NOT await the send, and the fire wrapper must be exported+imported
grep -q 'fireConfirmationEmailOnCreate' "$MODULE" || { echo "ABORT: fireConfirmationEmailOnCreate not defined in the module." >&2; exit 1; }
grep -q 'fireConfirmationEmailOnCreate' "$SVC"   || { echo "ABORT: create() does not use fireConfirmationEmailOnCreate." >&2; exit 1; }
# the hook line must not be `await`ed
if grep -nE 'await[[:space:]]+fireConfirmationEmailOnCreate|await[[:space:]]+maybeSendConfirmationEmailOnCreate' "$SVC" >/dev/null; then
  echo "ABORT: the confirmation send is still AWAITED in create() — the whole fix is that it must NOT be." >&2; exit 1
fi
echo "GATE 2 OK: fire-and-forget wired, send is not awaited in create()."

# ── GATE 3: schema/package unchanged (no migration this hotfix)
[ -z "$(git diff HEAD --name-only -- backend/prisma/schema.prisma backend/package.json backend/prisma/migrations 2>/dev/null)" ] \
  || { echo "ABORT: unexpected schema/package/migration change in a no-migration hotfix." >&2; exit 1; }
echo "GATE 3 OK: no schema/package/migration change."

# ── GATE 4: tests (dev DB 5432; NOT dead 5433)
if command -v nc >/dev/null 2>&1 && nc -z localhost 5432 >/dev/null 2>&1; then
  for T in test:reservations test:quotes test:booking-engine; do
    ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run "$T" ) \
      || { echo "ABORT: $T failed." >&2; exit 1; }
  done
  echo "GATE 4 OK: test:reservations + test:quotes + test:booking-engine green."
else
  echo "GATE 4 SKIP: no postgres on localhost:5432 — tests did NOT run."
fi

# ── GATE 5: env parity (no new keys)
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example 2>/dev/null || true
bash scripts/env-diff-check.sh < /dev/null || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example

# ── STAGE + guard
git reset >/dev/null
git add -- "${FILES[@]}"
LEAK="$(git diff --cached --name-only | grep -vE '^(backend/src/modules/reservations/reservations\.service\.js|backend/src/modules/reservations/reservation-confirmation-email\.js|backend/src/modules/reservations/confirmation-email-on-create\.test\.mjs|\.deploy-notes/2026-07-21-ship-confirmation-email-fireandforget-betaNNN\.sh)$' || true)"
[ -z "$LEAK" ] || { echo "ABORT: unexpected files staged:"; printf '%s\n' "$LEAK"; git reset >/dev/null; exit 1; }
echo "GATE 6 OK: staged set = the 3 files + this script."

echo; git diff --cached --stat; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Left staged (not committed)."; exit 0; }
git commit -m "fix(reservations): fire-and-forget confirmation email — unblock quote-convert (incident)

beta.335 awaited the confirmation-email SMTP send inside create(), so
VozIA's quote-convert took ~4-5s and VozIA re-reserved → duplicate
reservations in prod. create() now fires the send and returns
immediately (best-effort .catch on the floating promise). The
confirmationEmailSentAt stamp still lives inside the unchanged
maybeSendConfirmationEmailOnCreate and still prevents double-email; it
just lands asynchronously now. Backend-only, no migration. QA SHIP.
Follow-up: the public-booking create path awaits the same builder
(latency, not duplicates — it doesn't auto-retry).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo; echo "Pushed $TAG. Droplet: git fetch --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "No migration. Verify: 3 containers healthy + clean boot + /api/health 200 + a quote-convert responds fast (<1s)."
