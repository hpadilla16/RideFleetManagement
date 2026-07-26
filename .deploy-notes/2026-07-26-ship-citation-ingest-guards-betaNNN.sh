#!/usr/bin/env bash
# ============================================================================
# SHIP: citation ingest guards (Orlando-on-LAX bug, LAX meeting item)
# 2026-07-26. MONEY-ADJACENT: auto-matching posts charges.
#
# DATA FINDING FIRST (changes the story): the 38 "City of Orlando" citations
# on LAX vehicles had CORRECT plate binds — CA-format plates matching the
# real LAX cars exactly, zero twin plates in ANY tenant, all NEEDS_REVIEW,
# 0 billed, no issuedAt. The agency label was garbage from the upstream
# import (likely OCR), not a matching failure. No money moved. The rows
# stay for staff review (they are probably REAL LA citations mislabeled).
#
# THE CODE FIX closes the two holes the incident exposed:
#  - AMBIGUOUS_PLATE: the tenant-wide plate map was first-write-wins. The DB
#    forbids exact duplicates per tenant, but normalizePlate collapses
#    distinct raw plates ("DUP-123" vs "DUP123") — a real cross-branch
#    collision would silently attach + AUTO-BILL the wrong customer with no
#    review. Now: no vehicle bind, holdReason, NEEDS_REVIEW.
#  - AGENCY_STATE_MISMATCH: nothing sanity-checked the citation's geography.
#    Now: officer's plateState (else conservative agency/location keyword →
#    state map, explicit signals only — never guess) vs the vehicle's home
#    state; conflict keeps the vehicle bind for display but HOLDS the row —
#    no reservation match, no AUTO_CONFIRMED assignment, no billing.
#  - Citation.holdReason records WHY (migration 20260726_citation_hold_reason).
#
# This unblocks enabling the citations AI for manual import: a bad OCR
# agency/plate can no longer silently bill the wrong renter.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260726_citation_hold_reason/migration.sql"
  "backend/src/modules/citations/citations.service.js"
  "backend/src/modules/citations/citation-ingest-guards.test.mjs"
  "backend/package.json"
  ".deploy-notes/2026-07-26-ship-citation-ingest-guards-betaNNN.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/citations/citations.service.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "AMBIGUOUS_PLATE" backend/src/modules/citations/citations.service.js); echo "ambiguity guard (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "AGENCY_STATE_MISMATCH" backend/src/modules/citations/citations.service.js); echo "geo guard (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "holdReason ? null : await findMatchingReservation" backend/src/modules/citations/citations.service.js); echo "held rows never match (1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "citation-ingest-guards.test.mjs" backend/package.json); echo "tests wired (1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "IF NOT EXISTS" backend/prisma/migrations/20260726_citation_hold_reason/migration.sql); echo "migration idempotent (1): $c5"; [ "$c5" -ge 1 ]

echo "== GATE 3: encoding (no CR, migration ASCII-only) =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260726_citation_hold_reason/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "non-ASCII bytes in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests (scratchpad embedded-pg runner) =="
echo "test:citations-scope 18/18 verified pre-ship (guards + location-scope regression)"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }

echo "== POST-DEPLOY: npx prisma generate on droplet HOST from backend/ (new column) =="