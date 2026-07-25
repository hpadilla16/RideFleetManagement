#!/usr/bin/env bash
# ============================================================================
# SHIP: first-login onboarding — forced password change (LAX meeting item #2)
# 2026-07-25.
#
# WHY: staff are created with a temp password and an invite email that
# PROMISES "change your password after your first login" — but no
# self-service change-password existed, so temp passwords lived forever.
# The 33 LAX staff accounts are about to be seeded exactly this way.
#
# WHAT SHIPS
#  - User.mustChangePassword + User.passwordChangedAt (additive idempotent
#    migration 20260725_user_must_change_password). Existing users stay
#    unaffected (flag false); it only arms at the temp-password sites.
#  - POST /api/auth/change-password: requires the CURRENT password even
#    mid-forced-flow, enforces the /register policy (12+ upper/lower/digit/
#    special), clears the flag, stamps passwordChangedAt, re-issues the JWT,
#    busts the session cache. Rate-limited (same guard as lock-pin).
#  - requireAuth gate: humans with the flag reach ONLY
#    {POST change-password, GET me, POST refresh}; everything else 403s with
#    code PASSWORD_CHANGE_REQUIRED. Service accounts exempt (their own
#    default-deny allowlist governs). Mirrors the VozIA allowlist pattern.
#  - Flag armed at ALL temp-password sites: peopleService.create (covers the
#    People UI, tenant admins AND seed-lax-employees.mjs with zero seeder
#    changes), peopleService.resetPassword (+ session-cache bust so an open
#    session gates immediately), tenants createTenantAdmin +
#    resetTenantAdminPassword (the TempPass123! literals).
#  - randomTempPassword is now crypto-strong (was Math.random).
#  - AuthGate.jsx renders the forced-change screen for me.mustChangePassword —
#    it wraps EVERY authenticated page including the mobile shell, so there
#    is no bypass surface. register() stamps passwordChangedAt (self-chosen).
#
# QA (adversarial, 2026-07-25): APPROVE, 0 blockers / 0 majors. Minors fixed
# in this diff: temp password entropy 24→64 bits; live-session reset now
# surfaces the forced screen without reload (PASSWORD_CHANGE_REQUIRED event
# in client.js → AuthGate re-fetches /me); tenants reset busts session cache.
#
# KNOWN EDGES (accepted, documented):
#  - SUPER_ADMIN impersonation of a flagged tenant admin lands on the forced
#    screen for that account; completing it would consume the target's
#    onboarding. Support note: reset again afterwards.
#  - A gated staffer can still authorize kiosk staff-assist via lock PIN
#    (separate secret, JWT-free device router) — pre-existing trust model.
#  - Native employee/host mobile apps (separate repos) get bare 403s with
#    code PASSWORD_CHANGE_REQUIRED — flag to those repos.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260725_user_must_change_password/migration.sql"
  "backend/src/middleware/auth.js"
  "backend/src/modules/auth/auth.service.js"
  "backend/src/modules/auth/auth.routes.js"
  "backend/src/modules/auth/password-gate.test.mjs"
  "backend/src/modules/people/people.service.js"
  "backend/src/modules/tenants/tenants.service.js"
  "backend/package.json"
  "frontend/src/components/AuthGate.jsx"
  "frontend/src/lib/client.js"
  ".deploy-notes/2026-07-25-ship-forced-password-change-betaNNN.sh"
)

echo "== GATE 1: syntax + boot import =="
for f in backend/src/middleware/auth.js backend/src/modules/auth/auth.service.js \
         backend/src/modules/auth/auth.routes.js backend/src/modules/people/people.service.js \
         backend/src/modules/tenants/tenants.service.js; do
  node --check "$f"
done
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "PASSWORD_CHANGE_REQUIRED" backend/src/middleware/auth.js); echo "gate present (>=1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "mustChangePassword: true" backend/src/modules/people/people.service.js); echo "people arms flag (2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "mustChangePassword: true" backend/src/modules/tenants/tenants.service.js); echo "tenants arms flag (2): $c3"; [ "$c3" -ge 2 ]
c4=$(grep -c "crypto.randomBytes" backend/src/modules/people/people.service.js); echo "crypto temp password (>=1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "mustChangePassword" frontend/src/components/AuthGate.jsx); echo "forced screen wired (>=1): $c5"; [ "$c5" -ge 1 ]
c6=$(grep -c "IF NOT EXISTS" backend/prisma/migrations/20260725_user_must_change_password/migration.sql); echo "migration idempotent (2): $c6"; [ "$c6" -ge 2 ]
c7=$(grep -c "Math\.random()" backend/src/modules/people/people.service.js || true); echo "Math.random() call gone (0): $c7"; [ "$c7" -eq 0 ]

echo "== GATE 3: encoding (no CR, migration ASCII-only) =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260725_user_must_change_password/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "non-ASCII bytes in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:auth )
echo "DB-backed: run the scratchpad runner for test:people test:service-auth; frontend: npx next build"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }

echo "== READY: check remote tags first (parallel sessions have raced tags today) =="
echo "POST-DEPLOY: npx prisma generate on droplet HOST from backend/ (new User columns)."
echo "Then it is safe to run seed-lax-employees.mjs --commit — every seeded"
echo "account will be forced to set its own password on first login."
