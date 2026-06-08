#!/usr/bin/env bash
# v0.9.0-beta.132 — post check-in fees now reach the unpaid balance + TL proxy env guardrail.
#   bash .deploy-notes/2026-06-08-ship-postcheckin-fee-balance-fix-beta132.sh
#
# ⚠️  MONEY PATH (balance computation). Hector gave EXPLICIT approval for the
#     surgical approach on 2026-06-08 ("Quirúrgico (recomendado)"). No gateway /
#     charge-capture code touched. No migrations (additive or otherwise).
#
# ── BUG #1 (the fix): fees added AFTER check-in were never added to the unpaid
#    balance. Example: TL-ZE40787112BA.
#    ROOT CAUSE: reservation-pricing.service.js#syncAgreementCharges early-returns
#    when the RentalAgreement status is CLOSED. Check-in closes the agreement, so
#    any fee added post check-in (issue-center claim charge, manual "Edit pricing")
#    created a ReservationCharge but was NEVER mirrored into RentalAgreementCharge
#    and the binding RentalAgreement.total/balance was never recomputed → the fee
#    was invisible to the unpaid balance.
#    FIX (surgical, no read-path change): syncAgreementCharges + getPricing accept
#    { allowClosed }. Routine pricing READS keep the CLOSED guard (no behavior
#    change). The two EXPLICIT post-checkin mutation paths pass allowClosed:true so
#    the new charge mirrors and the balance recomputes:
#      - reservations PUT /:id/pricing  → replacePricing (manual fee edit)
#      - issue-center createChargeDraft  → claim charge
#    CANCELLED agreements are still never reopened.
#
# ── BUG #2 GUARDRAIL (not the full fix — see notes below): added
#    TL_INTERNATIONAL_PROXY_URL to backend/.env.example, UNCOMMENTED, so
#    scripts/env-diff-check.sh fails the deploy if it is missing from the droplet
#    .env. TL's CloudFlare binds the session cookie to the residential IP that
#    earned it; the droplet egresses from NYC, so without the proxy EVERY TL
#    request is bounced to login.php and surfaces as a misleading "expired cookie"
#    — even with a freshly pasted cookie (Hector's exact symptom). The actual
#    remediation is operational: set TL_INTERNATIONAL_PROXY_URL on the droplet to
#    the live Tailscale residential proxy (and confirm the proxy is up). This
#    guardrail just makes a missing key fail-closed instead of silently rejecting.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.132"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH (must be at v0.9.0-beta.131 tip)"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reservations/reservation-pricing.service.js"
  "backend/src/modules/issue-center/issue-center-claims.service.js"
  "backend/.env.example"
  ".deploy-notes/2026-06-08-ship-postcheckin-fee-balance-fix-beta132.sh"
)

# ── SYNTAX GATE
( cd backend \
  && node --check "src/modules/reservations/reservation-pricing.service.js" \
  && node --check "src/modules/issue-center/issue-center-claims.service.js" )
echo "node --check OK."

# ── GUARD: confirm the allowClosed plumbing is actually present (edit applied).
grep -nq "allowClosed" backend/src/modules/reservations/reservation-pricing.service.js \
  || { echo "ABORT: allowClosed not found in reservation-pricing.service.js — edit not applied." >&2; exit 1; }
grep -nq "allowClosed: true" backend/src/modules/issue-center/issue-center-claims.service.js \
  || { echo "ABORT: issue-center createChargeDraft not passing allowClosed:true — edit not applied." >&2; exit 1; }
grep -nq "^TL_INTERNATIONAL_PROXY_URL=" backend/.env.example \
  || { echo "ABORT: TL_INTERNATIONAL_PROXY_URL not tracked (uncommented) in .env.example." >&2; exit 1; }
echo "Guards OK: allowClosed wired + proxy key tracked."

# ── UNIT TESTS (touch the charge/agreement writers)
# --test-force-exit: duplicate-charges.test.mjs imports the prisma client, whose
# connection pool keeps the event loop alive after the assertions pass — without
# this flag node --test never exits and would hang the deploy. The tests
# themselves pass; this only forces a clean process exit.
( cd backend \
  && node --test --test-force-exit src/modules/rental-agreements/duplicate-charges.test.mjs \
  && node --test --test-force-exit src/modules/issue-center/issue-center-charge-draft.test.mjs )
echo "Unit tests OK."

# ── ENV: this WILL now require TL_INTERNATIONAL_PROXY_URL on the droplet.
#    If it fails on that key, SET it in the droplet backend/.env first (that is
#    also the fix for bug #2), then re-run. Fail-closed is intentional.
bash scripts/env-diff-check.sh || { echo "env-diff-check failed — set the missing key(s) on the droplet before deploy (TL_INTERNATIONAL_PROXY_URL is expected here)." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "Review:  git diff --cached -- ${FILES[*]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(pricing): post check-in fees reach the unpaid balance (allowClosed)

Fees added after check-in (issue-center claim charge, manual Edit pricing) created
a ReservationCharge but were never mirrored to RentalAgreementCharge, because
syncAgreementCharges early-returns on CLOSED agreements. The binding
RentalAgreement.total/balance was therefore never recomputed and the fee was
invisible to the unpaid balance (example TL-ZE40787112BA).

Surgical fix: syncAgreementCharges + getPricing accept { allowClosed }. Routine
pricing reads keep the CLOSED guard (no behavior change). The two explicit
post-checkin mutation paths (replacePricing, issue-center createChargeDraft) pass
allowClosed:true so the new charge mirrors and the balance recomputes. CANCELLED
agreements are never reopened. No gateway/charge-capture code touched; no
migrations.

Also: track TL_INTERNATIONAL_PROXY_URL (uncommented) in backend/.env.example so
env-diff-check fails closed when it is missing on the droplet — the missing proxy
is what makes a fresh TL cookie surface as a misleading 'expired cookie'."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  # bug #2: make sure the proxy is set FIRST (env-diff already enforced it):"
echo "  grep -q '^TL_INTERNATIONAL_PROXY_URL=' ~/RideFleetManagement/backend/.env || echo 'SET IT'"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy + clean boot (no MODULE_NOT_FOUND/TypeError) + /health 200."
echo "  smoke (bug #1): on a CHECKED_IN/CLOSED reservation, add a fee via issue-center"
echo "         claim charge (or Edit pricing) → the reservation's unpaid balance must"
echo "         increase by the fee amount. Re-open the agreement detail to confirm"
echo "         RentalAgreement.balance reflects it."
echo "  smoke (bug #2): admin Settings → Integrations → TL-International → Test auth"
echo "         should return OK with the proxy set + a fresh cookie. Run now → import."
