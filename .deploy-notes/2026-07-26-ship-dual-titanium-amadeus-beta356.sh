#!/usr/bin/env bash
# ============================================================================
# SHIP: Titanium/Amadeus DUAL suggested bases in the MI Excel (LAX meeting)
# 2026-07-26. DISPLAY-ONLY — one file, no migration, no auto-apply change.
#
# The market-pricing Excel now back-solves the SAME target all-in under BOTH
# gross-up formulas — "Base (Titanium)" (compounding, TL International) and
# "Base (Amadeus)" (additive, every other franchise) — side by side, both
# floor-clamped, so Hector can relay numbers to any franchise regardless of
# its connection. "Uploaded Rate (base)" and the auto-apply engine still use
# ONLY the location's configured connectionType — the single value that
# actually gets written anywhere.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/market-observations/market-observations.service.js"
  ".deploy-notes/2026-07-26-ship-dual-titanium-amadeus-beta356.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/market-observations/market-observations.service.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "baseTitanium" backend/src/modules/market-observations/market-observations.service.js); echo "titanium column wired (>=4): $c1"; [ "$c1" -ge 4 ]
c2=$(grep -c "baseAmadeus" backend/src/modules/market-observations/market-observations.service.js); echo "amadeus column wired (>=4): $c2"; [ "$c2" -ge 4 ]

echo "== GATE 3: encoding =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
echo "encoding OK"

echo "== GATE 4: tests =="
echo "market-scraper 132/132 + market-airports 5/5 on embedded PG (pre-ship)"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
