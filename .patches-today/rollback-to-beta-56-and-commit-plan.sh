#!/bin/bash
# End-of-night cleanup:
#   1. Commit the round 26 plan + helper scripts to main
#   2. Push to origin (work preserved)
#   3. Print droplet rollback commands
#
# Usage: bash .patches-today/rollback-to-beta-56-and-commit-plan.sh

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement
rm -f .git/index.lock

echo "=== 1/3: Commit plan + helpers ==="
git add doc/round-26-plan-2026-05-23.md .patches-today/

git commit -m "docs(round-26): plan + tonight's helper scripts

Comprehensive round 26 plan covering:
  - What works (Sale-driven orchestrator, AutoRental schema, etc.)
  - What's not done (T&C disclaimer config, untested scenarios,
    performance fixes, pre-existing bugs)
  - Hotfix cascade chronicle for the AutoRental 2201 saga
  - Round 26 work plan ordered by phase
  - Deploy ledger + lessons learned

Also bundles all of tonight's .patches-today/ helper scripts for
posterity.

Droplet is being rolled back to v0.9.0-beta.56 manually — IRC agents
need the stable legacy flow tomorrow. Round 26 will resume from
v0.9.0-beta.70 (tag preserved on origin)."

echo ""
echo "=== 2/3: Push to origin ==="
git push origin main

echo ""
echo "=== 3/3: Droplet rollback commands ==="
cat <<'EOF'

---------------------------------------------------------------
ON THE DROPLET — run these to roll back to beta.56:
---------------------------------------------------------------

ssh root@ridefleetmanager.com

cd ~/RideFleetManagement
git fetch --tags
git checkout v0.9.0-beta.56
git log --oneline -3   # confirm HEAD is at v0.9.0-beta.56

docker compose -f docker-compose.prod.yml up -d --build --force-recreate
sleep 30
curl -fsS http://localhost:4000/health
docker compose -f docker-compose.prod.yml ps

# Then in Supabase SQL editor, confirm IRC flags are OFF
# (they should be — we flipped them earlier — but confirm):

# UPDATE "Tenant"
# SET "settingsJson" = jsonb_set(
#   jsonb_set(
#     "settingsJson",
#     '{featureFlags,interactiveTC}', '"OFF"'::jsonb, true),
#     '{featureFlags,dejavooCounter}', '"OFF"'::jsonb, true)
# WHERE id = 'cmn98hc1u0085ke0i4vefujt3';

# SELECT "settingsJson"->'featureFlags' FROM "Tenant"
# WHERE id = 'cmn98hc1u0085ke0i4vefujt3';

# Expected: {"interactiveTC":"OFF","dejavooCounter":"OFF"}

---------------------------------------------------------------

When healthy + flags OFF, you're done.
IRC agents see the legacy flow tomorrow.
Round 26 continues from v0.9.0-beta.70 (tag on origin).

Sleep well. 🛌

EOF
