#!/usr/bin/env bash
# ============================================================================
# SHIP: customer damage acknowledgement signature (LAX meeting item #3)
# 2026-07-25 — design approved by Hector ("dale al damage report tambien").
#
# WHAT SHIPS
#  - OPTIONAL in-person signature in the Report Damage wizard (section 5,
#    shared wizard SignaturePad): statement + signature + printed name.
#    Toggle off → flow byte-identical to before.
#  - Statement: keyed section damage_acknowledgement in terms-content.js,
#    overrideable per location via termsSectionsJson (LAX can have its own
#    wording with zero code). The wizard DISPLAYS the server-resolved text
#    (GET /:reservationId/acknowledgement-statement) and the backend
#    SNAPSHOTS that same text with the signature — displayed and signed
#    wording cannot diverge; a resolution failure FAILS the submit.
#  - Storage: 5 nullable columns on VehicleDamageReport + incidentId index
#    (migration 20260725_damage_ack_signature). The damage report is the
#    durable anchor; the incident PDF reads it at assemble time.
#  - Incident PDF §9: renter acknowledgement statement + signature row above
#    the staff certification. Absent → §9 renders as before.
#
# QA (adversarial): 0 blockers; 3 MAJORs fixed in this diff:
#  - M1: a late-arriving signature on a duplicate submit (60s guard) is
#    persisted onto the PRIOR report (never overwrites an existing one);
#    result carries customerAckSaved and the wizard tells the truth when a
#    signature was NOT saved.
#  - M2: submit-with-ack requires the statement to have LOADED; fetch
#    failure shows a retry, never a signable "Loading…".
#  - M3: statement resolution failure at submit fails the submit instead of
#    silently snapshotting canonical wording the customer never read.
#  Minors: delete audit records that a SIGNED ack was destroyed (signer +
#  date); vehicle damage history omits the signature blobs from the DB read;
#  incidentId lookup indexed; name prefill never uses the email fallback.
#  Known edges (accepted): Storage photos orphan on 1b unwind (pre-existing
#  rollback pattern); deleting a damage report destroys the signed ack (now
#  audit-trailed).
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260725_damage_ack_signature/migration.sql"
  "backend/src/modules/checkout-session/terms-content.js"
  "backend/src/modules/report-damage/report-damage.service.js"
  "backend/src/modules/report-damage/report-damage.routes.js"
  "backend/src/modules/incident-report/incident-report.service.js"
  "backend/src/modules/incident-report/incident-report-pdf.js"
  "backend/src/modules/customer-inspection/customer-inspection.service.js"
  "frontend/src/components/reservations/ReportDamageWizard.jsx"
  ".deploy-notes/2026-07-25-ship-damage-ack-signature-betaNNN.sh"
)

echo "== GATE 1: syntax + boot import =="
for f in backend/src/modules/checkout-session/terms-content.js \
         backend/src/modules/report-damage/report-damage.service.js \
         backend/src/modules/report-damage/report-damage.routes.js \
         backend/src/modules/incident-report/incident-report.service.js \
         backend/src/modules/incident-report/incident-report-pdf.js \
         backend/src/modules/customer-inspection/customer-inspection.service.js; do
  node --check "$f"
done
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "DAMAGE_ACKNOWLEDGEMENT_SECTION" backend/src/modules/checkout-session/terms-content.js); echo "section defined+known+resolver (>=4): $c1"; [ "$c1" -ge 4 ]
c2=$(grep -c "customerAckSignatureDataUrl" backend/src/modules/report-damage/report-damage.service.js); echo "service persists ack (>=4): $c2"; [ "$c2" -ge 4 ]
c3=$(grep -c "renterAcknowledgement" backend/src/modules/incident-report/incident-report.service.js); echo "assemble carries ack (>=1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "renterAckBlock" backend/src/modules/incident-report/incident-report-pdf.js); echo "PDF renders ack (>=2): $c4"; [ "$c4" -ge 2 ]
c5=$(grep -c "ackStatementFailed" frontend/src/components/reservations/ReportDamageWizard.jsx); echo "M2 statement gate (>=3): $c5"; [ "$c5" -ge 3 ]
c6=$(grep -c "customerAckSaved" backend/src/modules/report-damage/report-damage.service.js); echo "M1 late-ack path (>=4): $c6"; [ "$c6" -ge 4 ]
c7=$(grep -c "IF NOT EXISTS" backend/prisma/migrations/20260725_damage_ack_signature/migration.sql); echo "migration idempotent (6): $c7"; [ "$c7" -ge 6 ]

echo "== GATE 3: encoding (no CR, migration ASCII-only) =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260725_damage_ack_signature/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "non-ASCII bytes in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests (DB-backed via scratchpad runner) =="
echo "run: test:report-damage test:incident test:terms-sections test:terms; frontend: npx next build"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }

echo "== POST-DEPLOY: npx prisma generate on droplet HOST from backend/ (new columns + index) =="