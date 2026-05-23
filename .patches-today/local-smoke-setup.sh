#!/bin/bash
# Set up local smoke test environment for round 25.
# Run from your Mac terminal.
#
# What it does:
#   1. Adds SPIN_MOCK=true to backend/.env so the orchestrator skips real
#      Dejavoo HTTP calls and uses mocked successful responses.
#   2. Restarts backend container to pick up the env var.
#   3. Sets feature flags LIVE on the local-dev tenant.
#   4. Seeds a DejavooTerminal row for local-dev.
#   5. Prints next steps for the manual UI test.
#
# Usage:
#   bash .patches-today/local-smoke-setup.sh

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement

LOCAL_TENANT_ID="cmnoom8fc0000v9tkexfqa5q6"  # from seed-bootstrap output earlier

echo "=== 1. Adding SPIN_MOCK=true to backend/.env ==="
if grep -q "^SPIN_MOCK=" backend/.env 2>/dev/null; then
  echo "SPIN_MOCK already present in backend/.env (skipping)"
else
  echo "" >> backend/.env
  echo "# Round 25 local smoke testing — short-circuits Dejavoo HTTP calls" >> backend/.env
  echo "SPIN_MOCK=true" >> backend/.env
  echo "Added SPIN_MOCK=true to backend/.env"
fi

echo ""
echo "=== 2. Restarting backend container ==="
docker compose -f docker-compose.yml restart backend
sleep 6
curl -fsS http://localhost:4000/health && echo "" || (echo "Backend not healthy"; exit 1)

echo ""
echo "=== 3. Seed feature flags + Dejavoo terminal via psql ==="
docker compose exec -T db psql -U postgres -d fleet_management <<SQL
-- Set feature flags LIVE on local-dev tenant
UPDATE "Tenant"
SET "settingsJson" = jsonb_set(
  jsonb_set(
    COALESCE("settingsJson", '{}'::jsonb),
    '{featureFlags,interactiveTC}',
    '"LIVE"'::jsonb,
    true
  ),
  '{featureFlags,dejavooCounter}',
  '"LIVE"'::jsonb,
  true
)
WHERE id = '${LOCAL_TENANT_ID}';

-- Seed a DejavooTerminal row (idempotent — INSERT if not exists)
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
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, "updatedAt" = NOW();

-- Verify
SELECT id, name, "settingsJson"->'featureFlags' AS flags FROM "Tenant" WHERE id = '${LOCAL_TENANT_ID}';
SELECT id, name, tpn, status FROM "DejavooTerminal" WHERE "tenantId" = '${LOCAL_TENANT_ID}';
SQL

echo ""
echo "=== 4. Done — manual UI test next ==="
echo ""
echo "Open: http://localhost:3000"
echo "Login as one of:"
echo "  - admin@ridefleet.com / Ride1234!         (SUPER_ADMIN with local-dev tenantId)"
echo "  - superadmin@fleetbeta.local / TempPass123!  (SUPER_ADMIN with null tenantId)"
echo ""
echo "Then:"
echo "  1. Create a reservation (or use existing) for the local-dev tenant"
echo "  2. From reservation list, click 'Checkout' -> opens wizard"
echo "  3. Step 1 (Signature): you should see the NEW Dejavoo terminal UI"
echo "     (NOT the legacy SignaturePad)"
echo "  4. Click 'Start signing on terminal'"
echo "  5. Mocked response: SALE + AUTH both succeed instantly"
echo "  6. Verify in DB that DejavooTransaction rows + ReservationSigningField"
echo "     rows were persisted with the mock signature blob"
echo ""
echo "Tail backend logs in another terminal to watch:"
echo "  docker logs fleet-backend -f | grep counter-orchestrator"
