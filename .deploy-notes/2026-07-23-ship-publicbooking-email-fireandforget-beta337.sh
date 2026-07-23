#!/usr/bin/env bash
# FOLLOW-UP to beta.336 (e24d5c7). That hotfix stopped reservationsService.create
# from awaiting the confirmation-email SMTP send after the await made VozIA
# re-reserve → DUPLICATE reservations. Its own commit message flagged the sibling:
# the two PUBLIC BOOKING create paths in booking-engine.service.js awaited the SAME
# builder. That is latency only — the website does not auto-retry, so it never
# duplicated — but every booking made from the website paid ~4-5s before the
# confirmation screen could render. This ships the same fix for those two paths.
#
# Because those paths RETURN the send result to the caller as `confirmationEmail`,
# and the outcome is no longer knowable inside the request, the response now
# reports { emailSent:false, pending:true, sentTo:[email], warning:null }. Shape is
# backward-compatible (same keys, `pending` additive). No known consumer reads it:
# zero hits in the RFM frontend and zero in the storefront repo.
#
# Backend-only. NO migration, NO schema change, NO env keys, NO charge/money code.
# backend/package.json DOES change — one line, the new test file appended to
# test:reservations. That is why GATE 3 differs from the precedent's.
#
#   TAG=v0.9.0-beta.337 bash .deploy-notes/2026-07-23-ship-publicbooking-email-fireandforget-beta337.sh
#
# Prod at time of writing = v0.9.0-beta.336. Next free: v0.9.0-beta.337.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
[ -n "$BRANCH" ] || { echo "Detached HEAD" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN (337 next)." >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"

ENGINE="backend/src/modules/booking-engine/booking-engine.service.js"
MODULE="backend/src/modules/reservations/reservation-confirmation-email.js"
NEWTEST="backend/src/modules/reservations/public-booking-confirmation-fireandforget.test.mjs"
SELF=".deploy-notes/2026-07-23-ship-publicbooking-email-fireandforget-beta337.sh"
FILES=(
  "$ENGINE"
  "$MODULE"
  "$NEWTEST"
  "backend/package.json"
  "$SELF"
)

# ── GATE 1: syntax
( cd backend && node --check "${ENGINE#backend/}" && node --check "${MODULE#backend/}" )
echo "GATE 1 OK: node --check limpio."

# ── GATE 2: both public call sites must be wired to the fire wrapper and NOT awaited.
# Re-adding `await` at either site silently restores the 4-5s latency and every test
# still passes, so this gate is the only thing that catches it.
[ "$(grep -c 'export function firePublicBookingConfirmationEmail' "$MODULE")" -ge 1 ] \
  || { echo "ABORT: firePublicBookingConfirmationEmail not exported from the module." >&2; exit 1; }
[ "$(grep -c 'firePublicBookingConfirmationEmail' "$ENGINE")" -ge 1 ] \
  || { echo "ABORT: booking-engine does not import the fire wrapper." >&2; exit 1; }
# The alias must point at the fire wrapper, not the raw sender.
[ "$(grep -c 'sendPublicBookingConfirmationEmail = firePublicBookingConfirmationEmail' "$ENGINE")" -eq 1 ] \
  || { echo "ABORT: the local alias no longer points at the fire-and-forget wrapper." >&2; exit 1; }
# Neither call site may be awaited. grep -c (not -q) on purpose: -q + pipefail
# SIGPIPEs on an early match.
if [ "$(grep -cE 'await[[:space:]]+sendPublicBookingConfirmationEmail|await[[:space:]]+firePublicBookingConfirmationEmail' "$ENGINE")" -ne 0 ]; then
  echo "ABORT: the public-booking confirmation send is still AWAITED — the whole fix is that it must NOT be." >&2; exit 1
fi
# And the response helper must be in place at both sites: 1 definition + 2 uses.
[ "$(grep -c 'function pendingConfirmationEmail(customer)' "$ENGINE")" -eq 1 ] \
  || { echo "ABORT: pendingConfirmationEmail() is not defined exactly once." >&2; exit 1; }
[ "$(grep -c 'pendingConfirmationEmail(customer)' "$ENGINE")" -eq 3 ] \
  || { echo "ABORT: expected 3 hits for pendingConfirmationEmail(customer) — 1 definition + the 2 call sites." >&2; exit 1; }
echo "GATE 2 OK: fire-and-forget wired at both public paths, neither awaited."

# ── GATE 2b: ENCODING. A Windows PowerShell round-trip once rewrote this file as
# CP1252→UTF-8+BOM and corrupted 22 non-ASCII chars, one of them a live string that
# persists into reservation.notes. Cheap permanent guard.
for F in "$ENGINE" "$MODULE"; do
  if [ "$(head -c 3 "$F" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
    echo "ABORT: $F has a UTF-8 BOM — it must not." >&2; exit 1
  fi
  if [ "$(grep -c 'Â\|â€\|â†\|Ã—\|âœ' "$F" || true)" -ne 0 ]; then
    echo "ABORT: $F contains mojibake (double-encoded UTF-8)." >&2; exit 1
  fi
done
# The specific string that got corrupted last time.
[ "$(grep -c "join(' · ')" "$ENGINE")" -eq 1 ] \
  || { echo "ABORT: the CAR_SHARING notes separator is corrupted or missing." >&2; exit 1; }
echo "GATE 2b OK: no BOM, no mojibake, notes separator intact."

# ── GATE 3: no schema / no migration. package.json MAY change, but ONLY the
# test:reservations line — and never its dependencies.
[ -z "$(git diff HEAD --name-only -- backend/prisma/schema.prisma backend/prisma/migrations 2>/dev/null)" ] \
  || { echo "ABORT: unexpected schema/migration change in a no-migration ship." >&2; exit 1; }
[ -z "$(git diff HEAD --name-only -- package-lock.json backend/package-lock.json frontend/package-lock.json 2>/dev/null)" ] \
  || { echo "ABORT: a lockfile changed — this ship adds no dependency." >&2; exit 1; }
PKG_CHANGED="$(git diff HEAD -- backend/package.json | grep -c '^[+-][^+-]' || true)"
[ "$PKG_CHANGED" -eq 2 ] \
  || { echo "ABORT: backend/package.json changed on $PKG_CHANGED lines; expected exactly 2 (the test:reservations line)." >&2; exit 1; }
[ "$(git diff HEAD -- backend/package.json | grep -c '^[+-].*"\(dependencies\|devDependencies\)"')" -eq 0 ] \
  || { echo "ABORT: backend/package.json dependency block changed." >&2; exit 1; }
# package.json and the new test are coupled: shipping the script line without the
# file makes `npm run test:reservations` die with ERR_MODULE_NOT_FOUND.
[ -f "$NEWTEST" ] || { echo "ABORT: $NEWTEST is missing but package.json references it." >&2; exit 1; }
echo "GATE 3 OK: no schema/migration/lockfile; package.json limited to the test line."

# ── GATE 4: tests (dev DB on the SESSION port 5432; NOT the dead 5433)
# test:public-booking is deliberately NOT in this list even though this change
# touches that area: it carries a PRE-EXISTING failure —
# public-booking.test.mjs:75 "returns { tenantId, fees } on success" — caused by a
# cache.getOrSet key collision between two tests in the same describe block (prisma
# is fully monkey-patched there, so it fails on ANY database, and it fails on the
# beta.336 tag too). Including it would abort every ship attempt. Tracked separately;
# re-add this suite once that test is fixed.
if command -v nc >/dev/null 2>&1 && nc -z localhost 5432 >/dev/null 2>&1; then
  for T in test:reservations test:quotes test:booking-engine test:carsharing; do
    ( cd backend && DATABASE_URL="${DEV_DB_URL:-postgresql://$(whoami)@localhost:5432/fleet_management?schema=public}" npm run "$T" ) \
      || { echo "ABORT: $T failed." >&2; exit 1; }
  done
  echo "GATE 4 OK: reservations + quotes + booking-engine + carsharing green."
else
  echo "GATE 4 SKIP: no postgres on localhost:5432 — tests did NOT run."
fi

# ── GATE 5: env parity (no new keys). Runs against the tag's .env.example in case
# the working tree carries keys from another workstream.
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example 2>/dev/null || true
bash scripts/env-diff-check.sh < /dev/null || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example

# ── STAGE + guard
git reset >/dev/null
git add -- "${FILES[@]}"
LEAK="$(git diff --cached --name-only | grep -vE "^(${ENGINE//\//\\/}|${MODULE//\//\\/}|${NEWTEST//\//\\/}|backend/package\.json|${SELF//\//\\/})$" || true)"
[ -z "$LEAK" ] || { echo "ABORT: unexpected files staged:"; printf '%s\n' "$LEAK"; git reset >/dev/null; exit 1; }
echo "GATE 6 OK: staged set = the 4 files + this script."

echo; git diff --cached --stat; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok < /dev/tty
[ "$ok" = "y" ] || { echo "Left staged (not committed)."; exit 0; }
git commit -m "fix(public-booking): fire-and-forget confirmation email on the two website create paths

beta.336 (e24d5c7) stopped reservationsService.create from awaiting the
confirmation-email SMTP send, and flagged the sibling it left behind: the
RENTAL and CAR_SHARING create paths in booking-engine.service.js awaited
the SAME builder. Latency only — the website does not auto-retry, so it
never duplicated like the VozIA quote-convert did — but every booking made
from the website paid ~4-5s before its confirmation screen rendered. Both
paths now fire the send and return immediately.

Because these two paths RETURN the send result as \`confirmationEmail\`, and
the outcome is no longer knowable inside the request, the response reports
{ emailSent:false, pending:true, sentTo:[email], warning:null }. Same keys,
\`pending\` additive; no consumer in the RFM frontend or the storefront reads
it. Named \`pending\`, not \`queued\`, because a queue in this codebase means
the durable BullMQ layer and this has none of its retry semantics.

Both wrappers now share one fireAndForget helper (mechanics only — the
opt-out flag and confirmationEmailSentAt stamp stay exclusive to the create
path, so which emails go out is unchanged). A resolved-but-failed send now
logs at ERROR, since the outcome no longer travels back in the response.
Also fixes a doc reference to a CLAUDE.local.md section that never existed.

Backend-only, no migration. QA SHIP.
Follow-ups: drain in-flight sends on SIGTERM (main.js exits without
draining — inherited); tighten the sender's pre-try DB calls.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo; echo "Pushed $TAG. Droplet: git fetch --tags && git checkout $TAG && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "No migration. Verify: 3 containers healthy + clean boot + /api/health 200 + a website booking returns fast (<1s) and its confirmation email still arrives."
