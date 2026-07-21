#!/usr/bin/env bash
# Revive the dead sendConfirmationEmail flag: reservationsService.create now sends
# an immediate confirmation email (best-effort, on-file-email-only, idempotent via
# a new Reservation.confirmationEmailSentAt stamp). Fixes VozIA quote-convert (the
# only path that reaches the default true — every frontend form + integration sets
# false). The public-booking confirmation builder was EXTRACTED to a shared module
# (reservation-confirmation-email.js) and re-imported by booking-engine — byte-
# identical output (verified). Innovation OK + QA SHIP.
#
#   TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-21-ship-confirmation-email-on-create-betaNNN.sh
#
# Next free: v0.9.0-beta.335. HAS A MIGRATION (additive). Backend-only.
#
# WORKING-TREE CAUTION: many unrelated uncommitted workstreams. Stage ONLY the
# FILES[] below — never `git add -A`. schema.prisma + package.json diffs are the
# single confirmation-email hunk/line (QA-verified); staging whole is safe, guarded.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
[ -n "$BRANCH" ] || { echo "Detached HEAD" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN (335 next)." >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"

MODULE="backend/src/modules/reservations/reservation-confirmation-email.js"
MIG="backend/prisma/migrations/20260721_reservation_confirmation_email_sent_at/migration.sql"
FILES=(
  "$MODULE"
  "backend/src/modules/reservations/reservations.service.js"
  "backend/src/modules/booking-engine/booking-engine.service.js"
  "backend/src/modules/reservations/confirmation-email-on-create.test.mjs"
  "backend/src/modules/quotes/quotes.service.test.mjs"
  "backend/prisma/schema.prisma"
  "$MIG"
  "backend/package.json"
  ".deploy-notes/2026-07-21-ship-confirmation-email-on-create-betaNNN.sh"
)

# ── GATE 1: syntax on changed backend .js
for f in "$MODULE" backend/src/modules/reservations/reservations.service.js \
         backend/src/modules/booking-engine/booking-engine.service.js; do
  ( cd backend && node --check "${f#backend/}" )
done
echo "GATE 1 OK: node --check limpio."

# ── GATE 2: the NEW shared module exists + is imported (boot-safety — cause #1)
[ -f "$MODULE" ] || { echo "ABORT: new module $MODULE missing." >&2; exit 1; }
grep -q "reservation-confirmation-email" backend/src/modules/reservations/reservations.service.js \
  && grep -q "reservation-confirmation-email" backend/src/modules/booking-engine/booking-engine.service.js \
  || { echo "ABORT: the new module is not imported by both consumers — check the extraction." >&2; exit 1; }
echo "GATE 2 OK: shared module present + imported by reservations.service + booking-engine."

# ── GATE 3: schema.prisma diff = ONLY confirmationEmailSentAt
SCHEMA_ADDS="$(git diff HEAD -- backend/prisma/schema.prisma | grep -E '^\+[^+]' || true)"
# allow the field line + its doc-comment lines (start with //); anything else = foreign.
SCHEMA_BAD="$(printf '%s\n' "$SCHEMA_ADDS" | grep -viE 'confirmationEmailSentAt' | grep -vE '^\+\s*//' | grep -E '\S' || true)"
[ -z "$SCHEMA_BAD" ] || { echo "ABORT: schema.prisma has adds beyond confirmationEmailSentAt (foreign workstream?):"; printf '%s\n' "$SCHEMA_BAD"; exit 1; }
echo "GATE 3 OK: schema.prisma = confirmationEmailSentAt only."

# ── GATE 4: package.json diff = ONLY the test:reservations line
PKG_BAD="$(git diff HEAD -- backend/package.json | grep -E '^[+-][^+-]' | grep -v 'test:reservations' | grep -E '\S' || true)"
[ -z "$PKG_BAD" ] || { echo "ABORT: package.json changed beyond test:reservations:"; printf '%s\n' "$PKG_BAD"; exit 1; }
echo "GATE 4 OK: package.json = test:reservations line only."

# ── GATE 5: tests (dev DB localhost:5432/fleet_management; NOT dead 5433)
if command -v nc >/dev/null 2>&1 && nc -z localhost 5432 >/dev/null 2>&1; then
  for T in test:reservations test:quotes test:booking-engine; do
    ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run "$T" ) \
      || { echo "ABORT: $T failed." >&2; exit 1; }
  done
  echo "GATE 5 OK: test:reservations + test:quotes + test:booking-engine green."
else
  echo "GATE 5 SKIP: no postgres on localhost:5432 — tests did NOT run. Bring up the dev DB and re-run."
fi

# ── GATE 6: env parity (no new keys; against HEAD's .env.example)
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example 2>/dev/null || true
bash scripts/env-diff-check.sh < /dev/null || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example

# ── STAGE (explicit) + contamination guard
git reset >/dev/null
git add -- "${FILES[@]}"
# exactly-one migration; the confirmation-email one
MIGS="$(git diff --cached --name-only | grep 'prisma/migrations/' || true)"
[ "$MIGS" = "$MIG" ] || { echo "ABORT: unexpected staged migration set:"; printf '%s\n' "$MIGS"; git reset >/dev/null; exit 1; }
# no token contamination outside this feature (exclude the ship script itself)
TOKBAD="$(git diff --cached -- ':!.deploy-notes/*' | grep -E '^\+[^+]' | grep -iE 'phoneNormaliz|\bkiosk\b|advantage' || true)"
[ -z "$TOKBAD" ] || { echo "ABORT: foreign-workstream tokens staged:"; printf '%s\n' "$TOKBAD" | head; git reset >/dev/null; exit 1; }
echo "GATE 7 OK: staged set clean (1 migration, no foreign tokens)."

echo; git diff --cached --stat; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Left staged (not committed)."; exit 0; }
git commit -m "feat(reservations): send confirmation email on create (revive sendConfirmationEmail)

reservationsService.create now consumes the previously-dead
sendConfirmationEmail flag and sends an immediate confirmation email
(reservation #, dates, locations, vehicle, total). Best-effort (outside
the tx — a mail failure never rolls back create), idempotent via a new
Reservation.confirmationEmailSentAt stamp, and ONLY to the on-file
customer email (VozIA can't change email). In practice only VozIA
quote-convert newly emails — every frontend form + integration sets the
flag false, so no double-email and no surprise staff emails. The public-
booking confirmation builder was extracted to a shared module
(reservation-confirmation-email.js) and re-imported by booking-engine,
byte-identical output. Additive migration (confirmationEmailSentAt).
Innovation OK + QA SHIP.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo; echo "Pushed $TAG."
echo "DROPLET: git fetch --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "MIGRATION (session port 5432, NOT pgbouncer):"
echo "  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed -e \"s/:6543/:5432/\" -e \"s/[?&]pgbouncer=true//\"); npx prisma migrate deploy'"
echo "VERIFY: 3 containers healthy + clean boot (reservation-confirmation-email.js resolves) + /api/health 200 + confirmationEmailSentAt column exists."
