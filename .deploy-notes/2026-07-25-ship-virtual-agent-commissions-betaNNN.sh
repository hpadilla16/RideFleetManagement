#!/usr/bin/env bash
# ============================================================================
# SHIP: Virtual Agent person type + 1% sold-items commission (LAX #4, MONEY)
# 2026-07-25 — Hector's rule: "los virtuales es 1% de todo lo que venden"
# (additional services + insurance, excl. taxes/fees/deposits), ALONGSIDE
# the checkout employee's commission (counter stays catalog until the
# review-based system, LAX #5, lands).
#
# WHAT SHIPS
#  - User.personKind enum (STANDARD default) + CommissionPlan.personKind +
#    Reservation.createdByUserId (migration 20260725_virtual_agent_person_kind).
#  - lib/sold-items.js: the ONE authoritative sold-item source list (4
#    service spellings + INSURANCE; inclusion list, fees can never leak in).
#  - Sync: VA sales owner earns a SECOND AgreementCommission row (percent of
#    sold items; SERVICE_CATALOG never consulted for VA plans); checkout
#    employee row unchanged; a checkout BY a VA uses VA math.
#  - Attribution chain (QA B1): staff create stamps Reservation.createdByUserId
#    (server-derived); agreement create seeds salesOwnerUserId when the
#    originator is an ACTIVE VIRTUAL_AGENT; checkout inspection + close only
#    fill a VACANT salesOwner — they no longer clobber the originator.
#    Legacy flows (no VA) are byte-identical: non-VA originators seed
#    nothing, the inspector claims ownership exactly as before.
#  - Prune status guard (QA M1): re-sync never deletes APPROVED/PAID rows —
#    deactivating a VA plan cannot erase paid payout records fleet-wide via
#    the nightly resync sweep. Only PENDING/VOID rows are pruned.
#  - QA M2: the always-AGENT invariant derives from STORED personKind in
#    updatePerson, never the client-sent personType.
#  - serviceRevenue metric now counts all 4 service sources (was
#    ADDITIONAL_SERVICE only — deliberate under-count fix; commission
#    amounts for standard employees are unchanged, pinned by suite).
#  - UI: People gets the VIRTUAL AGENT type (+ tile/summary); Settings
#    commission plans get "Applies To" targeting.
#
# ACTIVATION (Hector, post-deploy, all in the UI): create the plan in
# Settings → Commission Plans (Applies To: Virtual agents, Default Rule
# Type: Percent, Default Percent: 1, Active) and mark the people as
# VIRTUAL AGENT in People. No plan → VAs earn nothing (fail-closed).
#
# KNOWN EDGES (documented): EMPLOYEE↔VIRTUAL_AGENT conversion needs
# delete-and-recreate (personType is immutable after create, by design);
# Sales Performance / Agent Track Record reports compute catalog numbers
# inline and will disagree with a VA's ledger (pre-existing divergence,
# tracked); overriding the commission owner TO a VA makes them the sole
# PENDING owner (explicit admin action; PAID/APPROVED rows survive).
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260725_virtual_agent_person_kind/migration.sql"
  "backend/src/lib/sold-items.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/rental-agreements/virtual-agent-commission.test.mjs"
  "backend/src/modules/people/people.service.js"
  "backend/src/modules/people/people-role.test.mjs"
  "backend/src/modules/commissions/commissions.service.js"
  "backend/src/modules/reservations/reservations.service.js"
  "backend/src/modules/reservations/reservations.routes.js"
  "backend/package.json"
  "frontend/src/app/people/page.js"
  "frontend/src/app/settings/page.js"
  "frontend/src/app/settings/settings-constants.js"
  ".deploy-notes/2026-07-25-ship-virtual-agent-commissions-betaNNN.sh"
)

echo "== GATE 1: syntax + boot import =="
for f in backend/src/lib/sold-items.js \
         backend/src/modules/rental-agreements/rental-agreements.service.js \
         backend/src/modules/people/people.service.js \
         backend/src/modules/commissions/commissions.service.js \
         backend/src/modules/reservations/reservations.service.js \
         backend/src/modules/reservations/reservations.routes.js; do
  node --check "$f"
done
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "virtualAgentCommissionLines" backend/src/modules/rental-agreements/rental-agreements.service.js); echo "VA math def+uses (>=3): $c1"; [ "$c1" -ge 3 ]
c2=$(grep -c "keepEmployeeIds" backend/src/modules/rental-agreements/rental-agreements.service.js); echo "two-row prune (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "status: { in: \['PENDING', 'VOID'\] }" backend/src/modules/rental-agreements/rental-agreements.service.js); echo "M1 status guard (1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "salesOwnerUserId: null" backend/src/modules/rental-agreements/rental-agreements.service.js); echo "B1 vacancy-only claim (1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "createdByUserId" backend/src/modules/reservations/reservations.routes.js); echo "originator stamped (>=1): $c5"; [ "$c5" -ge 1 ]
c6=$(grep -c "vaOriginatorId" backend/src/modules/rental-agreements/rental-agreements.service.js); echo "originator seeded x2 sites (>=4): $c6"; [ "$c6" -ge 4 ]
c7=$(grep -c "VIRTUAL_AGENT" backend/src/modules/people/people.service.js); echo "people accepts kind (>=5): $c7"; [ "$c7" -ge 5 ]
c8=$(grep -c "IF NOT EXISTS" backend/prisma/migrations/20260725_virtual_agent_person_kind/migration.sql); echo "migration idempotent (3): $c8"; [ "$c8" -ge 3 ]

echo "== GATE 3: encoding (no CR, migration ASCII-only) =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260725_virtual_agent_person_kind/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "non-ASCII bytes in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:commissions )
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" node --test src/modules/people/people-role.test.mjs )
echo "DB-backed via scratchpad runner: test:people test:rental-agreements test:reservations test:reservation-override + reports files with TZ=UTC from bash; frontend: npx next build"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }

echo "== POST-DEPLOY: npx prisma generate on droplet HOST from backend/ (new enum + columns) =="