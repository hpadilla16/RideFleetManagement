#!/bin/bash
# Full local rebuild for UI smoke test.
# Use after docker prune wiped all containers + volumes.
#
# What it does:
#   1. docker compose up -d (rebuilds + boots db + backend + frontend)
#   2. Waits for backend healthy
#   3. Re-runs the 3 seed scripts
#   4. SQL: flags LIVE + DejavooTerminal seed
#   5. Seeds a test reservation (UI-TEST-001)
#   6. Prints login + wizard URL
#
# Usage:
#   bash .patches-today/full-local-rebuild.sh
#
# After it runs, open http://localhost:3000 and walk through the wizard.

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement

LOCAL_TENANT_ID="cmnoom8fc0000v9tkexfqa5q6"

echo "=== 1/6: Bringing up db + backend + frontend ==="
docker compose -f docker-compose.yml up -d
echo "Containers launching... this takes ~60-90s on first run (npm install + prisma generate)"
echo "Tailing backend logs until healthy:"
for i in {1..40}; do
  sleep 5
  if curl -sf http://localhost:4000/health >/dev/null 2>&1; then
    echo "Backend healthy after ${i}x5s"
    break
  fi
  echo "  ...waiting (${i}x5s elapsed)"
done

curl -s http://localhost:4000/health || (echo "Backend not healthy after 200s — check 'docker logs fleet-backend'"; exit 1)
echo ""

echo "=== 2/6: Verify SPIN_MOCK=true in backend/.env ==="
if grep -q "^SPIN_MOCK=true" backend/.env 2>/dev/null; then
  echo "SPIN_MOCK=true confirmed in backend/.env"
else
  echo "ADDING SPIN_MOCK=true to backend/.env"
  echo "" >> backend/.env
  echo "# Round 25 local smoke testing — short-circuits Dejavoo HTTP calls" >> backend/.env
  echo "SPIN_MOCK=true" >> backend/.env
  echo "Restarting backend to pick up the env var..."
  docker compose -f docker-compose.yml restart backend
  for i in {1..20}; do
    sleep 5
    if curl -sf http://localhost:4000/health >/dev/null 2>&1; then
      break
    fi
  done
fi

echo ""
echo "=== 3/6: Seed bootstrap (tenant + locations + vehicle types + admin) ==="
docker compose exec backend node scripts/seed-bootstrap.mjs

echo ""
echo "=== 4/6: Seed super admin ==="
docker compose exec backend node scripts/tenant-seed-superadmin.mjs

echo ""
echo "=== 5/6: Seed terms template + flags + DejavooTerminal ==="
docker compose exec backend node scripts/seed-pilot-terms-template.mjs --tenant ${LOCAL_TENANT_ID} --commit --activate

docker compose exec -T db psql -U postgres -d fleet_management <<SQL
UPDATE "Tenant"
SET "settingsJson" = COALESCE("settingsJson", '{}'::jsonb) ||
  '{"featureFlags": {"interactiveTC": "LIVE", "dejavooCounter": "LIVE"}, "dejavoo": {"preAuthAmountCents": 25000}}'::jsonb
WHERE id = '${LOCAL_TENANT_ID}';

INSERT INTO "DejavooTerminal" (id, "tenantId", name, tpn, "authKeyEnc", "merchantNumber", sandbox, status, "createdAt", "updatedAt")
VALUES (
  'cmlocaldevterminal0001',
  '${LOCAL_TENANT_ID}',
  'Local Dev Terminal (MOCK)',
  '99999999',
  'PLAINTEXT_MOCK_KEY',
  1,
  true,
  'ACTIVE',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "updatedAt" = NOW();
SQL

echo ""
echo "=== 6/6: Seed test reservation for UI walkthrough ==="
docker compose exec backend node scripts/seed-ui-test-reservation.mjs

echo ""
echo "============================================================================"
echo "READY — UI smoke test setup complete."
echo "============================================================================"
echo ""
echo "1. Open http://localhost:3000 in your browser"
echo "2. Login: admin@ridefleet.com / Ride1234!"
echo "3. Wizard URL:  http://localhost:3000/reservations/cmuitestreservation0001/checkout-wizard"
echo ""
echo "What to test on step 1 (Signature):"
echo "  ✓ Page renders the NEW Dejavoo terminal UI (NOT the SignaturePad)"
echo "  ✓ Preflight info shows (default pre-auth + rental fee \$225)"
echo "  ✓ Click 'Start signing on terminal'"
echo "  ✓ Progress UI animates"
echo "  ✓ Mocked SPIn returns: SALE approved + AUTH approved"
echo "  ✓ Success state shown"
echo "  ✓ Click 'Continue' → wizard moves to step 2 (Photos)"
echo ""
echo "Tail backend logs in another terminal:"
echo "  docker logs fleet-backend -f | grep -iE 'counter-orchestrator|SPIn|sale|auth|MOCK'"
