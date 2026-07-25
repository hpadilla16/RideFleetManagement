#!/usr/bin/env bash
# ============================================================================
# SHIP: person-type conversion in People (LAX #4 follow-up)
# 2026-07-25 — Hector: "no puedo cambiar los de agents a virtual agent".
#
# People → edit now allows ADMIN / EMPLOYEE / VIRTUAL_AGENT flips; the
# stored personKind FOLLOWS the explicit type (the QA-M2 hybrid — a VA row
# with role ADMIN still earning VA math — is unrepresentable, pinned by 6
# new pure tests). No personType in the payload → stored kind governs, as
# before. HOST stays non-convertible. UI warns that the converted person's
# PENDING commissions recalculate under the new type on the next sync.
# No migration, no schema change.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/people/people.service.js"
  "backend/src/modules/people/people-role.test.mjs"
  "frontend/src/app/people/page.js"
  ".deploy-notes/2026-07-25-ship-person-type-conversion-beta352.sh"
)

echo "== GATE 1: syntax + boot =="
node --check backend/src/modules/people/people.service.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "resolveEmployeeTypePatch" backend/src/modules/people/people.service.js); echo "conversion helper def+use+export (>=3): $c1"; [ "$c1" -ge 3 ]
c2=$(grep -c "form.personType === 'HOST'" frontend/src/app/people/page.js); echo "HOST stays locked (>=2): $c2"; [ "$c2" -ge 2 ]

echo "== GATE 3: encoding =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" node --test src/modules/people/people-role.test.mjs )

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
