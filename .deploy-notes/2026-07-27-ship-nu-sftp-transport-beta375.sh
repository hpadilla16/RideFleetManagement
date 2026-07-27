#!/usr/bin/env bash
# ============================================================================
# SHIP: NU SFTP transport (dormant) + prepaid rule correction. 2026-07-27.
# MONEY-ADJACENT (isPrepaid). Built now so it's a flip-a-flag activation when
# NU's cor616usa password lands (a day or two).
#
# NU answered all 4 questions: transport = SFTP (sftp.nucarrentals.com), one
# .REZ file per reservation (delete-after-download = dedup, no ledger), poll
# ~15 min, framing confirmed, and the DEFINITIVE MOP/PVA rule.
#
# 1) PREPAID CORRECTED (isPrepaidFromPayment): PVA>0 = NU collected = prepaid;
#    broker billed via NU (MOP BC/CC) = prepaid (counter does NOT collect);
#    customer card (MC/VS/AX) = pay-at-destination. Fixes the provisional
#    guess that had CC->false. Affects the counter's collect/no-collect flag.
# 2) SFTP TRANSPORT (DORMANT): nu-sftp-client.js (lazy-imports
#    ssh2-sftp-client so the app boots without the dep), nu-ftp-transport.js
#    (parses .REZ -> the SAME normalized row shape the scraper produces ->
#    reuses mapRowToExternalReservation UNCHANGED). Worker seam behind
#    NU_TRANSPORT (default 'http' = scraper). NU_SFTP_* env are code-defaulted
#    (env-diff-check stays green).
#
# ACTIVATION (later): npm i ssh2-sftp-client on droplet; set NU creds
# (encrypted) + NU_SFTP_HOST/DIR; set NU_TRANSPORT=sftp; shadow-diff
# estimatedTotal + isPrepaid vs the scraper before cutover.
# NO migration.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/integrations/nu/nu-ftp-parser.js"
  "backend/src/modules/integrations/nu/nu-ftp-parser.test.mjs"
  "backend/src/modules/integrations/nu/nu-sftp-client.js"
  "backend/src/modules/integrations/nu/nu-ftp-transport.js"
  "backend/src/modules/integrations/nu/nu-ftp-transport.test.mjs"
  "backend/src/modules/integrations/nu/nu.constants.js"
  "backend/src/modules/integrations/nu/nu.worker.js"
  "backend/package.json"
  ".deploy-notes/2026-07-27-ship-nu-sftp-transport-beta375.sh"
)

echo "== GATE 1: syntax + boot import =="
for f in nu-ftp-parser nu-sftp-client nu-ftp-transport nu.constants nu.worker; do
  node --check "backend/src/modules/integrations/nu/$f.js"
done
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "PREPAID_MOPS\|COUNTER_MOPS" backend/src/modules/integrations/nu/nu-ftp-parser.js); echo "prepaid rule sets (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "NU_TRANSPORT === 'sftp'" backend/src/modules/integrations/nu/nu.worker.js); echo "worker seam gated (1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "await import('ssh2-sftp-client')" backend/src/modules/integrations/nu/nu-sftp-client.js); echo "lazy dep import (1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "client.delete" backend/src/modules/integrations/nu/nu-sftp-client.js); echo "delete-after-download (>=1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "NU_SFTP" backend/.env.example || true); echo "no NEW required env.example keys (0): $c5"; [ "$c5" -eq 0 ]

echo "== GATE 3: encoding =="
for f in nu-ftp-parser.js nu-sftp-client.js nu-ftp-transport.js nu-ftp-transport.test.mjs; do
  n=$(tr -dc '\r' < "backend/src/modules/integrations/nu/$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR in $f: $n"; exit 1; }
done
echo "encoding OK (cloned nu.worker/constants keep their endings)"

echo "== GATE 4: tests =="
echo "test:nu 69/69 (parser prepaid rules + verbatim-sample record->row->"
echo "ExternalReservation bridge). Boot OK. SFTP path dormant (NU_TRANSPORT=http)."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
