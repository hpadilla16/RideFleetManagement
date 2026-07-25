#!/usr/bin/env bash
# ============================================================================
# SHIP: per-reservation mileage exception + flat per-day fee in MI gross-up
# 2026-07-25 (MONEY — both halves).
#
# A) MILEAGE EXCEPTION (Hector: "asegurate que el deposito y 150 miles per
#    day se pueden editar adentro de la reserva"). Deposit already was
#    editable; mileage now is: "Included miles/day" + "Unlimited" in Edit
#    pricing. The exception merges into the FROZEN decision JSON (the single
#    source check-in billing reads), marked mileageSource UI_MANUAL.
#    QA fixes baked in:
#     - A-1 (MAJOR): clearing the field strips ONLY a manual exception —
#       the rule's own frozen cap (LAX local 150) is untouchable from here.
#     - A-2 (MAJOR): precheckin re-eval now runs on UI_MANUAL snapshots IF
#       the deposit still equals what the rule froze (mileage-only edits no
#       longer freeze an UNKNOWN deposit at $2,000 forever).
#     - A-3: open edit panel survives background refresh()es.
#     - N-1: numeric change detection (untouched save stamps nothing).
#
# B) FLAT PER-DAY FEE (LAX Vehicle License Fee $2.00/DAY — per-day is
#    Hector-review-flagged; per-RENTAL flat fees are rejected loudly).
#    all_in = base×factor + flat; base = (target−flat)/factor; target ≤ flat
#    → null (fail-closed HOLD downstream, never zero/negative money).
#    QA BLOCKER B-1 fixed: upsertMarketPricingConfig used to WHITELIST
#    {name,pct} — a Settings save silently erased a seeded flat fee, landing
#    every LAX suggestion $2/day ABOVE the intended undercut. It now
#    validates + persists amountPerDay. flatPerDay clamps negatives (B-2).
#    Legacy pct-only configs are byte-identical (pinned by test).
#
# POST-DEPLOY: load LAX MarketPricingConfig (VLF $2/day + guardrails floor 7
# / ceiling 999 / maxDeltaPct 25) — WAITING on brokerage % from Hector to
# load it complete. MARKET_AUTOAPPLY_ENABLED stays false.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/reservations/reservation-pricing.service.js"
  "backend/src/modules/reservations/mileage-override.test.mjs"
  "backend/src/modules/customer-portal/customer-portal.routes.js"
  "backend/src/modules/market-scraper/pricing-grossup.js"
  "backend/src/modules/market-scraper/pricing-grossup.test.mjs"
  "backend/src/modules/settings/settings.service.js"
  "backend/package.json"
  "frontend/src/app/reservations/[id]/page.js"
  ".deploy-notes/2026-07-25-ship-mileage-override-vlf-betaNNN.sh"
)

echo "== GATE 1: syntax + boot import =="
for f in backend/src/modules/reservations/reservation-pricing.service.js \
         backend/src/modules/customer-portal/customer-portal.routes.js \
         backend/src/modules/market-scraper/pricing-grossup.js \
         backend/src/modules/settings/settings.service.js; do
  node --check "$f"
done
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "mileageSource !== 'UI_MANUAL'" backend/src/modules/reservations/reservation-pricing.service.js); echo "A-1 clear guard (1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "depositUntouched" backend/src/modules/customer-portal/customer-portal.routes.js); echo "A-2 heuristic (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "amountPerDay" backend/src/modules/settings/settings.service.js); echo "B-1 config passthrough (>=3): $c3"; [ "$c3" -ge 3 ]
c4=$(grep -c "Math.max(0, Number(t?.amountPerDay)" backend/src/modules/market-scraper/pricing-grossup.js); echo "B-2 negative clamp (1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "if (chargeEdit) return;" "frontend/src/app/reservations/[id]/page.js"); echo "A-3 prefill guard (1): $c5"; [ "$c5" -ge 1 ]
c6=$(grep -c "pricing-grossup.test.mjs" backend/package.json); echo "grossup tests wired (1): $c6"; [ "$c6" -ge 1 ]
c7=$(grep -c "mileage-override.test.mjs" backend/package.json); echo "mileage tests wired (1): $c7"; [ "$c7" -ge 1 ]

echo "== GATE 3: encoding =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" node --test \
    src/modules/reservations/mileage-override.test.mjs \
    src/modules/market-scraper/pricing-grossup.test.mjs )
echo "DB-backed: scratchpad runner for test:market-scraper test:reservation-override test:precheckin test:reservations; frontend: npx next build"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
